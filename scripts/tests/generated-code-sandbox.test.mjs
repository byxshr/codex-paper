import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isContained, listManagedRecords, resolveExplicitPackage } from '../../plugins/codex-paper/src/shared/paper-library.mjs'
import { inventoryGenerationFiles, stableJson } from '../../plugins/codex-paper/src/shared/generation-manifest.mjs'
import {
  buildProvenanceDraft,
  collectRuntimeAttestation,
  sha256,
} from '../../plugins/codex-paper/src/shared/generation-provenance.mjs'

import {
  SandboxError,
  buildExecutionPlan,
  dockerCreateArgs,
  executeApprovedPlan,
  fileSizeLimitActivated,
  getSandboxCapability,
  runArtifactDocker,
  sandboxPolicyFingerprint,
} from '../../plugins/codex-paper/skills/study/scripts/sandbox-code.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const RUNNER = path.join(REPO_ROOT, 'plugins/codex-paper/skills/study/scripts/sandbox-code.js')
const VALIDATOR = path.join(REPO_ROOT, 'plugins/codex-paper/skills/study/scripts/validate-study-package.js')
const FAKE_DOCKER = path.join(REPO_ROOT, 'scripts/tests/fixtures/fake-docker.mjs')
const POLICY = JSON.parse(readFileSync(path.join(REPO_ROOT, 'plugins/codex-paper/sandbox/policy.json'), 'utf8'))

chmodSync(FAKE_DOCKER, 0o755)

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-paper-sandbox-test-'))
  const workspaceId = 'ws-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccccccccccccccccccc'
  const workspaceDir = path.join(root, '.codex-paper', 'workspaces-v1', workspaceId)
  const paper = path.join(workspaceDir, 'package')
  mkdirSync(path.join(paper, 'code'), { recursive: true })
  const sourceRevisionId = `sha256:${'1'.repeat(64)}`
  const generationId = `gen:sha256:${'2'.repeat(64)}`
  writeFileSync(path.join(workspaceDir, 'workspace.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', workspaceId, state: 'authoring', paperKey: `p-${'3'.repeat(64)}`,
    paperId: `source:${sourceRevisionId}`, sourceRevisionId, generationId,
    targetPackageRelativePath: `sources/sha256-${'1'.repeat(64)}/generations/gen-sha256-${'2'.repeat(64)}/package`,
    routeSlug: 'paper', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    lastSuccessfulStep: 'initialized', diagnostics: [], publishIntent: { paperRecord: {}, reconciliation: null, tags: [] },
  }, null, 2)}\n`)
  const runtime = collectRuntimeAttestation(process.env, {
    node: '22.23.1',
    npm: '10.9.8',
    python: { version: '3.11.15', implementation: 'CPython', pyMuPDF: '1.28.0' },
  })
  const identity = {
    schemaVersion: '2.0.0',
    paperId: `source:${sourceRevisionId}`,
    sourceRevisionId,
    generationId,
    source: { sha256: sourceRevisionId.replace(/^sha256:/, '') },
    canonical: { resolution: 'source_fallback', primary: null, aliases: [], candidates: [], diagnostics: [] },
    generation: {
      inputs: {
        workflow: 'study',
        pluginBaseVersion: '2.0.0',
        evidenceSchemaVersion: '2.0.0',
        factsSchemaVersion: '2.1.0',
        reasoningSchemaVersion: '2.0.0',
        authoringEngine: { provider: 'unavailable', model: 'unavailable', evidence: 'unavailable' },
      },
    },
    provenance: { pluginBuildVersion: '2.0.0+codex.test' },
  }
  const draft = buildProvenanceDraft({
    workspaceId,
    paperKey: `p-${'3'.repeat(64)}`,
    sourceRevisionId,
    generationId,
    identity,
    runtime,
    source: {
      kind: 'local_file',
      filename: 'sandbox.pdf',
      bytes: 64,
      acquiredAt: '2026-07-30T00:00:00.000Z',
    },
    now: '2026-07-30T00:00:00.000Z',
  })
  writeFileSync(path.join(workspaceDir, 'provenance-draft.json'), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(path.join(paper, 'code', 'demo.py'), 'print("safe")\n')
  const env = {
    ...process.env,
    PAPERS_DIR: root,
    CODEX_PAPER_DOCKER_BIN: FAKE_DOCKER,
    CODEX_PAPER_SANDBOX_STATE_DIR: path.join(root, 'state'),
    CODEX_PAPER_SANDBOX_APPROVAL_DIR: path.join(root, 'approvals'),
    FAKE_DOCKER_POLICY_HASH: sandboxPolicyFingerprint(),
    FAKE_DOCKER_IMAGE_ID: 'sha256:fake-sandbox-image',
  }
  return { root, paper, workspaceDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeConformanceStamp(env, overrides = {}) {
  mkdirSync(env.CODEX_PAPER_SANDBOX_STATE_DIR, { recursive: true, mode: 0o700 })
  chmodSync(env.CODEX_PAPER_SANDBOX_STATE_DIR, 0o700)
  const stamp = {
    conformanceVersion: '1.0.0',
    policyHash: sandboxPolicyFingerprint(),
    imageId: env.FAKE_DOCKER_IMAGE_ID,
    docker: { client: '29.1.0', server: '29.1.0', os: 'linux', arch: 'amd64' },
    platform: `${process.platform}/${process.arch}`,
    passedAt: new Date().toISOString(),
    ...overrides,
  }
  const file = path.join(env.CODEX_PAPER_SANDBOX_STATE_DIR, 'conformance.json')
  writeFileSync(file, JSON.stringify(stamp), { mode: 0o600 })
  chmodSync(file, 0o600)
}

function createPublishedGeneration(item, { createOverlay = false } = {}) {
  const paperKey = `p-${'4'.repeat(64)}`
  const paperId = `source:sha256:${'5'.repeat(64)}`
  const sourceRevisionId = `sha256:${'6'.repeat(64)}`
  const generationId = `gen:sha256:${'7'.repeat(64)}`
  const relative = `sources/sha256-${'6'.repeat(64)}/generations/gen-sha256-${'7'.repeat(64)}/package`
  const recordDir = path.join(item.root, '.codex-paper', 'store-v1', 'papers', paperKey)
  const packageDir = path.join(recordDir, ...relative.split('/'))
  mkdirSync(path.join(packageDir, 'code'), { recursive: true })
  if (createOverlay) mkdirSync(path.join(recordDir, 'overlay'), { recursive: true })
  writeFileSync(path.join(packageDir, 'code', 'demo.py'), 'print("published")\n')
  writeFileSync(path.join(recordDir, 'paper.json'), JSON.stringify({
    schemaVersion: '1.0.0', paperKey, primaryPaperId: paperId, paperIdAliases: [paperId],
    routeAliases: ['published-paper'], createdAt: new Date(0).toISOString(), reconciliations: [],
  }))
  writeFileSync(path.join(recordDir, 'current.json'), JSON.stringify({
    schemaVersion: '1.0.0', paperKey, paperId, sourceRevisionId, generationId, packageRelativePath: relative,
  }))
  mkdirSync(path.join(packageDir, '.codex-paper'))
  writeFileSync(path.join(packageDir, '.codex-paper', 'paper-identity.json'), JSON.stringify({
    paperId, sourceRevisionId, generationId, slug: 'published-paper',
  }))
  const validationReportHash = '8'.repeat(64)
  const manifestId = `gm-sha256-${sha256(stableJson({ paperKey, generationId, validationReportHash }))}`
  const intrinsic = {
    schemaVersion: '1.0.0',
    manifestId,
    transactionState: 'sealed',
    transactionId: `pub-${'9'.repeat(32)}`,
    paperKey,
    paperId,
    sourceRevisionId,
    generationId,
    sourceSha256: sourceRevisionId.replace(/^sha256:/, ''),
    generationFingerprint: generationId.replace(/^gen:sha256:/, ''),
    validation: { schemaVersion: '1.0.0', status: 'pass', reportHash: validationReportHash },
    sealedAt: '2026-07-30T00:00:00.000Z',
    files: inventoryGenerationFiles(packageDir),
  }
  const manifest = { ...intrinsic, manifestHash: sha256(stableJson(intrinsic)) }
  const manifestPath = path.join(packageDir, '.codex-paper/generation-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  const manifestFileSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
  writeFileSync(path.join(recordDir, 'current.json'), JSON.stringify({
    schemaVersion: '1.0.0', paperKey, paperId, sourceRevisionId, generationId, packageRelativePath: relative,
    manifestId, manifestHash: manifest.manifestHash, manifestFileSha256, validationReportHash,
    publishedAt: '2026-07-30T00:00:00.000Z',
  }))
  return { packageDir, overlayDir: path.join(recordDir, 'overlay') }
}

test('legacy validator execution flags fail with exit 2 and never execute code', () => {
  const marker = path.join(os.tmpdir(), `codex-paper-validator-marker-${process.pid}`)
  rmSync(marker, { force: true })
  const result = spawnSync(process.execPath, [VALIDATOR, 'missing-package', '--run-code'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /was removed because package validation must never execute generated code/)
  assert.equal(lstatSafe(marker), null)
})

test('missing Docker is unavailable and static plan never issues approval', () => {
  const item = fixture()
  try {
    const env = { ...item.env, CODEX_PAPER_DOCKER_BIN: path.join(item.root, 'missing-docker') }
    const capability = getSandboxCapability({ env })
    assert.equal(capability.status, 'unavailable')
    assert.match(capability.reason, /not installed/)
    const plan = buildExecutionPlan(item.paper, { env })
    assert.equal(plan.approval, null)
    assert.equal(plan.capability.status, 'unavailable')
  } finally { item.cleanup() }
})

test('matching conformance stamp enables one-time approval and report', async () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    item.env.FAKE_DOCKER_CAPTURE = path.join(item.root, 'docker-argv.jsonl')
    assert.equal(getSandboxCapability({ env: item.env }).status, 'ready')
    const plan = buildExecutionPlan(item.paper, { env: item.env })
    assert.match(plan.approval.token, /^[a-f0-9]{64}$/)
    assert.equal(lstatSync(path.join(item.env.CODEX_PAPER_SANDBOX_APPROVAL_DIR, `${plan.approval.token}.json`)).mode & 0o077, 0)
    const result = await executeApprovedPlan(item.paper, plan.approval.token, { env: item.env })
    assert.equal(result.exitCode, 0)
    assert.equal(result.report.outcome, 'pass')
    assert.equal(result.report.executionReportVersion, '2.0.0')
    assert.equal(result.report.generationBinding.phase, 'preseal')
    assert.match(result.report.generationBinding.manifestId, /^gm-sha256-[a-f0-9]{64}$/)
    assert.match(result.report.reportHash.value, /^[a-f0-9]{64}$/)
    assert.equal(result.report.artifacts[0].outcome, 'success')
    assert.equal(result.report.artifacts[0].resourceUsage.maxRssKiB, 4096)
    assert.equal(result.report.artifacts[0].resourceUsage.measurementSource, 'container-wrapper')
    assert.equal(result.report.artifacts[0].resourceUsage.authoritative, false)
    assert.equal(lstatSync(result.reportPath).mode & 0o077, 0)
    const commands = readFileSync(item.env.FAKE_DOCKER_CAPTURE, 'utf8').trim().split('\n').map(JSON.parse)
    const create = commands.find((args) => args[0] === 'create')
    const mount = create[create.indexOf('--mount') + 1]
    assert.doesNotMatch(mount, new RegExp(item.paper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const snapshotPath = mount.match(/source=([^,]+),target=/)[1]
    assert.equal(lstatSafe(snapshotPath), null)
    await assert.rejects(() => executeApprovedPlan(item.paper, plan.approval.token, { env: item.env }), /already been used/)
  } finally { item.cleanup() }
})

test('an explicit managed generation path executes with reports in its mutable overlay', async () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const published = createPublishedGeneration(item)
    const records = listManagedRecords({ libraryRoot: item.root })
    assert.equal(records.length, 1)
    assert.match(path.relative(records[0].recordDir, published.packageDir), /^sources\//)
    assert.equal(isContained(records[0].recordDir, published.packageDir), true)
    assert.equal(resolveExplicitPackage(published.packageDir, { libraryRoot: item.root }).mode, 'managed_generation_v1')
    const plan = buildExecutionPlan(published.packageDir, { env: item.env })
    assert.equal(plan.capability.status, 'ready')
    assert.match(plan.approval.token, /^[a-f0-9]{64}$/)
    const result = await executeApprovedPlan(published.packageDir, plan.approval.token, { env: item.env })
    assert.equal(result.exitCode, 0)
    assert.equal(result.report.generationBinding.phase, 'published')
    assert.match(result.report.generationBinding.manifestId, /^gm-sha256-[a-f0-9]{64}$/)
    assert.match(result.report.generationBinding.manifestHash, /^[a-f0-9]{64}$/)
    assert.match(result.report.generationBinding.manifestFileSha256, /^[a-f0-9]{64}$/)
    assert.match(path.relative(realpathSync(published.overlayDir), result.reportPath), /^execution-reports\//)
    assert.match(path.relative(realpathSync(published.overlayDir), result.reportPath), /gen-sha256-[a-f0-9]{64}/)
    assert.doesNotMatch(path.relative(realpathSync(published.overlayDir), result.reportPath), /:/)
  } finally { item.cleanup() }
})

test('explicit paths without a managed report target never receive approval', () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const explicit = path.join(item.root, 'explicit-paper')
    mkdirSync(path.join(explicit, 'code'), { recursive: true })
    writeFileSync(path.join(explicit, 'code', 'demo.py'), 'print("explicit")\n')
    const plan = buildExecutionPlan(explicit, { env: item.env })
    assert.equal(plan.capability.status, 'nonconformant')
    assert.equal(plan.approval, null)
    assert.match(plan.capability.reason, /generation workspace or managed published generation/)
  } finally { item.cleanup() }
})

test('abandoned workspace plans fail closed with a structured nonconformant capability', () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const recordPath = path.join(item.workspaceDir, 'workspace.json')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(recordPath, `${JSON.stringify({ ...record, state: 'abandoned' }, null, 2)}\n`)
    const plan = buildExecutionPlan(item.paper, { env: item.env })
    assert.equal(plan.capability.status, 'nonconformant')
    assert.equal(plan.approval, null)
    assert.match(plan.capability.reason, /Abandoned generation workspaces are read-only/)
  } finally { item.cleanup() }
})

test('approval is consumed when code changes or a different paper is selected', async () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const first = buildExecutionPlan(item.paper, { env: item.env })
    writeFileSync(path.join(item.paper, 'code', 'demo.py'), 'print("changed")\n')
    await assert.rejects(() => executeApprovedPlan(item.paper, first.approval.token, { env: item.env }), /does not match/)
    await assert.rejects(() => executeApprovedPlan(item.paper, first.approval.token, { env: item.env }), /already been used/)

    const secondPaper = path.join(item.root, 'second-paper')
    mkdirSync(path.join(secondPaper, 'code'), { recursive: true })
    writeFileSync(path.join(secondPaper, 'code', 'demo.py'), 'print("second")\n')
    const second = buildExecutionPlan(item.paper, { env: item.env })
    await assert.rejects(() => executeApprovedPlan(secondPaper, second.approval.token, { env: item.env }), /does not match/)
  } finally { item.cleanup() }
})

test('creating a plan removes expired private approval files', () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const expired = buildExecutionPlan(item.paper, { env: item.env })
    const expiredPath = path.join(item.env.CODEX_PAPER_SANDBOX_APPROVAL_DIR, `${expired.approval.token}.json`)
    const payload = JSON.parse(readFileSync(expiredPath, 'utf8'))
    payload.expiresAt = new Date(Date.now() - 1_000).toISOString()
    writeFileSync(expiredPath, JSON.stringify(payload), { mode: 0o600 })
    chmodSync(expiredPath, 0o600)

    const current = buildExecutionPlan(item.paper, { env: item.env })
    assert.equal(lstatSafe(expiredPath), null)
    assert.notEqual(lstatSafe(path.join(item.env.CODEX_PAPER_SANDBOX_APPROVAL_DIR, `${current.approval.token}.json`)), null)
  } finally { item.cleanup() }
})

test('concurrent approval use permits exactly one execution', async () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const plan = buildExecutionPlan(item.paper, { env: item.env })
    const settled = await Promise.allSettled([
      executeApprovedPlan(item.paper, plan.approval.token, { env: item.env }),
      executeApprovedPlan(item.paper, plan.approval.token, { env: item.env }),
    ])
    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1)
    assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 1)
    assert.match(settled.find((entry) => entry.status === 'rejected').reason.message, /already been used/)
  } finally { item.cleanup() }
})

test('expired approval, symlink code, and unsafe report path fail closed', async () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const expired = buildExecutionPlan(item.paper, { env: item.env })
    const approvalPath = path.join(item.env.CODEX_PAPER_SANDBOX_APPROVAL_DIR, `${expired.approval.token}.json`)
    const payload = JSON.parse(readFileSync(approvalPath, 'utf8'))
    payload.expiresAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(approvalPath, JSON.stringify(payload), { mode: 0o600 })
    await assert.rejects(() => executeApprovedPlan(item.paper, expired.approval.token, { env: item.env }), /expired/)

    const outside = path.join(item.root, 'outside')
    mkdirSync(outside)
    rmSync(path.join(item.paper, 'code'), { recursive: true })
    symlinkSync(outside, path.join(item.paper, 'code'))
    assert.throws(() => buildExecutionPlan(item.paper, { env: item.env }), /must be a real directory/)

    rmSync(path.join(item.paper, 'code'))
    mkdirSync(path.join(item.paper, 'code'))
    writeFileSync(path.join(item.paper, 'code', 'demo.py'), 'print("safe")\n')
    mkdirSync(path.join(item.paper, '.codex-paper'))
    symlinkSync(outside, path.join(item.paper, '.codex-paper', 'execution-reports'))
    const unsafe = buildExecutionPlan(item.paper, { env: item.env })
    await assert.rejects(() => executeApprovedPlan(item.paper, unsafe.approval.token, { env: item.env }), /report path is unsafe/)
  } finally { item.cleanup() }
})

test('stale image or policy stamp is nonconformant', () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env, { policyHash: 'stale' })
    const capability = getSandboxCapability({ env: item.env })
    assert.equal(capability.status, 'nonconformant')
    assert.match(capability.reason, /has not passed/)
  } finally { item.cleanup() }
})

test('code-tree file, symlink, count, and total-size boundaries fail before approval', () => {
  const item = fixture()
  try {
    writeConformanceStamp(item.env)
    const outside = path.join(item.root, 'outside.py')
    writeFileSync(outside, 'print("outside")\n')
    symlinkSync(outside, path.join(item.paper, 'code', 'linked.py'))
    assert.throws(() => buildExecutionPlan(item.paper, { env: item.env }), /must not be a symlink/)
    rmSync(path.join(item.paper, 'code', 'linked.py'))

    writeFileSync(path.join(item.paper, 'code', 'oversized.py'), Buffer.alloc(POLICY.limits.maxSourceFileBytes + 1))
    assert.throws(() => buildExecutionPlan(item.paper, { env: item.env }), /per-file source limit/)
    rmSync(path.join(item.paper, 'code', 'oversized.py'))

    for (let index = 0; index <= POLICY.limits.maxFiles; index += 1) writeFileSync(path.join(item.paper, 'code', `resource-${index}.txt`), 'x')
    assert.throws(() => buildExecutionPlan(item.paper, { env: item.env }), /file limit/)
  } finally { item.cleanup() }
})

test('failed first artifact skips later artifacts and records exit 4', async () => {
  const item = fixture()
  try {
    writeFileSync(path.join(item.paper, 'code', 'second.js'), 'console.log("second")\n')
    writeConformanceStamp(item.env)
    item.env.FAKE_DOCKER_CONTAINER_EXIT = '7'
    const plan = buildExecutionPlan(item.paper, { env: item.env })
    const result = await executeApprovedPlan(item.paper, plan.approval.token, { env: item.env })
    assert.equal(result.exitCode, 4)
    assert.deepEqual(result.report.artifacts.map((entry) => entry.outcome), ['failed', 'skipped'])
  } finally { item.cleanup() }
})

test('runner classifies bounded output and host wall timeout', async () => {
  const item = fixture()
  try {
    const artifact = buildExecutionPlan(item.paper, { env: { ...item.env, CODEX_PAPER_DOCKER_BIN: path.join(item.root, 'missing') }, issueApproval: false }).artifacts[0]
    const output = await runArtifactDocker(path.join(item.paper, 'code'), artifact, { env: { ...item.env, FAKE_DOCKER_OUTPUT_LIMIT: '1' } })
    assert.equal(output.outcome, 'output_limit')
    assert.equal(output.stdoutTruncated, true)
    const timeout = await runArtifactDocker(path.join(item.paper, 'code'), artifact, { env: { ...item.env, FAKE_DOCKER_DELAY_MS: '200' }, wallTimeMs: 30 })
    assert.equal(timeout.outcome, 'timeout')
  } finally { item.cleanup() }
})

test('runner fails closed when the named container cannot be removed', async () => {
  const item = fixture()
  try {
    const artifact = buildExecutionPlan(item.paper, { env: { ...item.env, CODEX_PAPER_DOCKER_BIN: path.join(item.root, 'missing') }, issueApproval: false }).artifacts[0]
    const result = await runArtifactDocker(path.join(item.paper, 'code'), artifact, { env: { ...item.env, FAKE_DOCKER_RM_FAIL: '1' } })
    assert.equal(result.outcome, 'sandbox_error')
    assert.match(result.stderr, /failed to remove sandbox container/)
  } finally { item.cleanup() }
})

test('runner rejects malformed or exit-mismatched resource measurements', async () => {
  const item = fixture()
  try {
    const artifact = buildExecutionPlan(item.paper, { env: { ...item.env, CODEX_PAPER_DOCKER_BIN: path.join(item.root, 'missing') }, issueApproval: false }).artifacts[0]
    const malformed = await runArtifactDocker(path.join(item.paper, 'code'), artifact, {
      env: { ...item.env, FAKE_DOCKER_RESOURCE_JSON: JSON.stringify({ wallTimeMs: 'spoofed', userCpuMs: 1, systemCpuMs: 1, maxRssKiB: 1, status: 0, injected: { value: true } }) },
    })
    assert.equal(malformed.resourceUsage, null)

    const mismatched = await runArtifactDocker(path.join(item.paper, 'code'), artifact, {
      env: { ...item.env, FAKE_DOCKER_RESOURCE_JSON: JSON.stringify({ wallTimeMs: 1, userCpuMs: 1, systemCpuMs: 1, maxRssKiB: 1, status: 7 }) },
    })
    assert.equal(mismatched.resourceUsage, null)
  } finally { item.cleanup() }
})

test('real conformance failures expose bounded container diagnostics', () => {
  const item = fixture()
  try {
    const result = spawnSync(process.execPath, [RUNNER, 'test'], {
      encoding: 'utf8',
      env: {
        ...item.env,
        FAKE_DOCKER_START_STATUS: '7',
        FAKE_DOCKER_CONTAINER_EXIT: '7',
        FAKE_DOCKER_STDERR: 'synthetic node startup failure',
      },
    })
    assert.equal(result.status, 3, result.stderr)
    assert.match(result.stderr, /Conformance failed for code\/conformance\.js/)
    assert.match(result.stderr, /outcome=failed exitCode=7 signal=none oomKilled=false/)
    assert.match(result.stderr, /stderr="synthetic node startup failure"/)
  } finally { item.cleanup() }
})

test('file-size conformance accepts Linux SIGXFSZ and caught write errors only', () => {
  assert.equal(fileSizeLimitActivated({ outcome: 'success', stdout: 'file limit activated\n' }), true)
  assert.equal(fileSizeLimitActivated({ outcome: 'failed', exitCode: 153, resourceUsage: { status: -25 } }), true)
  assert.equal(fileSizeLimitActivated({ outcome: 'failed', exitCode: 153, resourceUsage: null }), false)
  assert.equal(fileSizeLimitActivated({ outcome: 'failed', exitCode: 137, resourceUsage: { status: -9 } }), false)
})

test('Docker argv enforces isolation and fixed interpreter arguments without a shell', () => {
  const args = dockerCreateArgs({
    containerName: 'codex-paper-test',
    codeDir: '/tmp/paper/code',
    artifact: { runtime: 'python', filename: 'demo.py' },
  })
  for (const expected of ['--label', 'io.codex-paper.sandbox.execution=true', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '--memory', '--memory-swap', '--tmpfs', '--mount', '--user', '65532:65532']) {
    assert.ok(args.includes(expected), `missing ${expected}`)
  }
  assert.deepEqual(args.slice(-3), [POLICY.imageTag, 'python', 'demo.py'])
  assert.equal(args.includes('sh'), false)
  assert.equal(args.includes('-c'), false)
})

test('CLI reports unavailable with exit 3 and no approval token on this explicit missing-Docker path', () => {
  const item = fixture()
  try {
    const env = { ...item.env, CODEX_PAPER_DOCKER_BIN: path.join(item.root, 'missing-docker') }
    const status = spawnSync(process.execPath, [RUNNER, 'status', '--json'], { encoding: 'utf8', env })
    assert.equal(status.status, 3)
    assert.equal(JSON.parse(status.stdout).status, 'unavailable')
    const plan = spawnSync(process.execPath, [RUNNER, 'plan', item.paper, '--json'], { encoding: 'utf8', env })
    assert.equal(plan.status, 3)
    assert.equal(JSON.parse(plan.stdout).approval, null)
    const run = spawnSync(process.execPath, [RUNNER, 'run', item.paper, '--approval-token', 'a'.repeat(64)], { encoding: 'utf8', env })
    assert.equal(run.status, 3)
    assert.match(run.stderr, /sandbox_unavailable/)
  } finally { item.cleanup() }
})

function lstatSafe(file) {
  try { return lstatSync(file) } catch { return null }
}
