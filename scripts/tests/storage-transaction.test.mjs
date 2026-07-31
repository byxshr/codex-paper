import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  StorageTransactionError,
  acquireStorageLocks,
  atomicRemoveFile,
  atomicWriteFile,
  normalizeLockKeys,
  storageCliExitCode,
  storageLockPath,
  withStorageLocks,
} from '../../plugins/codex-paper/src/shared/storage-transaction.mjs'
import {
  abandonGenerationWorkspace,
  createGenerationWorkspace,
  listGenerationWorkspaces,
  resolveGenerationWorkspace,
  updateWorkspaceRecord,
  writeWorkspaceAuthoring,
} from '../../plugins/codex-paper/src/shared/generation-workspace.mjs'
import { replaceWorkspaceJson, withWorkspaceMutationSync } from '../../plugins/codex-paper/src/shared/workspace-writer.mjs'
import { resolveExplicitPackage } from '../../plugins/codex-paper/src/shared/paper-library.mjs'
import {
  collectRuntimeAttestation,
  collectSoftwareProvenance,
} from '../../plugins/codex-paper/src/shared/generation-provenance.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const holderScript = path.join(repoRoot, 'scripts/tests/helpers/storage-lock-holder.mjs')
const prepareScript = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
const workspaceCli = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/workspace-cli.js')
const fixturePdf = path.join(repoRoot, 'benchmarks/fixtures/pdf/front-matter-noise.pdf')

function directIdentity(paperId, sourceRevisionId, generationId) {
  return {
    schemaVersion: '2.0.0',
    paperId,
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
}

function directProvenance(identity) {
  return {
    runtime: collectRuntimeAttestation(process.env, {
      node: '22.23.1',
      npm: '10.9.8',
      python: { version: '3.11.15', implementation: 'CPython', pyMuPDF: '1.28.0' },
    }),
    source: {
      kind: 'local_file',
      filename: 'synthetic.pdf',
      bytes: 64,
      acquiredAt: '2026-07-30T00:00:00.000Z',
    },
    software: collectSoftwareProvenance(identity),
    identity,
  }
}

test('shared storage CLI exit mapping distinguishes policy, conflict, and operation failures', () => {
  assert.equal(storageCliExitCode({ code: 'ARGUMENT_INVALID' }), 2)
  assert.equal(storageCliExitCode({ code: 'WORKSPACE_WRITE_PATH_FORBIDDEN', statusCode: 403 }), 2)
  assert.equal(storageCliExitCode({ code: 'STORAGE_LOCK_CONFLICT', statusCode: 409 }), 3)
  assert.equal(storageCliExitCode({ code: 'WORKSPACE_EXISTS', statusCode: 409 }), 3)
  assert.equal(storageCliExitCode({ code: 'BACKUP_RESTORE_CONFLICT', statusCode: 409 }), 3)
  assert.equal(storageCliExitCode({ code: 'PUBLICATION_IDENTITY_CONFLICT', statusCode: 409 }), 1)
  assert.equal(storageCliExitCode({ code: 'PUBLICATION_RECOVERY_FAILED', statusCode: 409 }), 1)
  assert.equal(storageCliExitCode({ code: 'PDF_PARSE_FAILED' }), 1)
})

function temporaryLibrary(t) {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-storage-'))
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  return libraryRoot
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${output}`)), 5000)
    stream.on('data', (chunk) => {
      output += chunk
      if (output.includes(expected)) { clearTimeout(timeout); resolve(output) }
    })
  })
}

function prepareWorkspace(libraryRoot, input = fixturePdf) {
  const result = spawnSync(process.execPath, [prepareScript, input, '--workflow', 'study', '--language', 'en', '--context', 'paper-only', '--profile', 'auto'], {
    encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }, timeout: 30_000
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('lock keys have a fixed hierarchy independent of caller order', () => {
  assert.deepEqual(normalizeLockKeys(['index', 'generation:p:g', 'paper:p', 'registry', 'workspace:w', 'source:p:s']), [
    'registry', 'paper:p', 'source:p:s', 'generation:p:g', 'workspace:w', 'index'
  ])
})

test('cross-process lock conflicts fail fast and release permits the next owner', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const child = spawn(process.execPath, [holderScript, 'paper:test'], { env: { ...process.env, PAPERS_DIR: libraryRoot }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (!child.killed) child.kill('SIGKILL') })
  await waitForLine(child.stdout, 'ready')
  await assert.rejects(acquireStorageLocks(['paper:test'], { libraryRoot, timeoutMs: 0 }), (error) => error instanceof StorageTransactionError && error.code === 'STORAGE_LOCK_CONFLICT')
  child.stdin.write('release\n')
  await new Promise((resolve) => child.once('exit', resolve))
  const handle = await acquireStorageLocks(['paper:test'], { libraryRoot, timeoutMs: 1000 })
  handle.release()
})

test('partial lock acquisition rolls back before bounded retry', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const child = spawn(process.execPath, [holderScript, 'source:test:s'], { env: { ...process.env, PAPERS_DIR: libraryRoot }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (!child.killed) child.kill('SIGKILL') })
  await waitForLine(child.stdout, 'ready')
  await assert.rejects(acquireStorageLocks(['paper:test', 'source:test:s'], { libraryRoot, timeoutMs: 75 }), { code: 'STORAGE_LOCK_TIMEOUT' })
  const paper = await acquireStorageLocks(['paper:test'], { libraryRoot, timeoutMs: 0 })
  paper.release()
  child.stdin.write('release\n')
  await new Promise((resolve) => child.once('exit', resolve))
})

test('exceptional partial acquisition and release errors still release every unaffected lock', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const corruptSource = storageLockPath('source:test:corrupt', { libraryRoot })
  fs.mkdirSync(corruptSource, { mode: 0o700 })
  fs.writeFileSync(path.join(corruptSource, 'owner.json'), '{invalid')
  await assert.rejects(acquireStorageLocks(['paper:test', 'source:test:corrupt'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_CORRUPT' })
  const rolledBack = await acquireStorageLocks(['paper:test'], { libraryRoot, timeoutMs: 0 })
  rolledBack.release()

  const handle = await acquireStorageLocks(['paper:release', 'source:release:item'], { libraryRoot, timeoutMs: 0 })
  fs.writeFileSync(path.join(storageLockPath('source:release:item', { libraryRoot }), 'owner.json'), '{invalid')
  assert.throws(() => handle.release(), { code: 'STORAGE_LOCK_CORRUPT' })
  const remainingWasReleased = await acquireStorageLocks(['paper:release'], { libraryRoot, timeoutMs: 0 })
  remainingWasReleased.release()
})

test('dead same-host lock owners are reclaimed but foreign owners are not', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const child = spawn(process.execPath, [holderScript, 'paper:dead'], { env: { ...process.env, PAPERS_DIR: libraryRoot }, stdio: ['pipe', 'pipe', 'pipe'] })
  await waitForLine(child.stdout, 'ready')
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  const reclaimed = await acquireStorageLocks(['paper:dead'], { libraryRoot, timeoutMs: 1000 })
  reclaimed.release()

  const foreignPath = storageLockPath('paper:foreign', { libraryRoot })
  fs.mkdirSync(foreignPath, { mode: 0o700 })
  fs.writeFileSync(path.join(foreignPath, 'owner.json'), JSON.stringify({
    schemaVersion: '1.0.0', key: 'paper:foreign', token: crypto.randomBytes(32).toString('hex'), pid: 999999,
    hostname: 'another-host', acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString()
  }))
  await assert.rejects(acquireStorageLocks(['paper:foreign'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_CONFLICT' })
})

test('dead reclaim guards are themselves recoverable without poisoning the lock key', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const key = 'paper:dead-reclaim-guard'
  const lockDir = storageLockPath(key, { libraryRoot })
  const staleOwner = (ownerKey) => ({
    schemaVersion: '1.0.0', key: ownerKey, token: crypto.randomBytes(32).toString('hex'), pid: 999999,
    hostname: os.hostname(), acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString()
  })
  fs.mkdirSync(lockDir, { mode: 0o700 })
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(staleOwner(key)), { mode: 0o600 })
  fs.mkdirSync(`${lockDir}.reclaim`, { mode: 0o700 })
  fs.writeFileSync(path.join(`${lockDir}.reclaim`, 'owner.json'), JSON.stringify(staleOwner(`reclaim:${path.basename(lockDir)}`)), { mode: 0o600 })
  const reclaimed = await acquireStorageLocks([key], { libraryRoot, timeoutMs: 1000 })
  reclaimed.release()
  assert.equal(fs.existsSync(`${lockDir}.reclaim`), false)
})

test('corrupt and symlink lock records fail closed without reclamation', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const initializingPath = storageLockPath('paper:initializing', { libraryRoot })
  fs.mkdirSync(initializingPath, { mode: 0o700 })
  await assert.rejects(acquireStorageLocks(['paper:initializing'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_CONFLICT' })

  const missingOwnerPath = storageLockPath('paper:missing-owner', { libraryRoot })
  fs.mkdirSync(missingOwnerPath, { mode: 0o700 })
  const old = new Date(Date.now() - 5_000)
  fs.utimesSync(missingOwnerPath, old, old)
  await assert.rejects(acquireStorageLocks(['paper:missing-owner'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_CORRUPT' })

  const corruptPath = storageLockPath('paper:corrupt', { libraryRoot })
  fs.mkdirSync(corruptPath, { mode: 0o700 })
  fs.writeFileSync(path.join(corruptPath, 'owner.json'), '{invalid')
  await assert.rejects(acquireStorageLocks(['paper:corrupt'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_CORRUPT' })

  const external = path.join(libraryRoot, 'external-lock')
  fs.mkdirSync(external)
  const linkPath = storageLockPath('paper:linked', { libraryRoot })
  fs.symlinkSync(external, linkPath)
  await assert.rejects(acquireStorageLocks(['paper:linked'], { libraryRoot, timeoutMs: 0 }), { code: 'STORAGE_LOCK_UNSAFE' })
})

test('shared writer enforces lock ownership, CAS, containment, and symlink rejection', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const root = path.join(libraryRoot, 'root')
  fs.mkdirSync(root)
  assert.throws(() => atomicWriteFile({ root, relativePath: 'a.txt', data: 'one', requiredLock: 'paper:test', expectAbsent: true }), { code: 'STORAGE_LOCK_REQUIRED' })
  await withStorageLocks(['paper:test'], async (lockHandle) => {
    assert.throws(() => atomicWriteFile({ root, relativePath: 'missing-precondition.txt', data: 'x', lockHandle, requiredLock: 'paper:test' }), { code: 'WRITE_PRECONDITION_REQUIRED' })
    assert.throws(() => atomicWriteFile({ root, relativePath: 'ambiguous-precondition.txt', data: 'x', lockHandle, requiredLock: 'paper:test', expectAbsent: true, expectedSha256: '0'.repeat(64) }), { code: 'WRITE_PRECONDITION_INVALID' })
    const first = atomicWriteFile({ root, relativePath: 'a.txt', data: 'one', lockHandle, requiredLock: 'paper:test', expectAbsent: true })
    assert.throws(() => atomicRemoveFile({ root, relativePath: 'a.txt', lockHandle, requiredLock: 'paper:test' }), { code: 'WRITE_PRECONDITION_REQUIRED' })
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one')
    assert.throws(() => atomicWriteFile({ root, relativePath: 'a.txt', data: 'two', lockHandle, requiredLock: 'paper:test', expectedSha256: '0'.repeat(64) }), { code: 'WRITE_PRECONDITION_FAILED' })
    assert.throws(() => atomicRemoveFile({ root, relativePath: 'a.txt', lockHandle, requiredLock: 'paper:test', expectedSha256: '0'.repeat(64) }), { code: 'WRITE_PRECONDITION_FAILED' })
    atomicWriteFile({ root, relativePath: 'a.txt', data: 'two', lockHandle, requiredLock: 'paper:test', expectedSha256: first.sha256 })
    assert.throws(() => atomicWriteFile({ root, relativePath: '../escape', data: 'x', lockHandle, requiredLock: 'paper:test', expectAbsent: true }), { code: 'STORAGE_PATH_ESCAPE' })
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'))
    assert.throws(() => atomicWriteFile({ root, relativePath: 'link.txt', data: 'x', lockHandle, requiredLock: 'paper:test', expectedSha256: first.sha256 }), { code: 'STORAGE_PATH_UNSAFE' })
  }, { libraryRoot, timeoutMs: 0 })
})

test('prepare creates a private exact workspace without publishing record, current, or index', (t) => {
  const libraryRoot = temporaryLibrary(t)
  const result = prepareWorkspace(libraryRoot)
  assert.equal(result.action, 'workspace_created')
  assert.match(result.workspaceId, /^ws-/)
  assert.equal(fs.existsSync(path.join(libraryRoot, 'index.json')), false)
  assert.equal(fs.existsSync(path.join(libraryRoot, '.codex-paper/store-v1')), false)
  const workspaces = listGenerationWorkspaces({ libraryRoot })
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].packageDir, fs.realpathSync(result.paperDir))
  assert.equal(fs.readFileSync(path.join(result.workspaceDir, 'workspace.json'), 'utf8').includes(fs.realpathSync(libraryRoot)), false)
  fs.writeFileSync(path.join(libraryRoot, '.codex-paper/workspaces-v1/.DS_Store'), 'finder metadata')
  fs.writeFileSync(path.join(libraryRoot, '.codex-paper/workspaces-v1/Thumbs.db'), 'windows metadata')
  fs.writeFileSync(path.join(libraryRoot, '.codex-paper/workspaces-v1/._workspace'), 'apple metadata')
  assert.equal(listGenerationWorkspaces({ libraryRoot }).length, 1)
  const duplicate = spawnSync(process.execPath, [prepareScript, fixturePdf, '--workflow', 'study', '--language', 'en', '--context', 'paper-only', '--profile', 'auto'], {
    encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }, timeout: 30_000
  })
  assert.equal(duplicate.status, 3)
  assert.match(duplicate.stderr, /WORKSPACE_EXISTS/)
})

test('workspace initialization failure is preserved as a failed exact workspace', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const paperKey = `p-${'a'.repeat(64)}`
  const sourceRevisionId = `sha256:${'b'.repeat(64)}`
  const generationId = `gen:sha256:${'c'.repeat(64)}`
  const originalRename = fs.renameSync
  let injected = false
  fs.renameSync = function (from, to) {
    if (!injected && path.basename(from).startsWith('.init-ws-') && path.basename(to).startsWith('ws-')) {
      injected = true
      const error = new Error('synthetic workspace publish failure')
      error.code = 'EBUSY'
      throw error
    }
    return originalRename.apply(this, arguments)
  }
  try {
    const identity = directIdentity(`source:${sourceRevisionId}`, sourceRevisionId, generationId)
    await assert.rejects(createGenerationWorkspace({
      identity,
      routeSlug: 'failure-preserved',
      paperRecord: { paperKey },
      provenance: directProvenance(identity),
      libraryRoot,
      populate: async ({ packageDir }) => { fs.writeFileSync(path.join(packageDir, 'prepared.txt'), 'complete') },
    }), /synthetic workspace publish failure/)
  } finally {
    fs.renameSync = originalRename
  }
  const workspaces = listGenerationWorkspaces({ libraryRoot })
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].workspace.state, 'failed')
  assert.equal(workspaces[0].workspace.lastSuccessfulStep, 'initialization_failed')
  assert.equal(fs.readFileSync(path.join(workspaces[0].packageDir, 'prepared.txt'), 'utf8'), 'complete')
})

test('double rename and pre-rename crash residues remain discoverable, read-only, and do not block retry', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const paperKey = `p-${'d'.repeat(64)}`
  const sourceRevisionId = `sha256:${'e'.repeat(64)}`
  const generationId = `gen:sha256:${'f'.repeat(64)}`
  const identity = directIdentity(`source:${sourceRevisionId}`, sourceRevisionId, generationId)
  const originalRename = fs.renameSync
  let injected = 0
  fs.renameSync = function (from, to) {
    if (injected < 2 && path.basename(from).startsWith('.init-ws-') && path.basename(to).startsWith('ws-')) {
      injected += 1
      const error = new Error(`synthetic workspace rename failure ${injected}`)
      error.code = 'EBUSY'
      throw error
    }
    return originalRename.apply(this, arguments)
  }
  let failure
  try {
    await createGenerationWorkspace({
      identity,
      routeSlug: 'double-failure-preserved',
      paperRecord: { paperKey },
      provenance: directProvenance(identity),
      libraryRoot,
      populate: async ({ packageDir }) => { fs.writeFileSync(path.join(packageDir, 'prepared.txt'), 'complete') },
    })
  } catch (error) {
    failure = error
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(failure?.code, 'WORKSPACE_INITIALIZATION_FAILED')
  assert.equal(failure?.details?.preserved, true)
  assert.match(failure?.message || '', /Inspect it by exact workspace ID/)
  const failed = listGenerationWorkspaces({ libraryRoot })
  assert.equal(failed.length, 1)
  assert.equal(failed[0].workspace.state, 'failed')
  assert.match(path.basename(failed[0].workspaceDir), /^\.init-/)
  assert.equal(resolveGenerationWorkspace(failed[0].workspaceId, { libraryRoot }).workspaceDir, failed[0].workspaceDir)
  assert.equal(resolveExplicitPackage(failed[0].packageDir, { libraryRoot }).workspaceId, failed[0].workspaceId)
  const recordPath = path.join(failed[0].workspaceDir, 'workspace.json')
  const crashResidue = { ...JSON.parse(fs.readFileSync(recordPath, 'utf8')), state: 'authoring', lastSuccessfulStep: 'prepared' }
  fs.writeFileSync(recordPath, `${JSON.stringify(crashResidue, null, 2)}\n`)
  const discoveredResidue = resolveGenerationWorkspace(failed[0].workspaceId, { libraryRoot })
  assert.equal(discoveredResidue.initializationResidue, true)
  assert.equal(discoveredResidue.readOnly, true)
  await assert.rejects(
    writeWorkspaceAuthoring(failed[0].workspaceId, 'README.md', '# unsafe resume\n', { expectAbsent: true }, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'WORKSPACE_INITIALIZATION_INCOMPLETE' }
  )

  const retried = await createGenerationWorkspace({
    identity,
    routeSlug: 'double-failure-preserved',
    paperRecord: { paperKey },
    provenance: directProvenance(identity),
    libraryRoot,
    populate: async ({ packageDir }) => { fs.writeFileSync(path.join(packageDir, 'prepared.txt'), 'retry') },
  })
  assert.equal(retried.workspace.state, 'authoring')
  assert.notEqual(retried.workspaceId, failed[0].workspaceId)
  assert.deepEqual(listGenerationWorkspaces({ libraryRoot }).map((item) => item.initializationResidue).sort(), [false, true])
})

test('active workspaces reserve route slugs before C2b publication', (t) => {
  const libraryRoot = temporaryLibrary(t)
  const firstInput = path.join(libraryRoot, 'first.pdf')
  const secondInput = path.join(libraryRoot, 'second.pdf')
  fs.copyFileSync(fixturePdf, firstInput)
  fs.copyFileSync(fixturePdf, secondInput)
  fs.appendFileSync(secondInput, '\n% synthetic source revision\n')
  const first = prepareWorkspace(libraryRoot, firstInput)
  const second = prepareWorkspace(libraryRoot, secondInput)
  assert.notEqual(first.paperSlug, second.paperSlug)
  assert.match(second.paperSlug, new RegExp(`^${first.paperSlug}-[a-f0-9]{12}$`))
})

test('authoring requires exact workspace CAS and abandon is persistent without deletion', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const prepared = prepareWorkspace(libraryRoot)
  await writeWorkspaceAuthoring(prepared.workspaceId, 'reasoning-analysis.json', '{}\n', { expectAbsent: true }, {
    libraryRoot, lockTimeoutMs: 0, actor: 'codex',
  })
  const first = await writeWorkspaceAuthoring(prepared.workspaceId, 'README.md', '# One\n', { expectAbsent: true }, { libraryRoot, lockTimeoutMs: 0 })
  await assert.rejects(writeWorkspaceAuthoring(prepared.workspaceId, 'README.md', '# Two\n', { expectedSha256: '0'.repeat(64) }, { libraryRoot, lockTimeoutMs: 0 }), { code: 'WRITE_PRECONDITION_FAILED' })
  await writeWorkspaceAuthoring(prepared.workspaceId, 'README.md', '# Two\n', { expectedSha256: first.sha256 }, { libraryRoot, lockTimeoutMs: 0 })
  await updateWorkspaceRecord(prepared.workspaceId, { state: 'validating', lastSuccessfulStep: 'validation_started' }, { libraryRoot, lockTimeoutMs: 0 })
  await updateWorkspaceRecord(prepared.workspaceId, { state: 'validated', lastSuccessfulStep: 'validation_complete' }, { libraryRoot, lockTimeoutMs: 0 })
  withWorkspaceMutationSync(prepared.workspaceId, ({ descriptor, lockHandle }) => {
    assert.throws(() => replaceWorkspaceJson({ descriptor, lockHandle, relativePath: 'meta.json', value: {}, policy: 'analysis' }), { code: 'WORKSPACE_WRITE_PATH_FORBIDDEN' })
    replaceWorkspaceJson({ descriptor, lockHandle, relativePath: 'analysis.json', value: {}, policy: 'analysis' })
  }, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot }).workspace.state, 'authoring')
  await updateWorkspaceRecord(prepared.workspaceId, { state: 'validating', lastSuccessfulStep: 'validation_started' }, { libraryRoot, lockTimeoutMs: 0 })
  await updateWorkspaceRecord(prepared.workspaceId, { state: 'validated', lastSuccessfulStep: 'validation_complete' }, { libraryRoot, lockTimeoutMs: 0 })
  await writeWorkspaceAuthoring(prepared.workspaceId, 'summary.md', '# Changed after validation\n', { expectAbsent: true }, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot }).workspace.state, 'authoring')
  assert.equal(resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot }).workspace.lastSuccessfulStep, 'authoring')
  await assert.rejects(writeWorkspaceAuthoring(prepared.workspaceId, 'paper.pdf', 'bad', { expectedSha256: '0'.repeat(64) }, { libraryRoot }), { code: 'WORKSPACE_WRITE_PATH_FORBIDDEN' })
  const abandoned = await abandonGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(abandoned.workspace.state, 'abandoned')
  assert.equal(fs.existsSync(abandoned.packageDir), true)
  await assert.rejects(writeWorkspaceAuthoring(prepared.workspaceId, 'summary.md', 'x', { expectAbsent: true }, { libraryRoot }), { code: 'WORKSPACE_ABANDONED' })
  assert.throws(() => withWorkspaceMutationSync(prepared.workspaceDir, () => undefined, { libraryRoot, lockTimeoutMs: 0 }), { code: 'WORKSPACE_ABANDONED' })
  await assert.rejects(updateWorkspaceRecord(prepared.workspaceId, { state: 'authoring' }, { libraryRoot, lockTimeoutMs: 0 }), { code: 'WORKSPACE_ABANDONED' })
  assert.equal(resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot }).workspace.state, 'abandoned')
})

test('prepare refuses to resume an abandoned workspace', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const prepared = prepareWorkspace(libraryRoot)
  await abandonGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const resumed = spawnSync(process.execPath, [prepareScript, fixturePdf, '--workflow', 'study', '--language', 'en', '--context', 'paper-only', '--profile', 'auto', '--resume-workspace', prepared.workspaceId], {
    encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }, timeout: 30_000
  })
  assert.notEqual(resumed.status, 0)
  assert.match(resumed.stderr, /WORKSPACE_ABANDONED/)
})

test('workspace CLI requires exact references and preserves CAS exit contracts', (t) => {
  const libraryRoot = temporaryLibrary(t)
  const prepared = prepareWorkspace(libraryRoot)
  const env = { ...process.env, PAPERS_DIR: libraryRoot }
  const listed = spawnSync(process.execPath, [workspaceCli, 'list', '--json'], { encoding: 'utf8', env })
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(JSON.parse(listed.stdout)[0].workspaceId, prepared.workspaceId)
  const missing = spawnSync(process.execPath, [workspaceCli, 'inspect', 'latest'], { encoding: 'utf8', env })
  assert.equal(missing.status, 2)
  const reasoning = spawnSync(process.execPath, [workspaceCli, 'write', prepared.workspaceId, 'reasoning-analysis.json', '--stdin', '--expect-absent', '--actor', 'codex'], {
    input: '{}\n', encoding: 'utf8', env
  })
  assert.equal(reasoning.status, 0, reasoning.stderr)
  const created = spawnSync(process.execPath, [workspaceCli, 'write', prepared.workspaceId, 'summary.md', '--stdin', '--expect-absent', '--json'], {
    input: '# Summary\n', encoding: 'utf8', env
  })
  assert.equal(created.status, 0, created.stderr)
  const write = JSON.parse(created.stdout)
  assert.match(write.sha256, /^[a-f0-9]{64}$/)
  const conflict = spawnSync(process.execPath, [workspaceCli, 'write', prepared.workspaceId, 'summary.md', '--stdin', '--expected-sha256', '0'.repeat(64)], {
    input: '# Changed\n', encoding: 'utf8', env
  })
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /WRITE_PRECONDITION_FAILED/)
  const duplicate = spawnSync(process.execPath, [workspaceCli, 'write', prepared.workspaceId, 'duplicate.md', '--stdin', '--stdin', '--expect-absent'], {
    input: 'x', encoding: 'utf8', env
  })
  assert.equal(duplicate.status, 2)
  assert.match(duplicate.stderr, /ARGUMENT_INVALID/)
})
