import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildGenerationManifest,
  readGenerationManifest,
  validateGenerationManifest,
  verifyGenerationManifest,
} from '../../../../src/shared/generation-manifest.mjs'
import {
  applyReadmeProjection,
  assertContentRuntime,
  authoringSummary,
  buildArtifactGraph,
  buildProvenanceDraft,
  collectRepositoryProvenance,
  collectRuntimeAttestation,
  defaultDependencies,
  deriveManifestId,
  manifestDiagnostics,
  readProvenanceDraft,
  recoverPendingAuthoringEvents,
  reportIntrinsicHash,
  resolveUnresolvedAuthoringEvent,
  runtimeGenerationContract,
  sanitizeSourceLocator,
  sha256,
  stableJson,
  validateProvenanceDraft,
  verifyReadmeProjection,
  writeAuthoringWithProvenance,
} from '../../../../src/shared/generation-provenance.mjs'
import { workspaceStorageLockKey } from '../../../../src/shared/paper-library.mjs'
import { withStorageLocksSync } from '../../../../src/shared/storage-transaction.mjs'
import {
  buildPaperIdentity,
  validatePaperIdentity,
} from '../paper-identity.js'
import {
  createValidationReport,
  validationReportIntrinsicHash,
} from '../validation-report.js'
import {
  resolveGenerationWorkspace,
  resolveWorkspaceAuthoringEvent,
} from '../../../../src/shared/generation-workspace.mjs'
import { formatCliError } from '../../../../src/shared/cli-error-format.mjs'

const SOURCE_BYTES = Buffer.from('%PDF-1.4\nsynthetic provenance fixture\n')
const SOURCE_SHA = sha256(SOURCE_BYTES)

function runtimeAttestation() {
  return collectRuntimeAttestation(process.env, {
    node: '22.23.1',
    npm: '10.9.8',
    python: {
      version: '3.11.15',
      implementation: 'CPython',
      pyMuPDF: '1.28.0',
    },
  })
}

function identity(overrides = {}) {
  return buildPaperIdentity({
    slug: 'provenance-fixture',
    sourceSha256: SOURCE_SHA,
    pages: [],
    workflow: 'study',
    language: 'en',
    contextMode: 'paper-only',
    requestedPaperProfile: 'empirical',
    parserBackend: 'pymupdf',
    parserBackendVersion: '1.28.0',
    runtimeContract: runtimeGenerationContract(runtimeAttestation()),
    authoringProvider: 'openai',
    authoringModel: 'test-model',
    pluginBuildVersion: '2.0.0+codex.test',
    platform: 'test-platform',
    createdAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  })
}

function fixture(t) {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-provenance-'))
  const workspaceId = `ws-${'a'.repeat(12)}-${'b'.repeat(12)}-${'c'.repeat(32)}`
  const workspaceDir = path.join(libraryRoot, '.codex-paper', 'workspaces-v1', workspaceId)
  const packageDir = path.join(workspaceDir, 'package')
  fs.mkdirSync(path.join(packageDir, '.codex-paper'), { recursive: true, mode: 0o700 })
  const paperIdentity = identity()
  const paperKey = `p-${'d'.repeat(64)}`
  const draft = buildProvenanceDraft({
    workspaceId,
    paperKey,
    sourceRevisionId: paperIdentity.sourceRevisionId,
    generationId: paperIdentity.generationId,
    identity: paperIdentity,
    runtime: runtimeAttestation(),
    source: {
      kind: 'local_file',
      requestedUrl: null,
      resolvedUrl: null,
      filename: 'fixture.pdf',
      bytes: SOURCE_BYTES.length,
      acquiredAt: '2026-07-30T00:00:00.000Z',
    },
    now: '2026-07-30T00:00:00.000Z',
  })
  fs.writeFileSync(path.join(workspaceDir, 'provenance-draft.json'), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(workspaceDir, 'workspace.json'), `${JSON.stringify({
    schemaVersion: '1.0.0',
    workspaceId,
    state: 'authoring',
    paperKey,
    paperId: paperIdentity.paperId,
    sourceRevisionId: paperIdentity.sourceRevisionId,
    generationId: paperIdentity.generationId,
    targetPackageRelativePath: `sources/${paperIdentity.sourceRevisionId.replace(':', '-')}/generations/${paperIdentity.generationId.replaceAll(':', '-')}/package`,
    routeSlug: 'provenance-fixture',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    lastSuccessfulStep: 'prepared',
    diagnostics: [],
    publishIntent: { paperRecord: {}, reconciliation: null, tags: [] },
  }, null, 2)}\n`, { mode: 0o600 })
  const workspace = {
    workspaceId,
    workspaceDir,
    packageDir,
    workspaceLockKey: workspaceStorageLockKey(workspaceId),
  }
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  return { libraryRoot, workspace, paperIdentity, draft, paperKey }
}

function writeCoreFiles(packageDir, paperIdentity, manifestId) {
  const files = {
    'paper.pdf': SOURCE_BYTES,
    'paper-data.json': '{}\n',
    'evidence-ledger.json': '{}\n',
    'facts.json': '{}\n',
    'analysis.json': '{}\n',
    'reasoning-analysis.json': '{}\n',
    'meta.json': `${JSON.stringify({ generationManifest: { schemaVersion: '2.0.0', manifestId } })}\n`,
    '.codex-paper/paper-identity.json': `${JSON.stringify(paperIdentity)}\n`,
  }
  for (const [relativePath, value] of Object.entries(files)) {
    const target = path.join(packageDir, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
}

test('runtime and declared authoring engine participate in generation identity', () => {
  const baseline = identity()
  assert.equal(runtimeAttestation().contentStatus, 'conformant')
  assert.equal(validatePaperIdentity(baseline).valid, true)
  assert.notEqual(identity({
    runtimeContract: { ...baseline.generation.inputs.runtimeContract, node: '22.23.2' },
  }).generationId, baseline.generationId)
  assert.notEqual(identity({ authoringModel: 'another-model' }).generationId, baseline.generationId)
  assert.equal(identity({
    pluginBuildVersion: '2.0.0+codex.other',
    createdAt: '2026-07-31T00:00:00.000Z',
    platform: 'another-platform',
  }).generationId, baseline.generationId)
})

test('nonconformant runtime reports each failed content check and remediation', () => {
  const attestation = runtimeAttestation()
  attestation.contentStatus = 'nonconformant'
  attestation.contentChecks = { node: false, python: true, pyMuPDF: false, parserPolicy: true }
  assert.throws(() => assertContentRuntime(attestation), (error) => {
    assert.equal(error.code, 'PROVENANCE_RUNTIME_NONCONFORMANT')
    assert.deepEqual(error.details.failedChecks, ['node', 'pyMuPDF'])
    assert.equal(error.details.expected.node, '22.23.1')
    assert.match(error.message, /runtime-status/)
    assert.match(error.message, /runtime-setup/)
    return true
  })
})

test('repository observation accepts only the exact Git toplevel', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-repository-'))
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0)
  assert.equal(spawnSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']).status, 0)
  assert.equal(spawnSync('git', ['-C', repository, 'config', 'user.name', 'Codex Paper Test']).status, 0)
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n')
  assert.equal(spawnSync('git', ['-C', repository, 'add', 'tracked.txt']).status, 0)
  assert.equal(spawnSync('git', ['-C', repository, 'commit', '-qm', 'fixture']).status, 0)
  assert.equal(collectRepositoryProvenance(repository).status, 'observed')
  const nested = path.join(repository, 'nested')
  fs.mkdirSync(nested)
  assert.deepEqual(collectRepositoryProvenance(nested), {
    commit: null,
    status: 'unavailable',
    treeState: 'unavailable',
  })
})

test('source provenance strips credentials, query values, fragments, and local paths', (t) => {
  const credentialLocator = ['https://user', 'secret@example.com/paper.pdf?token=hidden#fragment'].join(':')
  const sanitized = sanitizeSourceLocator(credentialLocator)
  assert.deepEqual(sanitized, {
    locator: 'https://example.com/paper.pdf',
    queryPresent: true,
    credentialsPresent: true,
  })
  const { draft } = fixture(t)
  assert.equal(draft.source.filename, 'fixture.pdf')
  assert.equal(JSON.stringify(draft).includes(os.tmpdir()), false)
  const remote = structuredClone(draft)
  remote.source.queryPresent = true
  assert.equal(manifestDiagnostics(remote).some((item) => item.code === 'SOURCE_LOCATOR_REDACTED'), true)
  const injected = structuredClone(draft)
  injected.source.localPath = '/Users/example/private/paper.pdf'
  assert.throws(() => validateProvenanceDraft(injected), { code: 'PROVENANCE_DRAFT_INVALID' })
  const unsafeLocator = structuredClone(draft)
  unsafeLocator.source.kind = 'remote_https'
  unsafeLocator.source.requestedLocator = credentialLocator
  unsafeLocator.source.resolvedLocator = 'https://example.com/paper.pdf'
  assert.throws(() => validateProvenanceDraft(unsafeLocator), { code: 'PROVENANCE_DRAFT_INVALID' })
})

test('CLI error formatting redacts messages, suppresses empty details, and keeps truncated details valid JSON', (t) => {
  const credentialUrl = ['https://user', 'password@example.com/paper.pdf?token=hidden#fragment'].join(':')
  const sensitiveError = Object.assign(
    new Error(`ENOENT at '/Users/example/private/paper.pdf' while fetching ${credentialUrl}`),
    {
      code: 'ENOENT',
      details: {
        path: '/Users/example/private/paper.pdf',
        accessToken: 'top-secret',
        source: credentialUrl,
      },
    },
  )
  const formatted = formatCliError(sensitiveError, 'CLI_FAILED')
  assert.equal(formatted.includes('/Users/example'), false)
  assert.equal(formatted.includes('password'), false)
  assert.equal(formatted.includes('top-secret'), false)
  assert.equal(formatted.includes('token=hidden'), false)
  assert.match(formatted, /https:\/\/example\.com\/paper\.pdf/)
  assert.match(formatted, /\[redacted-path\]/)
  assert.match(formatted, /"accessToken":"\[redacted\]"/)

  for (const embeddedPath of [
    'bracket[/Users/example/private/paper.pdf]',
    'comma,/Users/example/private/paper.pdf',
    'angle</Users/example/private/paper.pdf>',
    'double//Users/example/private/paper.pdf',
  ]) {
    const redacted = formatCliError(new Error(embeddedPath), 'CLI_FAILED')
    assert.equal(redacted.includes('/Users/example'), false)
    assert.match(redacted, /\[redacted-path\]/)
  }

  const formerPlaceholder = '__CODEX_SAFE_URL_0__'
  const collisionUrl = ['https://user', 'password@example.com/paper.pdf?token=hidden#fragment'].join(':')
  const collision = formatCliError(new Error(`${formerPlaceholder} ${collisionUrl}`), 'CLI_FAILED')
  assert.match(collision, /__CODEX_SAFE_URL_0__/)
  assert.match(collision, /https:\/\/example\.com\/paper\.pdf/)
  assert.equal(collision.includes('password'), false)
  assert.equal(collision.includes('token=hidden'), false)

  assert.equal(
    formatCliError({ code: 'WORKSPACE_NOT_FOUND', message: 'Not found.', details: {} }, 'CLI_FAILED'),
    'Error [WORKSPACE_NOT_FOUND]: Not found.',
  )
  const large = formatCliError({
    code: 'DETAILS_TOO_LARGE',
    message: 'Large details.',
    details: { values: Array.from({ length: 32 }, (_, index) => `${index}-${'x'.repeat(80)}`) },
  }, 'CLI_FAILED', 200, 160)
  const details = large.split('\n').find((line) => line.startsWith('Details: ')).slice('Details: '.length)
  assert.doesNotThrow(() => JSON.parse(details))
  assert.equal(JSON.parse(details).truncated, true)

  const circular = {}
  circular.self = circular
  assert.doesNotThrow(() => formatCliError({
    code: 'CIRCULAR_DETAILS',
    message: 'Circular details.',
    details: circular,
  }, 'CLI_FAILED'))

  const { libraryRoot, workspace } = fixture(t)
  fs.rmSync(path.join(workspace.workspaceDir, 'provenance-draft.json'))
  assert.throws(() => readProvenanceDraft(workspace), { code: 'PROVENANCE_DRAFT_MISSING' })
  const cli = fileURLToPath(new URL('../provenance-cli.js', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'inspect', workspace.workspaceId, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: libraryRoot },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /PROVENANCE_DRAFT_MISSING/)
  assert.equal(result.stderr.includes(libraryRoot), false)
})

test('provenance CLI inspects and verifies an exact workspace without selecting latest state', (t) => {
  const { libraryRoot, workspace, draft } = fixture(t)
  const cli = fileURLToPath(new URL('../provenance-cli.js', import.meta.url))
  for (const command of ['inspect', 'verify']) {
    const result = spawnSync(process.execPath, [cli, command, workspace.workspaceId, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PAPERS_DIR: libraryRoot },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.mode, 'workspace_draft')
    assert.equal(output.verified, true)
    assert.equal(output.manifestId, draft.manifestId)
  }

  const pending = readProvenanceDraft(workspace)
  const eventId = `ae-${'4'.repeat(32)}`
  pending.authoringEvents.push({
    sequence: 1,
    eventId,
    state: 'pending',
    actor: 'codex',
    attestation: 'declared',
    operation: 'create',
    path: 'summary.md',
    beforeSha256: null,
    afterSha256: sha256('intended\n'),
    dependencies: [],
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  fs.writeFileSync(path.join(workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(pending, null, 2)}\n`)
  const inspected = spawnSync(process.execPath, [cli, 'inspect', workspace.workspaceId, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: libraryRoot },
  })
  assert.equal(inspected.status, 0, inspected.stderr)
  assert.deepEqual(JSON.parse(inspected.stdout).pendingEvents, [{
    eventId,
    path: 'summary.md',
    state: 'pending',
    intendedSha256: sha256('intended\n'),
  }])
})

test('authoring writer records declared actor, dependencies, CAS hashes, and one README projection', (t) => {
  const { libraryRoot, workspace, paperIdentity, draft } = fixture(t)
  writeCoreFiles(workspace.packageDir, paperIdentity, draft.manifestId)
  const result = withStorageLocksSync([workspace.workspaceLockKey], (lockHandle) => writeAuthoringWithProvenance({
    workspace,
    relativePath: 'README.md',
    data: '# Study\n',
    precondition: { expectAbsent: true },
    actor: 'codex',
    additionalDependencies: ['paper-data.json'],
    lockHandle,
  }), { libraryRoot, timeoutMs: 0 })
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  const updated = readProvenanceDraft(workspace)
  assert.equal(updated.authoringEvents.length, 1)
  assert.equal(updated.authoringEvents[0].state, 'completed')
  assert.equal(updated.authoringEvents[0].actor, 'codex')
  assert.deepEqual(updated.authoringEvents[0].dependencies.map((item) => item.path), [
    'evidence-ledger.json', 'facts.json', 'paper-data.json', 'reasoning-analysis.json',
  ])
  const readme = fs.readFileSync(path.join(workspace.packageDir, 'README.md'), 'utf8')
  assert.equal((readme.match(/codex-paper-provenance:start/g) || []).length, 1)
  assert.equal(readme.includes(draft.manifestId), true)
  assert.equal(readme, applyReadmeProjection(readme, draft.manifestId))
  withStorageLocksSync([workspace.workspaceLockKey], (lockHandle) => {
    assert.throws(() => writeAuthoringWithProvenance({
      workspace,
      relativePath: 'summary.md',
      data: '# Summary\n',
      precondition: { expectAbsent: true },
      actor: 'codex',
      additionalDependencies: Array.from({ length: 64 }, (_, index) => `code/dependency-${index}.js`),
      lockHandle,
    }), { code: 'PROVENANCE_DEPENDENCY_LIMIT_EXCEEDED' })
    assert.throws(() => writeAuthoringWithProvenance({
      workspace,
      relativePath: 'summary.md',
      data: '# Summary\n',
      precondition: { expectAbsent: true },
      actor: 'system',
      lockHandle,
    }), { code: 'PROVENANCE_ACTOR_INVALID' })
  }, { libraryRoot, timeoutMs: 0 })
  const withAbortedAttempt = structuredClone(updated)
  withAbortedAttempt.authoringEvents.push({
    ...withAbortedAttempt.authoringEvents[0],
    sequence: 2,
    eventId: `ae-${'f'.repeat(32)}`,
    state: 'aborted',
    actor: 'human',
    completedAt: '2026-07-30T00:10:00.000Z',
  })
  const summary = authoringSummary(withAbortedAttempt)
  assert.equal(summary.status, 'human_involved')
  assert.equal(summary.events.length, 2)
  assert.equal(summary.lastEditedAt, updated.authoringEvents[0].completedAt)
})

test('visible authoring uses reasoning when present and the summary analysis fallback otherwise', (t) => {
  const { workspace, paperIdentity, draft } = fixture(t)
  writeCoreFiles(workspace.packageDir, paperIdentity, draft.manifestId)
  assert.equal(defaultDependencies('README.md', workspace.packageDir).includes('reasoning-analysis.json'), true)
  fs.rmSync(path.join(workspace.packageDir, 'reasoning-analysis.json'))
  assert.deepEqual(defaultDependencies('quick-summary.md', workspace.packageDir), [
    'analysis.json', 'evidence-ledger.json', 'facts.json',
  ])
})

test('artifact graph rejects cycles, missing nodes, source drift, and stale dependency hashes', () => {
  const files = [
    { path: 'paper.pdf', sha256: SOURCE_SHA, bytes: SOURCE_BYTES.length },
    { path: 'a.md', sha256: 'a'.repeat(64), bytes: 1 },
    { path: 'b.md', sha256: 'b'.repeat(64), bytes: 1 },
  ]
  const base = {
    source: { sha256: SOURCE_SHA },
    runtime: { policySha256: 'c'.repeat(64) },
    authoringEvents: [],
  }
  assert.throws(() => buildArtifactGraph(files, {
    ...base,
    authoringEvents: [{
      state: 'completed', path: 'a.md', afterSha256: 'a'.repeat(64),
      dependencies: [{ path: 'missing.md', sha256: 'd'.repeat(64) }],
    }],
  }), { code: 'PROVENANCE_GRAPH_INVALID' })
  assert.throws(() => buildArtifactGraph(files, {
    ...base,
    source: { sha256: 'f'.repeat(64) },
  }), { code: 'PROVENANCE_GRAPH_INVALID' })
  assert.throws(() => buildArtifactGraph(files, {
    ...base,
    authoringEvents: [{
      state: 'completed',
      path: 'a.md',
      afterSha256: 'a'.repeat(64),
      dependencies: [{ path: 'b.md', sha256: 'd'.repeat(64) }],
    }],
  }), (error) => {
    assert.equal(error.code, 'PROVENANCE_DEPENDENCY_STALE')
    assert.deepEqual(error.details, [{
      path: 'a.md',
      dependency: 'b.md',
      expectedSha256: 'd'.repeat(64),
      actualSha256: 'b'.repeat(64),
    }])
    assert.match(formatCliError(error, 'TEST_ERROR'), /"dependency":"b\.md"/)
    assert.equal(formatCliError(Object.assign(new Error('safe'), {
      code: 'TEST_ERROR',
      details: { path: '/private/tmp/secret', token: 'do-not-print' },
    }), 'TEST_ERROR').includes('do-not-print'), false)
    return true
  })
  assert.throws(() => buildArtifactGraph(files, {
    ...base,
    authoringEvents: [
      { state: 'completed', path: 'a.md', afterSha256: 'a'.repeat(64), dependencies: [{ path: 'b.md', sha256: 'b'.repeat(64) }] },
      { state: 'completed', path: 'b.md', afterSha256: 'b'.repeat(64), dependencies: [{ path: 'a.md', sha256: 'a'.repeat(64) }] },
    ],
  }), { code: 'PROVENANCE_GRAPH_INVALID' })
})

test('pending WAL events recover completed/aborted outcomes and require explicit audited adoption when ambiguous', async (t) => {
  const completedFixture = fixture(t)
  const completedPath = path.join(completedFixture.workspace.packageDir, 'summary.md')
  fs.writeFileSync(completedPath, 'after\n')
  const completedDraft = readProvenanceDraft(completedFixture.workspace)
  completedDraft.authoringEvents.push({
    sequence: 1,
    eventId: `ae-${'1'.repeat(32)}`,
    state: 'pending',
    actor: 'codex',
    attestation: 'declared',
    operation: 'create',
    path: 'summary.md',
    beforeSha256: null,
    afterSha256: sha256('after\n'),
    dependencies: [],
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  fs.writeFileSync(path.join(completedFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(completedDraft, null, 2)}\n`)
  withStorageLocksSync([completedFixture.workspace.workspaceLockKey], (lockHandle) => {
    assert.equal(recoverPendingAuthoringEvents(completedFixture.workspace, lockHandle).authoringEvents[0].state, 'completed')
  }, { libraryRoot: completedFixture.libraryRoot, timeoutMs: 0 })

  const abortedFixture = fixture(t)
  const abortedDraft = readProvenanceDraft(abortedFixture.workspace)
  abortedDraft.authoringEvents.push({
    ...completedDraft.authoringEvents[0],
    eventId: `ae-${'2'.repeat(32)}`,
    path: 'insights.md',
    afterSha256: sha256('intended\n'),
  })
  fs.writeFileSync(path.join(abortedFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(abortedDraft, null, 2)}\n`)
  withStorageLocksSync([abortedFixture.workspace.workspaceLockKey], (lockHandle) => {
    assert.equal(recoverPendingAuthoringEvents(abortedFixture.workspace, lockHandle).authoringEvents[0].state, 'aborted')
  }, { libraryRoot: abortedFixture.libraryRoot, timeoutMs: 0 })

  const ambiguousFixture = fixture(t)
  fs.writeFileSync(path.join(ambiguousFixture.workspace.packageDir, 'method.md'), 'out-of-band\n')
  const ambiguousDraft = readProvenanceDraft(ambiguousFixture.workspace)
  const eventId = `ae-${'3'.repeat(32)}`
  ambiguousDraft.authoringEvents.push({
    ...completedDraft.authoringEvents[0],
    eventId,
    path: 'method.md',
    afterSha256: sha256('intended\n'),
  })
  fs.writeFileSync(path.join(ambiguousFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(ambiguousDraft, null, 2)}\n`)
  withStorageLocksSync([ambiguousFixture.workspace.workspaceLockKey], (lockHandle) => {
    assert.throws(() => recoverPendingAuthoringEvents(ambiguousFixture.workspace, lockHandle), {
      code: 'PROVENANCE_EVENT_UNRESOLVED',
    })
    const resolved = resolveUnresolvedAuthoringEvent(ambiguousFixture.workspace, eventId, lockHandle)
    assert.deepEqual(resolved.authoringEvents.map((event) => event.state), ['aborted', 'completed'])
    assert.equal(resolved.authoringEvents[1].actor, 'unknown')
    assert.equal(resolved.authoringEvents[1].afterSha256, sha256('out-of-band\n'))
    assert.deepEqual(manifestDiagnostics(resolved).map((item) => item.code), [
      'AUTHORING_ACTOR_UNDECLARED',
      'AUTHORING_EVENT_ADOPTED',
      ...resolved.software.diagnostics.map((item) => item.code),
    ].sort())
  }, { libraryRoot: ambiguousFixture.libraryRoot, timeoutMs: 0 })

  const missingDependencyFixture = fixture(t)
  fs.writeFileSync(path.join(missingDependencyFixture.workspace.packageDir, 'method.md'), 'out-of-band\n')
  const missingDependencyDraft = readProvenanceDraft(missingDependencyFixture.workspace)
  missingDependencyDraft.authoringEvents.push({
    ...completedDraft.authoringEvents[0],
    eventId: `ae-${'5'.repeat(32)}`,
    path: 'method.md',
    afterSha256: sha256('intended\n'),
    dependencies: [{ path: 'facts.json', sha256: 'f'.repeat(64) }],
  })
  fs.writeFileSync(path.join(missingDependencyFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(missingDependencyDraft, null, 2)}\n`)
  withStorageLocksSync([missingDependencyFixture.workspace.workspaceLockKey], (lockHandle) => {
    assert.throws(
      () => resolveUnresolvedAuthoringEvent(missingDependencyFixture.workspace, `ae-${'5'.repeat(32)}`, lockHandle),
      (error) => {
        assert.equal(error.code, 'PROVENANCE_EVENT_UNRESOLVED')
        assert.equal(error.details.missingDependency, 'facts.json')
        return true
      },
    )
  }, { libraryRoot: missingDependencyFixture.libraryRoot, timeoutMs: 0 })

  const wrapperFixture = fixture(t)
  fs.writeFileSync(path.join(wrapperFixture.workspace.packageDir, 'method.md'), 'out-of-band\n')
  const wrapperDraft = readProvenanceDraft(wrapperFixture.workspace)
  const wrapperEventId = `ae-${'6'.repeat(32)}`
  wrapperDraft.authoringEvents.push({
    ...completedDraft.authoringEvents[0],
    eventId: wrapperEventId,
    path: 'method.md',
    afterSha256: sha256('intended\n'),
  })
  fs.writeFileSync(path.join(wrapperFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(wrapperDraft, null, 2)}\n`)
  const wrapperRecordPath = path.join(wrapperFixture.workspace.workspaceDir, 'workspace.json')
  const wrapperRecord = JSON.parse(fs.readFileSync(wrapperRecordPath, 'utf8'))
  wrapperRecord.state = 'validated'
  fs.writeFileSync(wrapperRecordPath, `${JSON.stringify(wrapperRecord, null, 2)}\n`)
  await assert.rejects(
    resolveWorkspaceAuthoringEvent(wrapperFixture.workspace.workspaceId, wrapperEventId, {
      libraryRoot: wrapperFixture.libraryRoot,
      lockTimeoutMs: 0,
      faultAt: 'after_authoring_demotion',
    }),
    { code: 'WORKSPACE_FAULT_INJECTED' },
  )
  assert.equal(resolveGenerationWorkspace(wrapperFixture.workspace.workspaceId, {
    libraryRoot: wrapperFixture.libraryRoot,
  }).workspace.state, 'authoring')
  assert.equal(readProvenanceDraft(wrapperFixture.workspace).authoringEvents[0].state, 'pending')
  const adopted = await resolveWorkspaceAuthoringEvent(wrapperFixture.workspace.workspaceId, wrapperEventId, {
    libraryRoot: wrapperFixture.libraryRoot,
    lockTimeoutMs: 0,
  })
  assert.equal(adopted.state, 'authoring')
  assert.equal(adopted.diagnostic, 'AUTHORING_EVENT_ADOPTED')

  const cliFixture = fixture(t)
  fs.writeFileSync(path.join(cliFixture.workspace.packageDir, 'method.md'), 'out-of-band\n')
  const cliDraft = readProvenanceDraft(cliFixture.workspace)
  const cliEventId = `ae-${'7'.repeat(32)}`
  cliDraft.authoringEvents.push({
    ...completedDraft.authoringEvents[0],
    eventId: cliEventId,
    path: 'method.md',
    afterSha256: sha256('intended\n'),
  })
  fs.writeFileSync(path.join(cliFixture.workspace.workspaceDir, 'provenance-draft.json'), `${JSON.stringify(cliDraft, null, 2)}\n`)
  const workspaceCli = fileURLToPath(new URL('../workspace-cli.js', import.meta.url))
  const cliResult = spawnSync(process.execPath, [
    workspaceCli, 'resolve-event', cliFixture.workspace.workspaceId, '--adopt-current', cliEventId, '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: cliFixture.libraryRoot },
  })
  assert.equal(cliResult.status, 0, cliResult.stderr)
  assert.equal(JSON.parse(cliResult.stdout).diagnostic, 'AUTHORING_EVENT_ADOPTED')
  assert.equal(resolveGenerationWorkspace(cliFixture.workspace.workspaceId, {
    libraryRoot: cliFixture.libraryRoot,
  }).workspace.state, 'authoring')
})

test('Manifest 2.0 seals complete provenance and detects intrinsic drift', (t) => {
  const { libraryRoot, workspace, paperIdentity, draft, paperKey } = fixture(t)
  writeCoreFiles(workspace.packageDir, paperIdentity, draft.manifestId)
  withStorageLocksSync([workspace.workspaceLockKey], (lockHandle) => writeAuthoringWithProvenance({
    workspace,
    relativePath: 'README.md',
    data: '# Study\n',
    precondition: { expectAbsent: true },
    actor: 'codex',
    lockHandle,
  }), { libraryRoot, timeoutMs: 0 })
  const report = createValidationReport({ phase: 'complete', generatedAt: '2026-07-30T00:20:00.000Z' })
  assert.equal(report.reportHash.value, validationReportIntrinsicHash(report))
  fs.writeFileSync(path.join(workspace.packageDir, '.codex-paper/validation-report.json'), `${JSON.stringify(report)}\n`)
  const execution = {
    executionReportVersion: '2.0.0',
    executionId: 'exec-provenance-fixture',
    generatedAt: '2026-07-30T00:30:00.000Z',
    policyVersion: '1.0.0',
    backend: { kind: 'docker', imageId: 'sha256:test-image' },
    outcome: 'pass',
    generationBinding: {
      phase: 'preseal',
      manifestId: draft.manifestId,
      generationId: paperIdentity.generationId,
    },
  }
  execution.reportHash = { algorithm: 'sha256', value: reportIntrinsicHash(execution) }
  fs.mkdirSync(path.join(workspace.packageDir, '.codex-paper/execution-reports'))
  fs.writeFileSync(
    path.join(workspace.packageDir, '.codex-paper/execution-reports/execution.json'),
    `${JSON.stringify(execution)}\n`,
  )
  const manifest = buildGenerationManifest({
    packageDir: workspace.packageDir,
    transactionId: `pub-${'f'.repeat(32)}`,
    paperKey,
    identity: paperIdentity,
    validationReport: report,
    provenanceDraft: readProvenanceDraft(workspace),
    sealedAt: '2026-07-30T01:00:00.000Z',
  })
  assert.equal(manifest.schemaVersion, '2.0.0')
  assert.equal(manifest.manifestId, deriveManifestId({
    paperKey,
    sourceRevisionId: paperIdentity.sourceRevisionId,
    generationId: paperIdentity.generationId,
  }))
  assert.equal(manifest.integrity.signature.status, 'unsigned')
  assert.equal(manifest.authoring.status, 'codex_only')
  assert.equal(manifest.executions.atSeal.length, 1)
  assert.equal(manifest.executions.atSeal[0].reportHash, execution.reportHash.value)
  assert.equal(validateGenerationManifest(manifest), manifest)
  const missingDiagnostic = structuredClone(manifest)
  missingDiagnostic.authoring.events[0].actor = 'unknown'
  missingDiagnostic.authoring.status = 'unknown'
  const { manifestHash: ignoredDiagnosticHash, ...missingDiagnosticIntrinsic } = missingDiagnostic
  missingDiagnostic.manifestHash = sha256(stableJson(missingDiagnosticIntrinsic))
  assert.throws(() => validateGenerationManifest(missingDiagnostic), { code: 'GENERATION_MANIFEST_INVALID' })
  assert.throws(() => validateGenerationManifest({ ...manifest, sealedAt: '2026-07-30T02:00:00.000Z' }), { code: 'GENERATION_MANIFEST_INVALID' })
  const manifestPath = path.join(workspace.packageDir, '.codex-paper/generation-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const bindingFor = (value) => ({
    manifestId: value.manifestId,
    manifestHash: value.manifestHash,
    manifestFileSha256: sha256(fs.readFileSync(manifestPath)),
    paperKey,
    generationId: paperIdentity.generationId,
  })
  assert.equal(verifyGenerationManifest(workspace.packageDir, bindingFor(manifest))
    .manifest.manifestId, manifest.manifestId)

  const writeReboundManifest = (value) => {
    const rebound = structuredClone(value)
    rebound.artifacts.graph = buildArtifactGraph(rebound.files, {
      source: rebound.source,
      runtime: rebound.runtime,
      authoringEvents: rebound.authoring.events,
    })
    const { manifestHash: ignored, ...intrinsic } = rebound
    rebound.manifestHash = sha256(stableJson(intrinsic))
    fs.writeFileSync(manifestPath, `${JSON.stringify(rebound, null, 2)}\n`)
    return rebound
  }
  const updateInventory = (value, relativePath, bytes) => {
    const item = value.files.find((entry) => entry.path === relativePath)
    item.bytes = bytes.length
    item.sha256 = sha256(bytes)
    return item.sha256
  }

  const driftedValidation = structuredClone(report)
  driftedValidation.status = 'pass_with_warnings'
  const validationBytes = Buffer.from(`${JSON.stringify(driftedValidation)}\n`)
  fs.writeFileSync(path.join(workspace.packageDir, '.codex-paper/validation-report.json'), validationBytes)
  const validationManifest = structuredClone(manifest)
  validationManifest.validation.status = driftedValidation.status
  validationManifest.validation.fileSha256 = updateInventory(
    validationManifest,
    '.codex-paper/validation-report.json',
    validationBytes,
  )
  const reboundValidationManifest = writeReboundManifest(validationManifest)
  assert.throws(
    () => verifyGenerationManifest(workspace.packageDir, bindingFor(reboundValidationManifest)),
    { code: 'GENERATION_MANIFEST_DIRTY' },
  )

  const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`)
  fs.writeFileSync(path.join(workspace.packageDir, '.codex-paper/validation-report.json'), reportBytes)
  const driftedExecution = structuredClone(execution)
  driftedExecution.generationBinding.generationId = `gen:sha256:${'9'.repeat(64)}`
  const executionBytes = Buffer.from(`${JSON.stringify(driftedExecution)}\n`)
  fs.writeFileSync(path.join(workspace.packageDir, '.codex-paper/execution-reports/execution.json'), executionBytes)
  const executionManifest = structuredClone(manifest)
  executionManifest.validation.fileSha256 = updateInventory(
    executionManifest,
    '.codex-paper/validation-report.json',
    reportBytes,
  )
  const executionFileSha = updateInventory(
    executionManifest,
    '.codex-paper/execution-reports/execution.json',
    executionBytes,
  )
  executionManifest.executions.atSeal[0].fileSha256 = executionFileSha
  const reboundExecutionManifest = writeReboundManifest(executionManifest)
  assert.throws(
    () => verifyGenerationManifest(workspace.packageDir, bindingFor(reboundExecutionManifest)),
    { code: 'GENERATION_MANIFEST_DIRTY' },
  )
})

test('missing README projection is reported as a provenance projection error', (t) => {
  const { workspace, draft } = fixture(t)
  assert.throws(
    () => verifyReadmeProjection(workspace.packageDir, draft.manifestId),
    { code: 'PROVENANCE_PROJECTION_INVALID' },
  )
  fs.writeFileSync(path.join(workspace.packageDir, 'README.md'), applyReadmeProjection('# Study\n', draft.manifestId))
  assert.throws(
    () => verifyReadmeProjection(workspace.packageDir, draft.manifestId),
    { code: 'PROVENANCE_PROJECTION_INVALID' },
  )
})

test('Manifest 1.0 remains compatible and zero-write while unknown versions fail closed', (t) => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-manifest-legacy-'))
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const file = { path: 'meta.json', sha256: sha256('{}\n'), bytes: 3 }
  fs.writeFileSync(path.join(packageDir, 'meta.json'), '{}\n')
  const intrinsic = {
    schemaVersion: '1.0.0',
    manifestId: '',
    transactionState: 'sealed',
    transactionId: `pub-${'a'.repeat(32)}`,
    paperKey: `p-${'b'.repeat(64)}`,
    paperId: 'source:sha256:test',
    sourceRevisionId: `sha256:${'c'.repeat(64)}`,
    generationId: `gen:sha256:${'d'.repeat(64)}`,
    sourceSha256: 'c'.repeat(64),
    generationFingerprint: 'd'.repeat(64),
    validation: { schemaVersion: '1.0.0', status: 'pass', reportHash: 'e'.repeat(64) },
    sealedAt: '2026-07-30T00:00:00.000Z',
    files: [file],
  }
  intrinsic.manifestId = `gm-sha256-${sha256(stableJson({
    paperKey: intrinsic.paperKey,
    generationId: intrinsic.generationId,
    validationReportHash: intrinsic.validation.reportHash,
  }))}`
  const legacy = { ...intrinsic, manifestHash: sha256(stableJson(intrinsic)) }
  const manifestPath = path.join(packageDir, '.codex-paper/generation-manifest.json')
  fs.mkdirSync(path.dirname(manifestPath))
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`)
  const before = fs.statSync(manifestPath)
  const beforeHash = sha256(fs.readFileSync(manifestPath))
  assert.equal(readGenerationManifest(packageDir).schemaVersion, '1.0.0')
  const after = fs.statSync(manifestPath)
  assert.equal(sha256(fs.readFileSync(manifestPath)), beforeHash)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.throws(() => validateGenerationManifest({ schemaVersion: '9.0.0' }), { code: 'GENERATION_MANIFEST_VERSION_UNSUPPORTED' })
  assert.throws(() => validateProvenanceDraft({ schemaVersion: '9.0.0' }), { code: 'PROVENANCE_DRAFT_INVALID' })
})
