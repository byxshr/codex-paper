#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(SCRIPT_PATH)
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const SANDBOX_ROOT = path.join(PLUGIN_ROOT, 'sandbox')
const POLICY_PATH = path.join(SANDBOX_ROOT, 'policy.json')
const DOCKERFILE_PATH = path.join(SANDBOX_ROOT, 'Dockerfile')
const ENTRYPOINT_PATH = path.join(SANDBOX_ROOT, 'entrypoint.py')
const POLICY = Object.freeze(JSON.parse(readFileSync(POLICY_PATH, 'utf8')))
const EXIT = Object.freeze({ OK: 0, POLICY: 2, UNAVAILABLE: 3, EXECUTION: 4 })
const RUNTIME_BY_EXTENSION = Object.freeze({ '.py': 'python', '.js': 'node', '.mjs': 'node' })
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class SandboxError extends Error {
  constructor(message, exitCode = EXIT.POLICY, code = 'sandbox_policy_error') {
    super(message)
    this.name = 'SandboxError'
    this.exitCode = exitCode
    this.code = code
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
}

export function sandboxPolicyFingerprint() {
  return sha256Buffer([
    readFileSync(POLICY_PATH),
    readFileSync(DOCKERFILE_PATH),
    readFileSync(ENTRYPOINT_PATH),
  ].map((item) => sha256Buffer(item)).join(':'))
}

function dockerBin(env = process.env) {
  return env.CODEX_PAPER_DOCKER_BIN || 'docker'
}

function stateRoot(env = process.env) {
  if (env.CODEX_PAPER_SANDBOX_STATE_DIR) return path.resolve(env.CODEX_PAPER_SANDBOX_STATE_DIR)
  return path.join(os.homedir(), '.cache', 'codex-paper', 'sandbox')
}

function approvalRoot(env = process.env) {
  if (env.CODEX_PAPER_SANDBOX_APPROVAL_DIR) return path.resolve(env.CODEX_PAPER_SANDBOX_APPROVAL_DIR)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
  return path.join(os.tmpdir(), `codex-paper-sandbox-${uid}`, 'approvals')
}

function assertSafeDirectory(directory, { create = false } = {}) {
  if (!existsSync(directory)) {
    if (!create) return false
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SandboxError(`Unsafe sandbox state directory: ${directory}`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new SandboxError(`Sandbox state directory is not owned by the current user: ${directory}`)
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SandboxError(`Sandbox state directory permissions must be 0700: ${directory}`)
  }
  return true
}

function writePrivateJson(filePath, value) {
  assertSafeDirectory(path.dirname(filePath), { create: true })
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)
  const fd = openSync(temporary, flags, 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, filePath)
}

function readPrivateJson(filePath) {
  if (!existsSync(filePath)) return null
  const info = lstatSync(filePath)
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) return null
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

function normalizedDockerVersion(raw) {
  return {
    client: raw?.Client?.Version || null,
    server: raw?.Server?.Version || null,
    os: raw?.Server?.Os || null,
    arch: raw?.Server?.Arch || null,
  }
}

export function inspectDocker({ env = process.env } = {}) {
  if (!['darwin', 'linux'].includes(process.platform) && !env.CODEX_PAPER_ALLOW_TEST_PLATFORM) {
    return { ok: false, reason: `unsupported platform: ${process.platform}` }
  }
  const result = runSync(dockerBin(env), ['version', '--format', '{{json .}}'], { env })
  if (result.error?.code === 'ENOENT') return { ok: false, reason: 'docker CLI is not installed' }
  if (result.status !== 0) {
    return { ok: false, reason: `docker daemon is unavailable${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}` }
  }
  try {
    const version = normalizedDockerVersion(JSON.parse(result.stdout))
    if (!version.server) return { ok: false, reason: 'docker server version is unavailable' }
    return { ok: true, version }
  } catch {
    return { ok: false, reason: 'docker returned an invalid version response' }
  }
}

export function inspectSandboxImage({ env = process.env } = {}) {
  const result = runSync(dockerBin(env), ['image', 'inspect', POLICY.imageTag, '--format', '{{json .}}'], { env })
  if (result.status !== 0) return { ok: false, reason: `sandbox image ${POLICY.imageTag} is missing` }
  try {
    const image = JSON.parse(result.stdout)
    const labels = image?.Config?.Labels || {}
    const fingerprint = sandboxPolicyFingerprint()
    const expected = {
      'io.codex-paper.sandbox.policy': POLICY.policyVersion,
      'io.codex-paper.sandbox.conformance': POLICY.conformanceVersion,
      'io.codex-paper.sandbox.policy-hash': fingerprint,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (labels[key] !== value) return { ok: false, reason: `sandbox image label ${key} does not match policy` }
    }
    if (!image.Id) return { ok: false, reason: 'sandbox image ID is missing' }
    return { ok: true, imageId: image.Id, labels }
  } catch {
    return { ok: false, reason: 'docker returned invalid image metadata' }
  }
}

function conformanceStampPath(env = process.env) {
  return path.join(stateRoot(env), 'conformance.json')
}

function expectedStamp(docker, image) {
  return {
    conformanceVersion: POLICY.conformanceVersion,
    policyHash: sandboxPolicyFingerprint(),
    imageId: image.imageId,
    docker: docker.version,
    platform: `${process.platform}/${process.arch}`,
  }
}

export function getSandboxCapability({ env = process.env, requireStamp = true } = {}) {
  const docker = inspectDocker({ env })
  if (!docker.ok) return { status: 'unavailable', reason: docker.reason, policyVersion: POLICY.policyVersion }
  const image = inspectSandboxImage({ env })
  if (!image.ok) return { status: 'unavailable', reason: image.reason, policyVersion: POLICY.policyVersion, docker: docker.version }
  const base = { policyVersion: POLICY.policyVersion, policyHash: sandboxPolicyFingerprint(), docker: docker.version, imageId: image.imageId }
  if (!requireStamp) return { status: 'ready', ...base }
  try {
    if (!assertSafeDirectory(stateRoot(env))) {
      return { status: 'nonconformant', reason: 'sandbox conformance state is missing', ...base }
    }
  } catch (error) {
    return { status: 'nonconformant', reason: error.message, ...base }
  }
  const stamp = readPrivateJson(conformanceStampPath(env))
  const expected = expectedStamp(docker, image)
  if (!stamp || stableJson(Object.fromEntries(Object.keys(expected).map((key) => [key, stamp[key]]))) !== stableJson(expected)) {
    return { status: 'nonconformant', reason: 'sandbox conformance has not passed for the current engine, image, and policy', ...base }
  }
  return { status: 'ready', ...base, conformanceAt: stamp.passedAt }
}

function resolvePaperDir(input, env = process.env) {
  if (!input || input.includes('\0')) throw new SandboxError('Missing or invalid paper directory or slug.')
  const expanded = input.replace(/^~(?=$|\/)/, os.homedir())
  const direct = path.resolve(expanded)
  const candidate = existsSync(direct)
    ? direct
    : path.join(env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'), 'papers', input)
  if (!existsSync(candidate)) throw new SandboxError(`Paper directory not found: ${input}`)
  const lexical = lstatSync(candidate)
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new SandboxError('Paper path must be a real directory, not a symlink.')
  const paperDir = realpathSync(candidate)
  if (/[:,\r\n]/.test(paperDir)) throw new SandboxError('Paper path contains characters unsupported by the Docker mount boundary.')
  return paperDir
}

function scanCodeTree(paperDir) {
  const codeDir = path.join(paperDir, 'code')
  if (!existsSync(codeDir)) throw new SandboxError('Missing required code/ directory.')
  const codeInfo = lstatSync(codeDir)
  if (codeInfo.isSymbolicLink() || !codeInfo.isDirectory()) throw new SandboxError('code/ must be a real directory, not a symlink.')
  const realCodeDir = realpathSync(codeDir)
  if (path.dirname(realCodeDir) !== paperDir) throw new SandboxError('code/ resolves outside the paper directory.')

  const files = []
  const walk = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name)
      const absolutePath = path.join(directory, entry.name)
      const info = lstatSync(absolutePath)
      if (info.isSymbolicLink()) throw new SandboxError(`code/${relativePath} must not be a symlink.`)
      if (entry.isDirectory()) {
        walk(absolutePath, path.join(relativeDirectory, entry.name))
      } else if (entry.isFile()) {
        if (files.length >= POLICY.limits.maxFiles) throw new SandboxError(`code/ exceeds the ${POLICY.limits.maxFiles}-file limit.`)
        if (info.size > POLICY.limits.maxSourceFileBytes) throw new SandboxError(`code/${relativePath} exceeds the per-file source limit.`)
        files.push({ relativePath, size: info.size, sha256: sha256File(absolutePath) })
      } else {
        throw new SandboxError(`code/${relativePath} has a forbidden non-regular file type.`)
      }
    }
  }
  walk(realCodeDir)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > POLICY.limits.maxSourceTotalBytes) throw new SandboxError('code/ exceeds the total source-size limit.')

  const artifacts = files
    .filter((file) => !file.relativePath.includes('/') && !file.relativePath.startsWith('.'))
    .filter((file) => POLICY.allowedExtensions.includes(path.extname(file.relativePath).toLowerCase()))
    .map((file) => {
      if (!SAFE_ARTIFACT_NAME.test(file.relativePath)) throw new SandboxError(`Unsafe runnable artifact name: code/${file.relativePath}`)
      const extension = path.extname(file.relativePath).toLowerCase()
      const runtime = RUNTIME_BY_EXTENSION[extension]
      const argv = runtime === 'python'
        ? ['python3', '-I', '-B', `/workspace/${file.relativePath}`]
        : ['node', '--disable-proto=delete', '--no-addons', `/workspace/${file.relativePath}`]
      return { relativePath: `code/${file.relativePath}`, filename: file.relativePath, sha256: file.sha256, runtime, argv }
    })
  if (artifacts.length === 0) throw new SandboxError('No runnable top-level Python or JavaScript demo was found in code/.')
  return { codeDir: realCodeDir, files, artifacts, totalBytes }
}

function planBinding(plan, capability) {
  return sha256Buffer(stableJson({
    paperDir: plan.paperDir,
    codeDir: plan.codeDir,
    files: plan.files,
    artifacts: plan.artifacts,
    limits: plan.limits,
    boundary: plan.boundary,
    consent: plan.consent,
    policyVersion: plan.policyVersion,
    policyHash: capability.policyHash,
    imageId: capability.imageId,
  }))
}

function createApproval(plan, capability, env = process.env) {
  const token = randomBytes(32).toString('hex')
  const root = approvalRoot(env)
  assertSafeDirectory(root, { create: true })
  sweepExpiredApprovals(root)
  const expiresAt = new Date(Date.now() + POLICY.approvalTtlMs).toISOString()
  const approval = {
    approvalVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    expiresAt,
    paperDir: plan.paperDir,
    binding: planBinding(plan, capability),
  }
  const approvalPath = path.join(root, `${token}.json`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)
  const fd = openSync(approvalPath, flags, 0o600)
  try {
    writeSync(fd, `${JSON.stringify(approval)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { token, expiresAt }
}

function sweepExpiredApprovals(root, now = Date.now()) {
  const tokenFile = /^[a-f0-9]{64}\.json$/
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !tokenFile.test(entry.name)) continue
    const candidate = path.join(root, entry.name)
    try {
      const info = lstatSync(candidate)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) continue
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) continue
      const approval = JSON.parse(readFileSync(candidate, 'utf8'))
      const expiresAt = Date.parse(approval?.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) unlinkSync(candidate)
    } catch {
      // A concurrently claimed token or an unsafe entry is left untouched.
    }
  }
}

export function buildExecutionPlan(input, { env = process.env, issueApproval = true } = {}) {
  const paperDir = resolvePaperDir(input, env)
  const scan = scanCodeTree(paperDir)
  const capability = getSandboxCapability({ env })
  const plan = {
    executionPlanVersion: POLICY.executionPlanVersion,
    policyVersion: POLICY.policyVersion,
    paperDir,
    codeDir: scan.codeDir,
    files: scan.files,
    artifacts: scan.artifacts,
    limits: POLICY.limits,
    boundary: {
      backend: 'docker',
      network: 'none',
      source: '/workspace:read-only',
      writable: ['/tmp'],
      home: '/tmp/home',
      credentials: 'not inherited',
      user: '65532:65532',
    },
    consent: {
      enforcement: 'workflow',
      humanIdentityAuthenticated: false,
      requirement: 'explicit user approval after reviewing this exact plan',
    },
    capability,
    approval: null,
  }
  if (issueApproval && capability.status === 'ready') plan.approval = createApproval(plan, capability, env)
  return plan
}

function claimApproval(token, env = process.env) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new SandboxError('Approval token must be 64 lowercase hexadecimal characters.')
  const root = approvalRoot(env)
  if (!assertSafeDirectory(root)) throw new SandboxError('Approval token is invalid or has already been used.')
  const source = path.join(root, `${token}.json`)
  const claimed = path.join(root, `.${token}.${randomBytes(12).toString('hex')}.claimed`)
  try {
    renameSync(source, claimed)
  } catch {
    throw new SandboxError('Approval token is invalid or has already been used.')
  }
  let approval
  try {
    const info = lstatSync(claimed)
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error('unsafe approval file')
    approval = JSON.parse(readFileSync(claimed, 'utf8'))
  } catch {
    throw new SandboxError('Approval token is corrupt or unsafe.')
  } finally {
    rmSync(claimed, { force: true })
  }
  if (!approval.expiresAt || Date.parse(approval.expiresAt) <= Date.now()) throw new SandboxError('Approval token has expired.')
  return approval
}

export function dockerCreateArgs({ containerName, codeDir, artifact, imageTag = POLICY.imageTag }) {
  const limits = POLICY.limits
  return [
    'create', '--name', containerName,
    '--label', 'io.codex-paper.sandbox.execution=true',
    '--init', '--network', 'none', '--ipc', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(limits.pids),
    '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes), '--cpus', '1',
    '--ulimit', `cpu=${limits.cpuSeconds}:${limits.cpuSeconds}`,
    '--ulimit', `fsize=${limits.fileBytes}:${limits.fileBytes}`,
    '--ulimit', `nofile=${limits.openFiles}:${limits.openFiles}`,
    '--ulimit', `nproc=${limits.pids}:${limits.pids}`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpBytes},mode=1777`,
    '--mount', `type=bind,source=${codeDir},target=/workspace,readonly`,
    '--workdir', '/workspace', '--user', '65532:65532',
    '--env', 'HOME=/tmp/home', '--env', 'LANG=C.UTF-8', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    imageTag, artifact.runtime, artifact.filename,
  ]
}

export function normalizeResourceUsage(value, expectedExitCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const numericFields = ['wallTimeMs', 'userCpuMs', 'systemCpuMs', 'maxRssKiB']
  if (numericFields.some((field) => !Number.isFinite(value[field]) || value[field] < 0)) return null
  if (!Number.isInteger(value.status) || value.status < -255 || value.status > 255) return null
  const normalizedStatus = value.status < 0 ? 128 + Math.abs(value.status) : value.status
  if (Number.isInteger(expectedExitCode) && normalizedStatus !== expectedExitCode) return null
  return {
    wallTimeMs: value.wallTimeMs,
    userCpuMs: value.userCpuMs,
    systemCpuMs: value.systemCpuMs,
    maxRssKiB: value.maxRssKiB,
    status: value.status,
    measurementSource: 'container-wrapper',
    authoritative: false,
  }
}

export function describeConformanceFailure(result) {
  const bounded = (value) => JSON.stringify(String(value || '').slice(0, 4096))
  return [
    `outcome=${result?.outcome || 'unknown'}`,
    `exitCode=${Number.isInteger(result?.exitCode) ? result.exitCode : 'null'}`,
    `signal=${result?.signal || 'none'}`,
    `oomKilled=${Boolean(result?.oomKilled)}`,
    `stdoutTruncated=${Boolean(result?.stdoutTruncated)}`,
    `stderrTruncated=${Boolean(result?.stderrTruncated)}`,
    `stdout=${bounded(result?.stdout)}`,
    `stderr=${bounded(result?.stderr)}`,
  ].join(' ')
}

export function fileSizeLimitActivated(result) {
  if (result?.outcome === 'success' && result.stdout?.includes('file limit activated')) return true
  // Linux delivers SIGXFSZ (signal 25) when an artifact exceeds RLIMIT_FSIZE.
  // The trusted entrypoint preserves the child's negative signal status in its
  // resource report and exits with the conventional 128 + signal code.
  return result?.outcome === 'failed'
    && result.exitCode === 153
    && result.resourceUsage?.status === -25
}

function spawnCaptured(command, args, { env, timeoutMs, stdoutLimit, stderrLimit, onLimit }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputLimited = false
    let settled = false
    const capture = (target, chunk, kind) => {
      const current = kind === 'stdout' ? stdoutBytes : stderrBytes
      const limit = kind === 'stdout' ? stdoutLimit : stderrLimit
      const remaining = Math.max(0, limit - current)
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      if (kind === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      if (current + chunk.length > limit && !outputLimited) {
        outputLimited = true
        onLimit?.()
      }
    }
    child.stdout.on('data', (chunk) => capture(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk) => capture(stderr, chunk, 'stderr'))
    const timer = setTimeout(() => {
      timedOut = true
      onLimit?.()
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ error, status: null, signal: null, timedOut, outputLimited, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stdoutTruncated: stdoutBytes > stdoutLimit, stderrTruncated: stderrBytes > stderrLimit })
    })
    child.on('close', (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, signal, timedOut, outputLimited, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stdoutTruncated: stdoutBytes > stdoutLimit, stderrTruncated: stderrBytes > stderrLimit })
    })
  })
}

function dockerKill(name, env) {
  runSync(dockerBin(env), ['kill', name], { env })
}

export async function runArtifactDocker(codeDir, artifact, { env = process.env, wallTimeMs = POLICY.limits.wallTimeMs } = {}) {
  const executionId = randomBytes(16).toString('hex')
  const containerName = `codex-paper-${executionId}`
  const createdAt = new Date().toISOString()
  const create = runSync(dockerBin(env), dockerCreateArgs({ containerName, codeDir, artifact }), { env })
  if (create.status !== 0) {
    return { relativePath: artifact.relativePath, sha256: artifact.sha256, argv: artifact.argv, outcome: 'sandbox_error', startedAt: createdAt, completedAt: new Date().toISOString(), exitCode: null, signal: null, stdout: '', stderr: create.stderr?.trim() || 'docker create failed', stdoutTruncated: false, stderrTruncated: false, resourceUsage: null }
  }

  const started = Date.now()
  let capture
  let response
  try {
    capture = await spawnCaptured(dockerBin(env), ['start', '--attach', containerName], {
      env,
      timeoutMs: wallTimeMs,
      stdoutLimit: POLICY.limits.stdoutBytes,
      stderrLimit: POLICY.limits.stderrBytes,
      onLimit: () => dockerKill(containerName, env),
    })
    const stateResult = runSync(dockerBin(env), ['inspect', containerName, '--format', '{{json .State}}'], { env })
    let state = {}
    try { state = JSON.parse(stateResult.stdout || '{}') } catch { state = {} }
    const resourceDir = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-sandbox-resource-'))
    const resourcePath = path.join(resourceDir, 'resource.json')
    let resourceUsage = null
    try {
      const copied = runSync(dockerBin(env), ['cp', `${containerName}:/tmp/codex-paper-resource.json`, resourcePath], { env })
      if (copied.status === 0) {
        const resourceInfo = lstatSync(resourcePath)
        if (resourceInfo.isFile() && !resourceInfo.isSymbolicLink() && resourceInfo.size <= 4096) {
          resourceUsage = normalizeResourceUsage(JSON.parse(readFileSync(resourcePath, 'utf8')), state.ExitCode)
        }
      }
    } catch {
      resourceUsage = null
    } finally {
      rmSync(resourceDir, { recursive: true, force: true })
    }
    const exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode : capture.status
    let outcome = 'success'
    if (capture.timedOut) outcome = 'timeout'
    else if (capture.outputLimited) outcome = 'output_limit'
    else if (state.OOMKilled) outcome = 'oom'
    else if (capture.error) outcome = 'sandbox_error'
    else if (exitCode !== 0) outcome = 'failed'
    response = {
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      argv: artifact.argv,
      outcome,
      startedAt: createdAt,
      completedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - started,
      exitCode,
      signal: capture.signal || null,
      oomKilled: Boolean(state.OOMKilled),
      stdout: capture.stdout,
      stderr: capture.stderr,
      stdoutTruncated: capture.stdoutTruncated,
      stderrTruncated: capture.stderrTruncated,
      resourceUsage,
    }
  } finally {
    const cleanup = runSync(dockerBin(env), ['rm', '--force', containerName], { env })
    if (cleanup.status !== 0 && response) {
      response.outcome = 'sandbox_error'
      response.stderr = `${response.stderr}${response.stderr ? '\n' : ''}docker failed to remove sandbox container`
    }
  }
  return response
}

function prepareReport(paperDir) {
  const internal = path.join(paperDir, '.codex-paper')
  const reports = path.join(internal, 'execution-reports')
  for (const directory of [internal, reports]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
    const info = lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SandboxError('Execution report path is unsafe.')
  }
  const executionId = randomBytes(16).toString('hex')
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
  const finalPath = path.join(reports, `${timestamp}-${executionId}.json`)
  const temporaryPath = path.join(reports, `.${executionId}.pending`)
  const fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
  return { executionId, finalPath, temporaryPath, fd }
}

function snapshotApprovedCode(plan) {
  const snapshotRoot = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-approved-code-'))
  const workspace = path.join(snapshotRoot, 'workspace')
  chmodSync(snapshotRoot, 0o700)
  mkdirSync(workspace, { mode: 0o755 })
  try {
    for (const file of plan.files) {
      const source = path.join(plan.codeDir, ...file.relativePath.split('/'))
      const destination = path.join(workspace, ...file.relativePath.split('/'))
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 })
      const sourceFd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      let content
      try {
        const info = fstatSync(sourceFd)
        if (!info.isFile() || info.size !== file.size) throw new SandboxError(`code/${file.relativePath} changed while creating the approved snapshot.`)
        content = readFileSync(sourceFd)
      } finally {
        closeSync(sourceFd)
      }
      if (sha256Buffer(content) !== file.sha256) throw new SandboxError(`code/${file.relativePath} changed while creating the approved snapshot.`)
      const destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o444)
      try {
        writeSync(destinationFd, content)
        fsyncSync(destinationFd)
      } finally {
        closeSync(destinationFd)
      }
    }
    return { root: snapshotRoot, codeDir: workspace }
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true })
    throw error
  }
}

function commitReport(reservation, report) {
  try {
    writeSync(reservation.fd, `${JSON.stringify(report, null, 2)}\n`)
    fsyncSync(reservation.fd)
  } finally {
    closeSync(reservation.fd)
  }
  renameSync(reservation.temporaryPath, reservation.finalPath)
}

export async function executeApprovedPlan(input, token, { env = process.env } = {}) {
  const capability = getSandboxCapability({ env })
  if (capability.status !== 'ready') throw new SandboxError(capability.reason || 'Sandbox is unavailable.', EXIT.UNAVAILABLE, 'sandbox_unavailable')
  const approval = claimApproval(token, env)
  const plan = buildExecutionPlan(input, { env, issueApproval: false })
  if (approval.paperDir !== plan.paperDir || approval.binding !== planBinding(plan, capability)) {
    throw new SandboxError('Approval token does not match the current paper, code, image, or policy.')
  }
  const snapshot = snapshotApprovedCode(plan)
  let reservation
  const results = []
  let failed = false
  try {
    reservation = prepareReport(plan.paperDir)
    for (const artifact of plan.artifacts) {
      if (failed) {
        results.push({ relativePath: artifact.relativePath, sha256: artifact.sha256, argv: artifact.argv, outcome: 'skipped' })
        continue
      }
      const result = await runArtifactDocker(snapshot.codeDir, artifact, { env })
      results.push(result)
      failed = result.outcome !== 'success'
    }
    const report = {
      executionReportVersion: POLICY.executionReportVersion,
      executionId: reservation.executionId,
      generatedAt: new Date().toISOString(),
      policyVersion: POLICY.policyVersion,
      backend: { kind: 'docker', imageTag: POLICY.imageTag, imageId: capability.imageId, docker: capability.docker, conformanceVersion: POLICY.conformanceVersion },
      boundary: plan.boundary,
      limits: plan.limits,
      artifacts: results,
      outcome: failed ? 'fail' : 'pass',
    }
    commitReport(reservation, report)
    return { report, reportPath: reservation.finalPath, exitCode: failed ? EXIT.EXECUTION : EXIT.OK }
  } catch (error) {
    if (reservation) {
      try { closeSync(reservation.fd) } catch {}
      rmSync(reservation.temporaryPath, { force: true })
    }
    throw error
  } finally {
    rmSync(snapshot.root, { recursive: true, force: true })
  }
}

async function runConformance({ env = process.env } = {}) {
  const capability = getSandboxCapability({ env, requireStamp: false })
  if (capability.status !== 'ready') throw new SandboxError(capability.reason || 'Sandbox image is unavailable.', EXIT.UNAVAILABLE, 'sandbox_unavailable')
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-paper-sandbox-conformance-')))
  const codeDir = path.join(root, 'code')
  mkdirSync(codeDir)
  try {
    writeFileSync(path.join(codeDir, 'conformance.py'), [
      'import os, pathlib, socket',
      'assert os.environ == {"HOME":"/tmp/home","LANG":"C.UTF-8","PATH":"/usr/local/bin:/usr/bin:/bin"}',
      'assert not pathlib.Path("/var/run/docker.sock").exists()',
      'for target in (pathlib.Path("/workspace/blocked"), pathlib.Path("/etc/blocked")):',
      '  try: target.write_text("blocked"); raise AssertionError(f"write unexpectedly succeeded: {target}")',
      '  except OSError: pass',
      'pathlib.Path("/tmp/allowed").write_text("ok")',
      'sock=socket.socket(); sock.settimeout(0.5)',
      'try: sock.connect(("1.1.1.1", 53)); raise AssertionError("network unexpectedly available")',
      'except OSError: pass',
      'print("python conformance ok")',
      '',
    ].join('\n'))
    writeFileSync(path.join(codeDir, 'conformance.js'), [
      'const failures = []',
      'if (process.env.HOME !== "/tmp/home") failures.push(`unexpected HOME=${JSON.stringify(process.env.HOME)}`)',
      'if (process.env.CODEX_PAPER_SECRET_CANARY) failures.push("host secret canary reached the container")',
      'if (failures.length) { console.error(`node conformance failed: ${failures.join("; ")}`); process.exit(3) }',
      'console.log("node conformance ok")',
      '',
    ].join('\n'))
    const scan = scanCodeTree(root)
    const envWithCanary = { ...env, CODEX_PAPER_SECRET_CANARY: 'must-not-enter-container' }
    for (const artifact of scan.artifacts) {
      const result = await runArtifactDocker(scan.codeDir, artifact, { env: envWithCanary })
      if (result.outcome !== 'success') throw new SandboxError(`Conformance failed for ${artifact.relativePath}: ${describeConformanceFailure(result)}`, EXIT.UNAVAILABLE, 'sandbox_nonconformant')
    }
    writeFileSync(path.join(codeDir, 'output-limit.py'), 'import sys\nsys.stdout.write("x" * 1100000)\n')
    const outputArtifact = scanCodeTree(root).artifacts.find((item) => item.filename === 'output-limit.py')
    const outputResult = await runArtifactDocker(codeDir, outputArtifact, { env: envWithCanary })
    if (outputResult.outcome !== 'output_limit') throw new SandboxError('Conformance output limit did not activate.', EXIT.UNAVAILABLE, 'sandbox_nonconformant')
    writeFileSync(path.join(codeDir, 'timeout.py'), 'while True:\n  pass\n')
    const timeoutArtifact = scanCodeTree(root).artifacts.find((item) => item.filename === 'timeout.py')
    const timeoutResult = await runArtifactDocker(codeDir, timeoutArtifact, { env: envWithCanary, wallTimeMs: 750 })
    if (timeoutResult.outcome !== 'timeout') throw new SandboxError('Conformance wall-time limit did not activate.', EXIT.UNAVAILABLE, 'sandbox_nonconformant')

    writeFileSync(path.join(codeDir, 'file-limit.py'), [
      'import pathlib, sys',
      'try:',
      '  with pathlib.Path("/tmp/oversized").open("wb") as target:',
      '    for _ in range(70): target.write(b"x" * 1024 * 1024)',
      'except OSError:',
      '  print("file limit activated")',
      '  sys.exit(0)',
      'raise SystemExit("file limit did not activate")',
      '',
    ].join('\n'))
    const fileArtifact = scanCodeTree(root).artifacts.find((item) => item.filename === 'file-limit.py')
    const fileResult = await runArtifactDocker(codeDir, fileArtifact, { env: envWithCanary })
    if (!fileSizeLimitActivated(fileResult)) {
      throw new SandboxError(`Conformance file-size limit did not activate: ${describeConformanceFailure(fileResult)}`, EXIT.UNAVAILABLE, 'sandbox_nonconformant')
    }

    writeFileSync(path.join(codeDir, 'pid-limit.py'), [
      'import subprocess, sys',
      'children=[]',
      'blocked=False',
      'try:',
      '  for _ in range(80): children.append(subprocess.Popen(["sleep", "2"]))',
      'except OSError:',
      '  blocked=True',
      'finally:',
      '  for child in children:',
      '    child.terminate()',
      '  for child in children:',
      '    try: child.wait(timeout=1)',
      '    except Exception: child.kill()',
      'if not blocked or len(children) >= 64: raise SystemExit("pid limit did not activate")',
      'print("pid limit activated")',
      '',
    ].join('\n'))
    const pidArtifact = scanCodeTree(root).artifacts.find((item) => item.filename === 'pid-limit.py')
    const pidResult = await runArtifactDocker(codeDir, pidArtifact, { env: envWithCanary })
    if (pidResult.outcome !== 'success' || !pidResult.stdout.includes('pid limit activated')) throw new SandboxError('Conformance PID limit did not activate.', EXIT.UNAVAILABLE, 'sandbox_nonconformant')

    writeFileSync(path.join(codeDir, 'memory-limit.py'), [
      'import sys',
      'chunks=[]',
      'try:',
      '  for _ in range(320): chunks.append(bytearray(1024 * 1024))',
      'except MemoryError:',
      '  print("memory limit activated")',
      '  sys.exit(0)',
      'raise SystemExit("memory limit did not activate")',
      '',
    ].join('\n'))
    const memoryArtifact = scanCodeTree(root).artifacts.find((item) => item.filename === 'memory-limit.py')
    const memoryResult = await runArtifactDocker(codeDir, memoryArtifact, { env: envWithCanary })
    if (!((memoryResult.outcome === 'success' && memoryResult.stdout.includes('memory limit activated')) || memoryResult.outcome === 'oom')) {
      throw new SandboxError('Conformance memory limit did not activate.', EXIT.UNAVAILABLE, 'sandbox_nonconformant')
    }

    const docker = inspectDocker({ env })
    const image = inspectSandboxImage({ env })
    const stamp = { ...expectedStamp(docker, image), passedAt: new Date().toISOString() }
    writePrivateJson(conformanceStampPath(env), stamp)
    return stamp
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function setupSandbox({ env = process.env } = {}) {
  const docker = inspectDocker({ env })
  if (!docker.ok) throw new SandboxError(docker.reason, EXIT.UNAVAILABLE, 'sandbox_unavailable')
  const fingerprint = sandboxPolicyFingerprint()
  const build = runSync(dockerBin(env), [
    'build', '--pull', '--tag', POLICY.imageTag,
    '--build-arg', `BASE_IMAGE=${POLICY.baseImage}`,
    '--build-arg', `CODEX_PAPER_POLICY_HASH=${fingerprint}`,
    SANDBOX_ROOT,
  ], { env, stdio: 'inherit' })
  if (build.status !== 0) throw new SandboxError('Sandbox image build failed.', EXIT.UNAVAILABLE, 'sandbox_build_failed')
  return runConformance({ env })
}

function printPlan(plan, json) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  console.log(`Sandbox capability: ${plan.capability.status}${plan.capability.reason ? ` (${plan.capability.reason})` : ''}`)
  console.log(`Policy: ${plan.policyVersion}`)
  console.log(`Paper: ${plan.paperDir}`)
  console.log('Boundary: Docker, network=none, source=read-only, writable=/tmp, credentials=not inherited')
  console.log('Consent: workflow-enforced; the token binds this plan but does not authenticate a human')
  console.log('Artifacts:')
  for (const artifact of plan.artifacts) console.log(`- ${artifact.relativePath} sha256=${artifact.sha256}\n  ${artifact.argv.join(' ')}`)
  console.log(`Limits: wall=${plan.limits.wallTimeMs}ms cpu=${plan.limits.cpuSeconds}s memory=${plan.limits.memoryBytes} pids=${plan.limits.pids} stdout=${plan.limits.stdoutBytes} stderr=${plan.limits.stderrBytes}`)
  if (plan.approval) {
    console.log(`Approval token: ${plan.approval.token}`)
    console.log(`Approval expires: ${plan.approval.expiresAt}`)
  } else {
    console.log('Approval token: not issued because the sandbox is not ready')
  }
}

function parseCommandArgs(argv) {
  const [command, ...rest] = argv
  if (!command) throw new SandboxError('Missing sandbox command.')
  let input = null
  let approvalToken = null
  let json = false
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--json') {
      if (json) throw new SandboxError('Duplicate option: --json')
      json = true
    } else if (arg === '--approval-token') {
      if (approvalToken !== null || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new SandboxError('--approval-token requires one value.')
      approvalToken = rest[index + 1]
      index += 1
    } else if (arg.startsWith('--')) {
      throw new SandboxError(`Unknown option: ${arg}`)
    } else if (input === null) {
      input = arg
    } else {
      throw new SandboxError(`Unexpected argument: ${arg}`)
    }
  }
  return { command, input, approvalToken, json }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCommandArgs(argv)
  if (args.command === 'status') {
    if (args.input || args.approvalToken) throw new SandboxError('sandbox-status does not accept a paper or approval token.')
    const capability = getSandboxCapability()
    if (args.json) console.log(JSON.stringify(capability, null, 2))
    else console.log(`Sandbox status: ${capability.status}${capability.reason ? `\nReason: ${capability.reason}` : ''}`)
    return capability.status === 'ready' ? EXIT.OK : EXIT.UNAVAILABLE
  }
  if (args.command === 'setup') {
    if (args.input || args.approvalToken || args.json) throw new SandboxError('sandbox-setup does not accept arguments.')
    const stamp = await setupSandbox()
    console.log(`Sandbox setup passed at ${stamp.passedAt}`)
    return EXIT.OK
  }
  if (args.command === 'test') {
    if (args.input || args.approvalToken || args.json) throw new SandboxError('sandbox-test does not accept arguments.')
    const stamp = await runConformance()
    console.log(`Sandbox conformance passed at ${stamp.passedAt}`)
    return EXIT.OK
  }
  if (args.command === 'plan') {
    if (!args.input || args.approvalToken) throw new SandboxError('sandbox-plan requires exactly one paper directory or slug.')
    const plan = buildExecutionPlan(args.input)
    printPlan(plan, args.json)
    return plan.capability.status === 'ready' ? EXIT.OK : EXIT.UNAVAILABLE
  }
  if (args.command === 'run') {
    if (!args.input || !args.approvalToken) throw new SandboxError('sandbox-run requires a paper and --approval-token.')
    const result = await executeApprovedPlan(args.input, args.approvalToken)
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`Sandbox execution: ${result.report.outcome.toUpperCase()}`)
      for (const artifact of result.report.artifacts) console.log(`- ${artifact.relativePath}: ${artifact.outcome}`)
      console.log(`Execution report: ${result.reportPath}`)
    }
    return result.exitCode
  }
  throw new SandboxError(`Unknown sandbox command: ${args.command}`)
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isCli) {
  main()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      const exitCode = error instanceof SandboxError ? error.exitCode : EXIT.POLICY
      const code = error instanceof SandboxError ? error.code : 'sandbox_internal_error'
      console.error(`${code}: ${error.message}`)
      process.exitCode = exitCode
    })
}
