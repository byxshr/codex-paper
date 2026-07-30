import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditDependencies, evaluateAudit } from '../dependency-audit.mjs'
import { acquireSetupLock, managedPythonPath, normalizeManagedVenvAliases, publishPreparedRuntime, runtimeStatus, sanitizeDiagnostic, sha256Directory } from '../runtime-policy.mjs'
import { scanContent, scanRepository, validateSecretPolicy } from '../secret-scan.mjs'
import { checkSupplyChain, checkWorkflowUses, validateDependencyPolicy } from '../supply-chain-check.mjs'

const webLock = 'plugins/codex-paper/src/web/package-lock.json'
const dependencyPolicy = JSON.parse(readFileSync(new URL('../../security/dependency-policy.json', import.meta.url), 'utf8'))

function auditWith(vulnerabilities) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
  for (const item of Object.values(vulnerabilities)) {
    counts[item.severity] += 1
    counts.total += 1
  }
  return { metadata: { vulnerabilities: counts }, vulnerabilities }
}

test('dependency policy accepts zero findings for the plugin lockfile', () => {
  const result = evaluateAudit({
    lockfile: 'plugins/codex-paper/package-lock.json',
    audit: auditWith({}),
    now: new Date('2026-07-27T00:00:00Z'),
  })
  assert.equal(result.ok, true)
})

test('dependency policy blocks every critical finding', () => {
  const result = evaluateAudit({
    lockfile: webLock,
    audit: auditWith({ dangerous: { severity: 'critical', range: '<2' } }),
    now: new Date('2026-07-27T00:00:00Z'),
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /critical/)
})

test('dependency policy blocks unknown and expired high findings', () => {
  const unknown = evaluateAudit({
    lockfile: webLock,
    audit: auditWith({ unexpected: { severity: 'high', range: '<1' } }),
    now: new Date('2026-07-27T00:00:00Z'),
  })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join(' '), /added|disappeared/)

  const expired = evaluateAudit({
    lockfile: webLock,
    audit: auditWith(Object.fromEntries([
      ['@nuxt/nitro-server', { severity: 'high', range: '>=3.20.0' }],
      ['@nuxt/vite-builder', { severity: 'high', range: '3.20.0 - 3.21.10 || >=4.2.0' }],
      ['archiver', { severity: 'high', range: '0.20.0 - 7.0.1' }],
      ['archiver-utils', { severity: 'high', range: '>=0.2.0' }],
      ['brace-expansion', { severity: 'high', range: '<=5.0.7' }],
      ['glob', { severity: 'high', range: '4.3.0 - 10.5.0' }],
      ['minimatch', { severity: 'high', range: '2.0.0 - 10.0.2' }],
      ['nitropack', { severity: 'high', range: '>=0.1.0' }],
      ['nuxt', { severity: 'high', range: '3.20.0 - 3.21.10 || >=4.2.0' }],
      ['picomatch', { severity: 'high', range: '<=2.3.1' }],
      ['readdir-glob', { severity: 'high', range: '<=2.0.3' }],
      ['zip-stream', { severity: 'high', range: '0.8.0 - 6.0.1' }],
    ])),
    now: new Date('2026-09-01T00:00:00Z'),
  })
  assert.equal(expired.ok, false)
  assert.match(expired.errors.join(' '), /expired/)
})

test('dependency exceptions are exact over package, range, and installed nodes', () => {
  const exception = dependencyPolicy.exceptions.find((entry) => entry.lockfile === webLock)
  const vulnerabilities = Object.fromEntries(exception.packages.map((item) => [
    item.name,
    { severity: 'high', range: item.range, nodes: item.nodes },
  ]))
  assert.equal(evaluateAudit({
    lockfile: webLock,
    audit: auditWith(vulnerabilities),
    now: new Date('2026-07-27T00:00:00Z'),
  }).ok, true)

  vulnerabilities[exception.packages[0].name] = {
    ...vulnerabilities[exception.packages[0].name],
    nodes: ['node_modules/unreviewed-path'],
  }
  const drifted = evaluateAudit({
    lockfile: webLock,
    audit: auditWith(vulnerabilities),
    now: new Date('2026-07-27T00:00:00Z'),
  })
  assert.equal(drifted.ok, false)
  assert.match(drifted.errors.join(' '), /shape changed/)
})

test('dependency drift diagnostics distinguish additions, removals, and changed shapes', () => {
  const exception = dependencyPolicy.exceptions.find((entry) => entry.lockfile === webLock)
  const exact = Object.fromEntries(exception.packages.map((item) => [
    item.name,
    { severity: 'high', range: item.range, nodes: item.nodes },
  ]))
  delete exact[exception.packages[0].name]
  exact.unreviewed = { severity: 'high', range: '<1', nodes: ['node_modules/unreviewed'] }
  exact[exception.packages[1].name] = { ...exact[exception.packages[1].name], range: '<changed' }
  const result = evaluateAudit({ lockfile: webLock, audit: auditWith(exact), now: new Date('2026-07-27T00:00:00Z') })
  assert.match(result.errors.join('\n'), /added: unreviewed/)
  assert.match(result.errors.join('\n'), /disappeared/)
  assert.match(result.errors.join('\n'), /shape changed/)
})

test('dependency policy schema rejects non-expiring or unjustified exceptions', () => {
  const invalid = structuredClone(dependencyPolicy)
  delete invalid.exceptions[0].expiresOn
  invalid.exceptions[0].packages[0].nodes = []
  invalid.peerDependencyRelaxations[0].reason = ''
  const errors = []
  validateDependencyPolicy(invalid, errors)
  assert.match(errors.join('\n'), /expiresOn/)
  assert.match(errors.join('\n'), /non-empty installed nodes/)
  assert.match(errors.join('\n'), /document reason/)
  const standalone = auditDependencies({ dependencyPolicy: invalid })
  assert.equal(standalone.status, 'configuration_error')
  assert.match(standalone.error, /expiresOn/)
})

test('secret scanner detects representative secrets without returning their value', () => {
  const samples = [
    ['github-token', ['g', 'hp_', 'A'.repeat(30)].join('')],
    ['openai-token', ['s', 'k-proj-', 'B'.repeat(30)].join('')],
    ['aws-access-key', ['A', 'KIA', 'C'.repeat(16)].join('')],
    ['private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['credential-url', ['https://user:', 'password@example.com/path'].join('')],
  ]
  for (const [rule, value] of samples) {
    const findings = scanContent(value)
    assert.equal(findings[0]?.rule, rule)
    assert.equal(JSON.stringify(findings).includes(value), false)
  }
  assert.equal(scanContent(`\u0000${samples[0][1]}`)[0]?.rule, 'github-token')
})

test('secret scanner reports missing tracked files as configuration errors and oversize files as policy failures', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-secret-test-'))
  try {
    const missing = scanRepository({ root, files: ['missing.txt'] })
    assert.equal(missing.status, 'configuration_error')
    assert.match(missing.configurationErrors[0].reason, /unavailable/)

    writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1))
    const oversized = scanRepository({ root, files: ['large.txt'] })
    assert.equal(oversized.status, 'fail')
    assert.match(oversized.errors[0].reason, /exceeds secret scan budget/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret findings take precedence over simultaneous configuration errors', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-secret-precedence-test-'))
  try {
    const token = ['g', 'hp_', 'D'.repeat(30)].join('')
    writeFileSync(path.join(root, 'secret.txt'), token)
    const report = scanRepository({ root, files: ['secret.txt', 'missing.txt'] })
    assert.equal(report.status, 'fail')
    assert.equal(report.findings.length, 1)
    assert.equal(report.configurationErrors.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('standalone secret scan policy validation fails closed as configuration', () => {
  const invalid = {
    schemaVersion: '1.0.0',
    policyVersion: 'test',
    maxFileBytes: 0,
    allowlist: [{ expiresOn: 'never' }],
  }
  assert.match(validateSecretPolicy(invalid).join('\n'), /maxFileBytes/)
  assert.equal(scanRepository({ files: [], policyOverride: invalid }).status, 'configuration_error')
})

test('workflow uses policy rejects missing revisions and mutable Docker tags', () => {
  const invalid = []
  checkWorkflowUses('uses: owner/action\nuses: docker://alpine:latest\n', invalid)
  assert.equal(invalid.length, 2)
  const valid = []
  checkWorkflowUses([
    'uses: ./.github/actions/local',
    `uses: owner/action@${'a'.repeat(40)}`,
    `uses: docker://alpine@sha256:${'b'.repeat(64)}`,
  ].join('\n'), valid)
  assert.deepEqual(valid, [])
})

test('runtime status is path-redacted and uses the managed runtime location', () => {
  const env = { ...process.env, CODEX_PAPER_RUNTIME_DIR: '/tmp/codex-paper-runtime-test' }
  assert.match(managedPythonPath(env), /python-3\.11\.15\/bin\/python$/)
  const status = runtimeStatus(env)
  assert.equal(JSON.stringify(status).includes('/tmp/codex-paper-runtime-test'), false)
})

test('runtime publication restores the previous runtime when replacement rename fails', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-runtime-publish-test-'))
  const target = path.join(root, 'python-3.11.15')
  mkdirSync(target)
  writeFileSync(path.join(target, 'sentinel'), 'old')
  assert.throws(() => publishPreparedRuntime(path.join(root, 'missing-init'), target))
  assert.equal(readFileSync(path.join(target, 'sentinel'), 'utf8'), 'old')
  assert.equal(existsSync(`${target}.previous`), false)
  rmSync(root, { recursive: true, force: true })
})

test('runtime publication rolls back when post-publication verification fails', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-runtime-verify-test-'))
  const target = path.join(root, 'python-3.11.15')
  const replacement = path.join(root, '.runtime-init-replacement')
  mkdirSync(target)
  mkdirSync(replacement)
  writeFileSync(path.join(target, 'sentinel'), 'old')
  writeFileSync(path.join(replacement, 'sentinel'), 'new')
  assert.throws(() => publishPreparedRuntime(replacement, target, {
    verify: () => {
      throw new Error('verification failed')
    },
  }), /verification failed/)
  assert.equal(readFileSync(path.join(target, 'sentinel'), 'utf8'), 'old')
  assert.equal(existsSync(`${target}.previous`), false)
  rmSync(root, { recursive: true, force: true })
})

test('runtime tree attestation ignores marker and bytecode caches but covers config/native files and rejects symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-runtime-hash-test-'))
  try {
    writeFileSync(path.join(root, 'os.py'), 'stable')
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = managed')
    mkdirSync(path.join(root, 'lib'))
    writeFileSync(path.join(root, 'lib/libssl.test.dylib'), 'native-stable')
    const baseline = sha256Directory(root)
    mkdirSync(path.join(root, '__pycache__'))
    writeFileSync(path.join(root, '__pycache__/os.cpython-311.pyc'), 'runtime cache')
    writeFileSync(path.join(root, '.codex-paper-runtime.json'), 'dynamic marker')
    assert.equal(sha256Directory(root), baseline)
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = outside')
    assert.notEqual(sha256Directory(root), baseline)
    writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = managed')
    writeFileSync(path.join(root, 'lib/libssl.test.dylib'), 'native-changed')
    assert.notEqual(sha256Directory(root), baseline)
    writeFileSync(path.join(root, 'lib/libssl.test.dylib'), 'native-stable')
    chmodSync(path.join(root, 'os.py'), 0o600)
    assert.notEqual(sha256Directory(root), baseline)
    symlinkSync(path.join(root, 'os.py'), path.join(root, 'linked.py'))
    assert.throws(() => sha256Directory(root), /unsupported filesystem entry/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed venv normalization removes only the standard contained lib64 alias', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-venv-alias-test-'))
  try {
    mkdirSync(path.join(root, 'lib'))
    symlinkSync('lib', path.join(root, 'lib64'))
    normalizeManagedVenvAliases(root)
    assert.equal(existsSync(path.join(root, 'lib64')), false)

    mkdirSync(path.join(root, 'other'))
    symlinkSync('other', path.join(root, 'lib64'))
    assert.throws(() => normalizeManagedVenvAliases(root), /unsafe lib64 entry/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime diagnostics redact home, runtime, temporary paths, and URL credentials', () => {
  const env = { ...process.env, CODEX_PAPER_RUNTIME_DIR: path.join(os.homedir(), '.cache/codex-paper/runtime-v1') }
  const credentialUrl = ['https://user', 'password@example.test/wheel'].join(':')
  const diagnostic = sanitizeDiagnostic(
    `${os.homedir()}/private ${os.tmpdir()}/init /tmp/bootstrap/lib ${credentialUrl}`,
    env,
  )
  assert.equal(diagnostic.includes(os.homedir()), false)
  assert.equal(diagnostic.includes('user:password'), false)
  assert.equal(diagnostic.includes('/tmp/bootstrap'), false)
  assert.match(diagnostic, /<temporary>/)
  assert.match(diagnostic, /<redacted>@/)
})

test('runtime setup lock reclaims expired foreign-host locks and classifies active conflicts as unavailable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-runtime-lock-test-'))
  const lock = path.join(root, '.runtime-setup.lock')
  try {
    mkdirSync(lock, { mode: 0o700 })
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      token: 'expired',
      pid: 999999,
      hostname: 'previous-container',
      acquiredAt: '2026-07-28T00:00:00.000Z',
      acquiredAtMs: Date.now() - 31 * 60 * 1000,
    }), { mode: 0o600 })
    const release = acquireSetupLock(root)
    release()
    assert.equal(existsSync(lock), false)

    mkdirSync(lock, { mode: 0o700 })
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      token: 'active',
      pid: 1,
      hostname: 'current-container',
      acquiredAt: new Date().toISOString(),
      acquiredAtMs: Date.now(),
    }), { mode: 0o600 })
    assert.throws(() => acquireSetupLock(root), (error) => error.exitCode === 3 && /already in progress/.test(error.message))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository supply-chain baseline passes', () => {
  assert.deepEqual(checkSupplyChain().errors, [])
})
