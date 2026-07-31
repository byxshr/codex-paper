#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policyPath = path.join(repoRoot, 'plugins/codex-paper/runtime/runtime-baseline.json')
const requirementsPath = path.join(repoRoot, 'plugins/codex-paper/runtime/python/requirements.lock')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const EXIT = Object.freeze({ OK: 0, POLICY: 1, CONFIG: 2, UNAVAILABLE: 3 })
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const MARKER_SCHEMA_VERSION = '1.5.0'
const SETUP_LOCK_TTL_MS = 30 * 60 * 1000
const RUNTIME_MARKER_NAME = '.codex-paper-runtime.json'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(filename) {
  return sha256(readFileSync(filename))
}

export function sha256Directory(directory) {
  const hash = createHash('sha256')
  const visit = (current, relative = '') => {
    for (const name of readdirSync(current).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc') || name.endsWith('.pyo')) continue
      if (relative === '' && name === RUNTIME_MARKER_NAME) continue
      const absolute = path.join(current, name)
      const childRelative = relative ? path.posix.join(relative, name) : name
      const info = lstatSync(absolute)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error('managed runtime contains an unsupported filesystem entry')
      }
      hash.update(`${info.isDirectory() ? 'd' : 'f'}\0${(info.mode & 0o777).toString(8)}\0${childRelative}\0`)
      if (info.isDirectory()) visit(absolute, childRelative)
      else hash.update(readFileSync(absolute))
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function run(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 1024 * 1024 })
}

function commandVersion(command, args = ['--version']) {
  if (!command) return null
  const result = run(command, args)
  if (result.status !== 0) return null
  return `${result.stdout || result.stderr}`.trim().replace(/^v/, '')
}

function runtimeRoot(env = process.env) {
  if (env.CODEX_PAPER_RUNTIME_DIR) return path.resolve(env.CODEX_PAPER_RUNTIME_DIR)
  return path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), '.cache'), 'codex-paper', 'runtime-v1')
}

export function managedPythonPath(env = process.env) {
  return path.join(runtimeRoot(env), `python-${policy.host.python}`, 'bin/python')
}

function assertNoSymlinkComponents(candidate) {
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  let cursor = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    if (!existsSync(cursor)) continue
    const info = lstatSync(cursor)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runtime path contains an unsafe parent component')
  }
}

function assertPrivateDirectory(directory, { create = false } = {}) {
  assertNoSymlinkComponents(path.dirname(directory))
  if (!existsSync(directory)) {
    if (!create) return false
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  assertNoSymlinkComponents(directory)
  const info = lstatSync(directory)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('runtime directory is owned by another user')
  if ((info.mode & 0o077) !== 0) throw new Error('runtime directory permissions must be 0700')
  return true
}

function safeManagedExecutable(python, target) {
  try {
    const info = lstatSync(python)
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) === 0) return false
    const relative = path.relative(realpathSync(target), realpathSync(python))
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch {
    return false
  }
}

function runtimeProbeEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => (
    !key.startsWith('PYTHON')
    && !key.startsWith('DYLD_')
    && key !== 'LD_LIBRARY_PATH'
    && key !== 'LD_PRELOAD'
  )))
}

function pythonFacts(python, env = process.env) {
  if (!python || !existsSync(python)) return null
  const script = [
    'import bz2, ctypes, hashlib, json, lzma, os, platform, readline, sqlite3, ssl, sys, sysconfig, uuid, zlib',
    'try:',
    ' import fitz',
    ' version = fitz.__version__',
    'except Exception:',
    ' version = None',
    'print(json.dumps({"version": platform.python_version(), "implementation": platform.python_implementation(), "pyMuPDF": version, "nativeImports": True, "executable": sys.executable, "prefix": sys.prefix, "basePrefix": sys.base_prefix, "stdlib": sysconfig.get_path("stdlib"), "osModule": os.__file__}))',
  ].join('\n')
  const result = run(python, ['-I', '-B', '-c', script], runtimeProbeEnvironment(env))
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function bootstrapFacts(command, env) {
  if (!command) return null
  const script = [
    'import bz2, ctypes, hashlib, json, lzma, platform, readline, sqlite3, ssl, sys, sysconfig, uuid, zlib',
    'print(json.dumps({"version": platform.python_version(), "implementation": platform.python_implementation(), "executable": sys.executable, "basePrefix": sys.base_prefix, "stdlib": sysconfig.get_path("stdlib")}))',
  ].join('\n')
  const result = run(command, ['-I', '-B', '-c', script], env)
  if (result.status !== 0) return null
  try {
    const facts = JSON.parse(result.stdout)
    facts.executable = realpathSync(facts.executable)
    facts.executableSha256 = sha256File(facts.executable)
    return facts
  } catch {
    return null
  }
}

function npmVersion(env = process.env) {
  return commandVersion(env.NPM_BIN || 'npm')
}

function observed(env = process.env) {
  const target = path.dirname(path.dirname(managedPythonPath(env)))
  const python = pythonFacts(managedPythonPath(env))
  let managedRuntimeContained = false
  try {
    const targetReal = realpathSync(target)
    const contained = (candidate) => {
      const relative = path.relative(targetReal, realpathSync(candidate))
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    }
    managedRuntimeContained = safeManagedExecutable(managedPythonPath(env), target)
      && contained(python.basePrefix)
      && contained(python.stdlib)
      && contained(python.osModule)
  } catch {}
  return {
    node: process.versions.node,
    npm: npmVersion(env),
    python,
    managedRuntimeContained,
  }
}

function staticMarker() {
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    policyVersion: policy.policyVersion,
    policySha256: sha256(readFileSync(policyPath)),
    requirementsSha256: sha256(readFileSync(requirementsPath)),
    python: policy.host.python,
    pyMuPDF: policy.host.pyMuPDF,
  }
}

function markerPath(env = process.env) {
  return path.join(runtimeRoot(env), `python-${policy.host.python}`, RUNTIME_MARKER_NAME)
}

function markerMatches(env = process.env) {
  try {
    const marker = JSON.parse(readFileSync(markerPath(env), 'utf8'))
    const expected = staticMarker()
    return Object.entries(expected).every(([key, value]) => marker[key] === value)
      && /^[a-f0-9]{64}$/.test(marker.bootstrap?.executableSha256 || '')
      && /^[a-f0-9]{64}$/.test(marker.managedExecutableSha256 || '')
      && /^[a-f0-9]{64}$/.test(marker.managedStdlibSha256 || '')
      && /^[a-f0-9]{64}$/.test(marker.managedTreeSha256 || '')
      && marker.managedExecutableSha256 === sha256File(managedPythonPath(env))
      && marker.managedStdlibSha256 === sha256Directory(path.join(path.dirname(path.dirname(managedPythonPath(env))), 'lib', `python${policy.host.python.split('.').slice(0, 2).join('.')}`))
      && marker.managedTreeSha256 === sha256Directory(path.dirname(path.dirname(managedPythonPath(env))))
  } catch {
    return false
  }
}

export function runtimeStatus(env = process.env) {
  const facts = observed(env)
  const checks = {
    platform: SUPPORTED_PLATFORMS.has(process.platform),
    node: facts.node === policy.host.node,
    npm: facts.npm === policy.host.npm,
    python: facts.python?.version === policy.host.python
      && facts.python?.implementation === policy.host.pythonImplementation
      && facts.python?.pyMuPDF === policy.host.pyMuPDF,
    nativeRuntimeSelfContained: facts.python?.nativeImports === true,
    managedRuntimeContained: facts.managedRuntimeContained,
    marker: markerMatches(env),
  }
  const publicObserved = {
    node: facts.node,
    npm: facts.npm,
    python: facts.python
      ? {
          version: facts.python.version,
          implementation: facts.python.implementation,
          pyMuPDF: facts.python.pyMuPDF,
        }
      : null,
  }
  return {
    status: Object.values(checks).every(Boolean) ? 'conformant' : 'nonconformant',
    policyVersion: policy.policyVersion,
    policySha256: sha256(readFileSync(policyPath)),
    baseline: policy,
    observed: publicObserved,
    checks,
  }
}

function ephemeralRoots() {
  const candidates = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', os.tmpdir()]
    .filter((candidate) => existsSync(candidate))
  return [...new Set(candidates.flatMap((candidate) => [candidate, realpathSync(candidate)]))]
}

function isTemporaryBootstrap(executable) {
  return ephemeralRoots().some((root) => {
    const relative = path.relative(root, executable)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  })
}

function assertBootstrapSource(facts, explicitlyApproved) {
  if (isTemporaryBootstrap(facts.executable) && !explicitlyApproved) throw new Error('temporary bootstrap Python requires explicit approval')
  const prefix = realpathSync(facts.basePrefix)
  const stdlib = realpathSync(facts.stdlib)
  const relative = path.relative(prefix, stdlib)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('bootstrap standard library is outside its prefix')
  for (const candidate of [prefix, stdlib]) {
    const info = lstatSync(candidate)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('bootstrap runtime source is unsafe')
    if (typeof process.getuid === 'function' && ![0, process.getuid()].includes(info.uid)) throw new Error('bootstrap runtime source has an unexpected owner')
    if ((info.mode & 0o022) !== 0) throw new Error('bootstrap runtime source is group- or world-writable')
  }
}

function findBootstrapPython(env = process.env) {
  const explicit = env.CODEX_PAPER_BOOTSTRAP_PYTHON
  const candidates = [explicit, env.PYTHON_BIN, 'python3.11', 'python3'].filter(Boolean)
  for (const candidate of candidates) {
    const facts = bootstrapFacts(candidate, env)
    if (facts?.version !== policy.host.python || facts?.implementation !== policy.host.pythonImplementation) continue
    if (isTemporaryBootstrap(facts.executable) && candidate !== explicit) continue
    const explicitlyApproved = candidate === explicit
    try {
      assertBootstrapSource(facts, explicitlyApproved)
      return { command: candidate, facts, explicitlyApproved }
    } catch (error) {
      if (explicitlyApproved) throw error
    }
  }
  return null
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

export function acquireSetupLock(root) {
  const lock = path.join(root, '.runtime-setup.lock')
  const token = randomBytes(32).toString('hex')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
        schemaVersion: '1.0.0',
        token,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        acquiredAtMs: Date.now(),
      })}\n`, { mode: 0o600, flag: 'wx' })
      return () => {
        try {
          const owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'))
          if (owner.token === token) rmSync(lock, { recursive: true })
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try {
        const info = lstatSync(lock)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runtime setup lock is unsafe')
        owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'))
      } catch {
        const lockError = new Error('runtime setup lock is unsafe or damaged; after confirming no setup is running, remove <runtime>/.runtime-setup.lock')
        lockError.exitCode = EXIT.UNAVAILABLE
        throw lockError
      }
      const expired = Number.isFinite(owner.acquiredAtMs) && Date.now() - owner.acquiredAtMs > SETUP_LOCK_TTL_MS
      if ((owner.hostname === os.hostname() && !processAlive(owner.pid)) || expired) {
        rmSync(lock, { recursive: true })
        continue
      }
      const lockError = new Error('runtime setup is already in progress; a lock older than 30 minutes is reclaimed automatically')
      lockError.exitCode = EXIT.UNAVAILABLE
      throw lockError
    }
  }
  const lockError = new Error('unable to acquire runtime setup lock')
  lockError.exitCode = EXIT.UNAVAILABLE
  throw lockError
}

function removeInstallerArtifacts(temporary) {
  const bin = path.join(temporary, 'bin')
  for (const name of readdirSync(bin)) {
    if (/^(?:pip(?:3(?:\.11)?)?|pymupdf|activate(?:\..*)?|Activate\.ps1)$/.test(name)) {
      rmSync(path.join(bin, name), { force: true })
    }
  }
  const sitePackages = path.join(temporary, 'lib', `python${policy.host.python.split('.').slice(0, 2).join('.')}`, 'site-packages')
  for (const name of readdirSync(sitePackages)) {
    if (/^(?:pip|setuptools|wheel|pkg_resources)(?:$|[-.])/.test(name)) {
      rmSync(path.join(sitePackages, name), { recursive: true, force: true })
    }
  }
}

export function normalizeManagedVenvAliases(temporary) {
  const alias = path.join(temporary, 'lib64')
  if (!existsSync(alias)) return
  const info = lstatSync(alias)
  const library = path.join(temporary, 'lib')
  if (!info.isSymbolicLink()
    || !existsSync(library)
    || realpathSync(alias) !== realpathSync(library)) {
    throw new Error('managed Python venv contains an unsafe lib64 entry')
  }
  rmSync(alias)
}

function copyDereferencedTree(source, target, activeDirectories = new Set()) {
  const resolved = realpathSync(source)
  const info = lstatSync(resolved)
  if (info.isFile()) {
    cpSync(resolved, target, { force: true })
    chmodSync(target, info.mode & 0o777)
    return
  }
  if (!info.isDirectory() || activeDirectories.has(resolved)) {
    throw new Error('bootstrap runtime contains an unsupported or cyclic filesystem entry')
  }
  activeDirectories.add(resolved)
  mkdirSync(target, { recursive: true, mode: info.mode & 0o777 })
  chmodSync(target, info.mode & 0o777)
  for (const name of readdirSync(resolved)) {
    copyDereferencedTree(path.join(resolved, name), path.join(target, name), activeDirectories)
  }
  activeDirectories.delete(resolved)
}

function isSharedLibraryName(name) {
  return /^lib.+(?:\.dylib|\.so(?:\.\d+)*)$/.test(name)
}

function isNativeBinaryName(name) {
  return name.endsWith('.dylib') || /\.so(?:\.\d+)*$/.test(name)
}

function nativeCandidates(root) {
  const files = []
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      if (name === '__pycache__') continue
      const absolute = path.join(current, name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error('managed runtime contains an unsupported filesystem entry')
      }
      if (info.isDirectory()) visit(absolute)
      else if (isNativeBinaryName(name) || absolute.startsWith(`${path.join(root, 'bin')}${path.sep}`)) files.push(absolute)
    }
  }
  visit(root)
  return files
}

function bootstrapPrefixes(bootstrap) {
  return [...new Set([
    bootstrap.facts.basePrefix,
    realpathSync(bootstrap.facts.basePrefix),
  ].filter(Boolean))]
}

function insideAnyPrefix(candidate, prefixes) {
  return prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}${path.sep}`))
}

function macRpaths(filename, env) {
  const commands = run('otool', ['-l', filename], env)
  if (commands.status !== 0) throw new Error('failed to inspect managed runtime Mach-O load commands')
  const lines = String(commands.stdout).split('\n')
  const rpaths = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      const match = lines[cursor].trim().match(/^path (.+) \(offset \d+\)$/)
      if (match) {
        rpaths.push(match[1])
        break
      }
    }
  }
  return rpaths
}

function rewriteMacNativeReferences(root, bootstrap, env) {
  const prefixes = bootstrapPrefixes(bootstrap)
  for (const filename of nativeCandidates(root)) {
    const dependencies = run('otool', ['-L', filename], env)
    if (dependencies.status !== 0) continue
    let modified = false
    for (const line of String(dependencies.stdout).split('\n').slice(1)) {
      const dependency = line.trim().split(' (')[0]
      if (!insideAnyPrefix(dependency, prefixes)) continue
      const target = path.join(root, 'lib', path.basename(dependency))
      if (!existsSync(target)) throw new Error('bootstrap native dependency was not copied into the managed runtime')
      const relative = path.relative(path.dirname(filename), target).split(path.sep).join('/')
      const replacement = `@loader_path/${relative}`
      const changed = run('install_name_tool', ['-change', dependency, replacement, filename], env)
      if (changed.status !== 0) throw new Error('failed to relocate a managed runtime native dependency')
      modified = true
    }
    const identifier = run('otool', ['-D', filename], env)
    const dylibId = identifier.status === 0 ? String(identifier.stdout).split('\n')[1]?.trim() : null
    if (dylibId && insideAnyPrefix(dylibId, prefixes)) {
      const changed = run('install_name_tool', ['-id', `@rpath/${path.basename(filename)}`, filename], env)
      if (changed.status !== 0) throw new Error('failed to relocate a managed runtime library identifier')
      modified = true
    }
    for (const rpath of macRpaths(filename, env)) {
      if (!insideAnyPrefix(rpath, prefixes)) continue
      const prefix = prefixes.find((candidate) => insideAnyPrefix(rpath, [candidate]))
      const target = path.join(root, path.relative(prefix, rpath))
      if (!existsSync(target)) throw new Error('bootstrap native rpath target was not copied into the managed runtime')
      const relative = path.relative(path.dirname(filename), target).split(path.sep).join('/')
      const replacement = relative ? `@loader_path/${relative}` : '@loader_path'
      const changed = run('install_name_tool', ['-rpath', rpath, replacement, filename], env)
      if (changed.status !== 0) throw new Error('failed to relocate a managed runtime native rpath')
      modified = true
    }
    if (modified) {
      const signed = run('codesign', ['--force', '--sign', '-', filename], env)
      if (signed.error?.code !== 'ENOENT' && signed.status !== 0) throw new Error('failed to re-sign a relocated managed runtime library')
    }
  }
}

function replaceNullTerminatedNativeString(filename, before, after) {
  const source = Buffer.from(before)
  const replacement = Buffer.from(after)
  if (replacement.length > source.length) {
    throw new Error('relocated native reference exceeds the available ELF string-table entry')
  }
  const content = readFileSync(filename)
  const needle = Buffer.concat([source, Buffer.from([0])])
  let cursor = 0
  let replacements = 0
  while ((cursor = content.indexOf(needle, cursor)) !== -1) {
    content.fill(0, cursor, cursor + needle.length)
    replacement.copy(content, cursor)
    cursor += needle.length
    replacements += 1
  }
  if (replacements === 0) throw new Error('ELF dynamic reference could not be located for relocation')
  writeFileSync(filename, content)
}

function linuxLoaderRelativePath(root, filename, absolute, prefixes) {
  const prefix = prefixes.find((candidate) => insideAnyPrefix(absolute, [candidate]))
  if (!prefix) return absolute
  const target = path.join(root, path.relative(prefix, absolute))
  if (!existsSync(target)) throw new Error('bootstrap native dependency was not copied into the managed runtime')
  const relative = path.relative(path.dirname(filename), target).split(path.sep).join('/')
  return relative ? `$ORIGIN/${relative}` : '$ORIGIN'
}

export function relocateLinuxSearchPath(root, filename, searchPath, prefixes) {
  return searchPath
    .split(':')
    .map((entry) => path.isAbsolute(entry)
      ? linuxLoaderRelativePath(root, filename, entry, prefixes)
      : entry)
    .join(':')
}

function linuxDynamicEntries(filename, env) {
  const result = run('readelf', ['-d', filename], env)
  if (result.status !== 0) return []
  const entries = []
  for (const line of String(result.stdout).split('\n')) {
    const match = line.match(/\((RPATH|RUNPATH|NEEDED)\).*\[([^\]]*)\]/)
    if (match) entries.push({ kind: match[1], value: match[2] })
  }
  return entries
}

export function rewriteLinuxNativeReferences(root, bootstrap, env) {
  const prefixes = bootstrapPrefixes(bootstrap)
  for (const filename of nativeCandidates(root)) {
    for (const entry of linuxDynamicEntries(filename, env)) {
      let replacement = entry.value
      if (entry.kind === 'RPATH' || entry.kind === 'RUNPATH') {
        replacement = relocateLinuxSearchPath(root, filename, entry.value, prefixes)
      } else if (path.isAbsolute(entry.value)) {
        replacement = linuxLoaderRelativePath(root, filename, entry.value, prefixes)
      }
      if (replacement !== entry.value) {
        replaceNullTerminatedNativeString(filename, entry.value, replacement)
      }
    }
  }
}

function verifyNativeReferences(root, bootstrap, env) {
  const prefixes = bootstrapPrefixes(bootstrap)
  const tool = process.platform === 'darwin' ? 'otool' : 'readelf'
  const probe = run(tool, process.platform === 'darwin' ? ['-L', process.execPath] : ['-d', process.execPath], env)
  if (probe.error?.code === 'ENOENT') throw new Error(`${tool} is required to verify native runtime relocation`)
  for (const filename of nativeCandidates(root)) {
    const result = run(tool, process.platform === 'darwin' ? ['-L', filename] : ['-d', filename], env)
    if (result.status !== 0) continue
    const nativeMetadata = process.platform === 'darwin'
      ? `${result.stdout}\n${macRpaths(filename, env).join('\n')}`
      : String(result.stdout)
    if (prefixes.some((prefix) => nativeMetadata.includes(prefix))) {
      throw new Error('managed runtime retains an absolute native dependency on its bootstrap')
    }
  }
}

function copySelfContainedRuntime(bootstrap, temporary, env) {
  const versionDirectory = `python${policy.host.python.split('.').slice(0, 2).join('.')}`
  const sourcePrefix = realpathSync(bootstrap.facts.basePrefix)
  const sourceLib = path.join(sourcePrefix, 'lib')
  const sourceStdlib = realpathSync(bootstrap.facts.stdlib)
  const targetLib = path.join(temporary, 'lib')
  const targetStdlib = path.join(targetLib, versionDirectory)
  for (const name of readdirSync(sourceLib)) {
    if (!isSharedLibraryName(name)) continue
    copyDereferencedTree(path.join(sourceLib, name), path.join(targetLib, name))
  }
  for (const name of readdirSync(sourceStdlib)) {
    if (['site-packages', 'ensurepip', '__pycache__'].includes(name)) continue
    copyDereferencedTree(path.join(sourceStdlib, name), path.join(targetStdlib, name))
  }
  if (process.platform === 'darwin') rewriteMacNativeReferences(temporary, bootstrap, env)
  if (process.platform === 'linux') rewriteLinuxNativeReferences(temporary, bootstrap, env)
  verifyNativeReferences(temporary, bootstrap, env)
}

function writeRelocatedVenvConfig(temporary, target) {
  writeFileSync(path.join(temporary, 'pyvenv.cfg'), [
    `home = ${path.join(target, 'bin')}`,
    'include-system-site-packages = false',
    `version = ${policy.host.python}`,
    `executable = ${path.join(target, 'bin', `python${policy.host.python.split('.').slice(0, 2).join('.')}`)}`,
    '',
  ].join('\n'), { mode: 0o600 })
}

export function sanitizeDiagnostic(value, env = process.env) {
  let output = String(value || '')
  const replacements = [
    [runtimeRoot(env), '<runtime>'],
    [os.homedir(), '~'],
    ...ephemeralRoots().map((root) => [root, '<temporary>']),
    [realpathSync(os.tmpdir()), '<temporary>'],
    [os.tmpdir(), '<temporary>'],
  ].sort((a, b) => b[0].length - a[0].length)
  for (const [prefix, replacement] of replacements) {
    if (prefix) output = output.split(prefix).join(replacement)
  }
  output = output.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
  return output.trim().slice(0, 1200)
}

function recoverInterruptedPublish(target) {
  const backup = `${target}.previous`
  if (!existsSync(backup)) return
  const info = lstatSync(backup)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('managed Python backup is unsafe')
  if (!existsSync(target)) renameSync(backup, target)
  else rmSync(backup, { recursive: true })
}

export function publishPreparedRuntime(temporary, target, { verify } = {}) {
  const backup = `${target}.previous`
  if (existsSync(backup)) throw new Error('managed Python backup must be recovered before publication')
  const hadTarget = existsSync(target)
  if (hadTarget) renameSync(target, backup)
  try {
    renameSync(temporary, target)
    if (verify) verify()
  } catch (error) {
    if (existsSync(target)) rmSync(target, { recursive: true })
    if (hadTarget && existsSync(backup) && !existsSync(target)) renameSync(backup, target)
    throw error
  }
  if (hadTarget) rmSync(backup, { recursive: true })
}

export function setupRuntime(env = process.env) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    const error = new Error('managed runtime setup supports macOS and Linux only')
    error.exitCode = EXIT.UNAVAILABLE
    throw error
  }
  if (process.versions.node !== policy.host.node || npmVersion(env) !== policy.host.npm) {
    const error = new Error(`Node ${policy.host.node} and npm ${policy.host.npm} are required`)
    error.exitCode = EXIT.UNAVAILABLE
    throw error
  }
  const current = runtimeStatus(env)
  if (current.status === 'conformant') return current
  const bootstrap = findBootstrapPython(env)
  if (!bootstrap) {
    const error = new Error(`CPython ${policy.host.python} is required; set CODEX_PAPER_BOOTSTRAP_PYTHON to a stable executable (temporary paths require explicit approval)`)
    error.exitCode = EXIT.UNAVAILABLE
    throw error
  }
  const root = runtimeRoot(env)
  assertPrivateDirectory(root, { create: true })
  let releaseLock
  let temporary
  try {
    releaseLock = acquireSetupLock(root)
    const target = path.join(root, `python-${policy.host.python}`)
    recoverInterruptedPublish(target)
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(path.dirname(target)) !== realpathSync(root)) {
        const error = new Error('existing managed Python runtime is unsafe')
        error.exitCode = EXIT.CONFIG
        throw error
      }
    }
    temporary = mkdtempSync(path.join(root, '.python-init-'))
    let result = run(bootstrap.command, ['-I', '-B', '-m', 'venv', '--copies', temporary], env)
    if (result.status !== 0) throw new Error(`failed to create the managed Python virtual environment: ${sanitizeDiagnostic(result.stderr, env)}`)
    const python = path.join(temporary, 'bin/python')
    if (!safeManagedExecutable(python, temporary)) throw new Error('managed Python executable is not an ordinary contained file')
    result = run(python, [
      '-I', '-B', '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-deps',
      '--only-binary=:all:',
      '--require-hashes',
      '--requirement', requirementsPath,
    ], env)
    if (result.status !== 0) throw new Error(`failed to install hash-locked Python dependencies: ${sanitizeDiagnostic(result.stderr, env)}`)
    removeInstallerArtifacts(temporary)
    normalizeManagedVenvAliases(temporary)
    copySelfContainedRuntime(bootstrap, temporary, env)
    writeRelocatedVenvConfig(temporary, temporary)
    const installed = pythonFacts(python, env)
    if (installed?.version !== policy.host.python
      || installed?.implementation !== policy.host.pythonImplementation
      || installed?.pyMuPDF !== policy.host.pyMuPDF) {
      throw new Error('managed Python runtime failed post-install verification')
    }
    writeRelocatedVenvConfig(temporary, target)
    const stdlib = path.join(temporary, 'lib', `python${policy.host.python.split('.').slice(0, 2).join('.')}`)
    const marker = {
      ...staticMarker(),
      bootstrap: {
        version: bootstrap.facts.version,
        implementation: bootstrap.facts.implementation,
        executableSha256: bootstrap.facts.executableSha256,
        temporaryPathExplicitlyApproved: bootstrap.explicitlyApproved && isTemporaryBootstrap(bootstrap.facts.executable),
      },
      managedExecutableSha256: sha256File(python),
      managedStdlibSha256: sha256Directory(stdlib),
      managedTreeSha256: sha256Directory(temporary),
    }
    writeFileSync(path.join(temporary, RUNTIME_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
    let publishedStatus
    publishPreparedRuntime(temporary, target, {
      verify: () => {
        publishedStatus = runtimeStatus(env)
        if (publishedStatus.status !== 'conformant') throw new Error('published managed runtime failed containment verification')
      },
    })
    temporary = null
    return publishedStatus
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    error.exitCode ||= EXIT.UNAVAILABLE
    throw error
  } finally {
    if (releaseLock) releaseLock()
  }
}

function printStatus(status, json) {
  if (json) {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  console.log(`Runtime: ${status.status}`)
  console.log(`Policy: ${status.policyVersion} (${status.policySha256})`)
  console.log(`Node: ${status.observed.node || 'unavailable'} (expected ${policy.host.node})`)
  console.log(`npm: ${status.observed.npm || 'unavailable'} (expected ${policy.host.npm})`)
  console.log(`Python: ${status.observed.python?.version || 'unavailable'} (expected ${policy.host.python})`)
  console.log(`PyMuPDF: ${status.observed.python?.pyMuPDF || 'unavailable'} (expected ${policy.host.pyMuPDF})`)
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2)
  const json = args.includes('--json')
  if (args.some((arg) => arg !== '--json') || !['status', 'setup'].includes(command)) process.exit(EXIT.CONFIG)
  try {
    const result = command === 'setup' ? setupRuntime(process.env) : runtimeStatus(process.env)
    printStatus(result, json)
    process.exit(result.status === 'conformant' ? EXIT.OK : EXIT.UNAVAILABLE)
  } catch (error) {
    const message = sanitizeDiagnostic(error.message, process.env)
    if (json) console.log(JSON.stringify({ status: 'nonconformant', error: message }))
    else console.error(`Runtime error: ${message}`)
    process.exit(error.exitCode || EXIT.CONFIG)
  }
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
