import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { writeAuthoringBoundary } from '../../benchmarks/mandatory/authoring-boundary.mjs'
import {
  commitGenerationMigration,
  inspectGenerationMigration,
  recoverGenerationMigrations,
  rollbackGenerationMigration,
  rollforwardGenerationMigration,
  startGenerationMigration,
} from '../../plugins/codex-paper/src/shared/generation-migration.mjs'
import { buildMigrationPlan, createPaperBackup, descriptorForMigrationTarget, inspectLibrary, inventoryTree, stableJson, structuralTarget } from '../../plugins/codex-paper/src/shared/library-maintenance.mjs'
import { cliExitCode } from '../../plugins/codex-paper/src/shared/cli-error-format.mjs'
import { computeGenerationManifestHash, readGenerationManifest } from '../../plugins/codex-paper/src/shared/generation-manifest.mjs'
import { resolveGenerationWorkspace } from '../../plugins/codex-paper/src/shared/generation-workspace.mjs'
import { resolveLibraryPaper } from '../../plugins/codex-paper/src/shared/paper-library.mjs'
import { buildLibraryIndexEntries, planLibraryReindex, rebuildLibraryIndex } from '../../plugins/codex-paper/src/shared/generation-publication.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const fixturePdf = path.join(repoRoot, 'benchmarks/fixtures/pdf/front-matter-noise.pdf')
const gold = JSON.parse(fs.readFileSync(path.join(repoRoot, 'benchmarks/mandatory/gold/front-matter-noise.json'), 'utf8'))
const validator = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/validate-study-package.js')
const migrationCli = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/generation-migration-cli.js')
const publicationCli = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/publication-cli.js')
const compatibilityFixtures = path.join(repoRoot, 'benchmarks/fixtures/pdf/compatibility')
const WORKSPACE_ID_PATTERN = /^ws-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{32}$/

function temporaryLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migration-'))
  fs.mkdirSync(path.join(root, 'papers'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
  t.after(() => {
    function writable(target) {
      if (!fs.existsSync(target)) return
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink()) return
      if (stats.isDirectory()) {
        fs.chmodSync(target, 0o700)
        for (const entry of fs.readdirSync(target)) writable(path.join(target, entry))
      } else fs.chmodSync(target, 0o600)
    }
    writable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function useLibraryEnvironment(t, libraryRoot) {
  const previousLibrary = process.env.PAPERS_DIR
  process.env.PAPERS_DIR = libraryRoot
  t.after(() => {
    if (previousLibrary === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previousLibrary
  })
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
}

function addLegacy(root) {
  const slug = gold.requiredAssertions.paperSlug
  const packageDir = path.join(root, 'papers', slug)
  fs.mkdirSync(packageDir, { recursive: true })
  fs.copyFileSync(fixturePdf, path.join(packageDir, 'paper.pdf'))
  const meta = { slug, title: gold.requiredAssertions.title, workflow: 'study', language: 'en', contextMode: 'paper-only', requestedPaperProfile: 'empirical' }
  writeJson(path.join(packageDir, 'meta.json'), meta)
  writeJson(path.join(root, 'index.json'), [meta])
  return { slug, packageDir }
}

function addManagedGolden(root, fixtureId) {
  const sourceRecord = path.join(compatibilityFixtures, fixtureId, 'record')
  const record = JSON.parse(fs.readFileSync(path.join(sourceRecord, 'paper.json'), 'utf8'))
  const recordDir = path.join(root, '.codex-paper', 'store-v1', 'papers', record.paperKey)
  fs.mkdirSync(path.dirname(recordDir), { recursive: true })
  fs.cpSync(sourceRecord, recordDir, { recursive: true, preserveTimestamps: true })
  const current = JSON.parse(fs.readFileSync(path.join(recordDir, 'current.json'), 'utf8'))
  const packageDir = path.join(recordDir, ...current.packageRelativePath.split('/'))
  readGenerationManifest(packageDir)
  writeJson(path.join(root, 'index.json'), buildLibraryIndexEntries(root, { managedStrict: true, legacyStrict: true }))
  return { record, current, recordDir, packageDir, routeSlug: record.routeAliases[0] }
}

function shaTree(root) {
  return inventoryTree(root).snapshotHash
}

function shaBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function makeManagedGoldenParseable(source) {
  fs.copyFileSync(fixturePdf, path.join(source.packageDir, 'paper.pdf'))
  for (const relativePath of ['README.md', 'reasoning-analysis.json']) {
    fs.rmSync(path.join(source.packageDir, relativePath), { force: true })
  }
  const sourceSha256 = shaBytes(fs.readFileSync(path.join(source.packageDir, 'paper.pdf')))
  const sidecarPath = path.join(source.packageDir, 'paper.pdf.manifest.json')
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
  writeJson(sidecarPath, { ...sidecar, sha256: sourceSha256 })
  const manifestPath = path.join(source.packageDir, '.codex-paper/generation-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.sourceSha256 = sourceSha256
  manifest.files = manifest.files.filter((item) => fs.existsSync(path.join(source.packageDir, ...item.path.split('/')))).map((item) => {
    const bytes = fs.readFileSync(path.join(source.packageDir, ...item.path.split('/')))
    return { ...item, sha256: shaBytes(bytes), bytes: bytes.length }
  })
  manifest.manifestHash = computeGenerationManifestHash(manifest)
  writeJson(manifestPath, manifest)
  const current = JSON.parse(fs.readFileSync(path.join(source.recordDir, 'current.json'), 'utf8'))
  const manifestBytes = fs.readFileSync(manifestPath)
  const updatedCurrent = {
    ...current,
    manifestHash: manifest.manifestHash,
    manifestFileSha256: shaBytes(manifestBytes),
  }
  writeJson(path.join(source.recordDir, 'current.json'), updatedCurrent)
  source.current = updatedCurrent
  return source
}

function validateWorkspace(workspace, libraryRoot) {
  return spawnSync(process.execPath, [validator, workspace.packageDir, '--lang', 'en', '--json'], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

test('migration start is two-phase and requires a fresh verified backup', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  assert.throws(
    () => inspectGenerationMigration('mig-not-a-valid-id', { libraryRoot }),
    { code: 'MIGRATION_ID_INVALID' },
  )
  assert.throws(
    () => inspectGenerationMigration('not-an-id', { libraryRoot }),
    { code: 'MIGRATION_REFERENCE_INVALID' },
  )
  assert.equal(cliExitCode({ code: 'STORAGE_LOCK_OWNERSHIP_LOST' }), 3)
  assert.equal(cliExitCode({ code: 'STORAGE_LOCK_CORRUPT' }), 1)
  assert.equal(cliExitCode({ code: 'STORAGE_LOCK_REQUIRED' }), 1)
  const source = addLegacy(libraryRoot)
  const before = shaTree(source.packageDir)
  const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  const started = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(started.status, 'workspace_created')
  assert.equal(started.validationRequired, true)
  assert.equal(shaTree(source.packageDir), before)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8'))[0].slug, source.slug)
  const workspace = resolveGenerationWorkspace(started.workspaceId, { libraryRoot })
  assert.equal(workspace.workspace.state, 'authoring')
  assert.equal(fs.existsSync(path.join(workspace.packageDir, '.codex-paper/evidence-aliases.json')), true)
  const reused = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(reused.reused, true)
  assert.equal(reused.migrationId, started.migrationId)
  assert.equal(reused.workspaceId, started.workspaceId)
  fs.writeFileSync(path.join(source.packageDir, 'operator-note.md'), 'changed source\n')
  const changedBackup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  await assert.rejects(
    startGenerationMigration(source.slug, changedBackup.backupId, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'MIGRATION_ALREADY_ACTIVE' },
  )
  await assert.rejects(commitGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0 }), { code: 'MIGRATION_VALIDATION_REQUIRED' })
  const cliConflict = spawnSync(process.execPath, [migrationCli, 'commit', started.migrationId, '--json', '--lock-timeout-ms', '0'], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
  })
  assert.equal(cliConflict.status, 1)
  assert.match(cliConflict.stderr, /MIGRATION_VALIDATION_REQUIRED/)
  assert.equal(cliConflict.stderr.includes(libraryRoot), false)
})

test('managed Manifest and Identity 1.0 is migration-eligible and parser failure preserves current authority', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const source = addManagedGolden(libraryRoot, 'managed-manifest-1-identity-1')
  const before = shaTree(source.recordDir)
  const backup = await createPaperBackup(source.record.paperKey, { libraryRoot, lockTimeoutMs: 0 })
  descriptorForMigrationTarget(structuralTarget(source.record.paperKey, libraryRoot), libraryRoot)
  const plan = buildMigrationPlan(source.record.paperKey, { libraryRoot, backupId: backup.backupId })
  assert.equal(plan.eligibility, 'ready', JSON.stringify(plan))
  assert.equal(plan.source.manifestVersion, '1.0.0')
  assert.equal(plan.source.identityVersion, '1.0.0')
  await assert.rejects(
    startGenerationMigration(source.record.paperKey, backup.backupId, { libraryRoot, lockTimeoutMs: 0 }),
    (error) => error.code === 'pdf_parse_failed',
  )
  assert.equal(shaTree(source.recordDir), before)
  const current = resolveLibraryPaper(source.record.paperKey, { libraryRoot })
  assert.equal(current.current.manifestHash, source.current.manifestHash)
})

test('managed Manifest and Identity 1.0 migrates end-to-end and excludes mutable overlay from freshness', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  useLibraryEnvironment(t, libraryRoot)
  const source = makeManagedGoldenParseable(addManagedGolden(libraryRoot, 'managed-manifest-1-identity-1'))
  writeJson(path.join(libraryRoot, 'index.json'), buildLibraryIndexEntries(libraryRoot, { managedStrict: true, legacyStrict: true }))
  const backup = await createPaperBackup(source.record.paperKey, { libraryRoot, lockTimeoutMs: 0 })
  const started = await startGenerationMigration(source.record.paperKey, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  const workspace = resolveGenerationWorkspace(started.workspaceId, { libraryRoot })
  const ledger = JSON.parse(fs.readFileSync(path.join(workspace.packageDir, 'evidence-ledger.json'), 'utf8'))
  await writeAuthoringBoundary({ paperDir: workspace.packageDir, fixtureId: 'front-matter-noise', gold, ledger })
  const validation = validateWorkspace(workspace, libraryRoot)
  assert.equal(validation.status, 0, validation.stderr || validation.stdout)
  const overlayPath = path.join(source.recordDir, 'overlay/state.json')
  const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'))
  writeJson(overlayPath, { ...overlay, tags: ['changed-during-authoring'] })
  const committed = await commitGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(committed.committed, true)
  assert.notEqual(committed.current.manifestHash, source.current.manifestHash)
  const rolledBack = await rollbackGenerationMigration(started.migrationId, committed.current.manifestHash, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rolledBack.rolledBack, true)
  assert.equal(resolveLibraryPaper(source.record.paperKey, { libraryRoot }).current.manifestHash, source.current.manifestHash)
  const rolledForward = await rollforwardGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rolledForward.rolledForward, true)
  assert.equal(resolveLibraryPaper(source.record.paperKey, { libraryRoot }).current.manifestHash, committed.current.manifestHash)
})

test('native Manifest and Identity 2.0 returns not_required without validating a backup', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const source = addManagedGolden(libraryRoot, 'managed-manifest-2-identity-2')
  const before = shaTree(source.recordDir)
  const result = await startGenerationMigration(source.record.paperKey, 'not-a-backup-id', { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(result.status, 'not_required')
  assert.equal(result.plan.backup.status, 'not_required')
  assert.equal(result.plan.executionAvailable, false)
  assert.equal(shaTree(source.recordDir), before)
})

test('legacy migration commits, rolls back exact flat bytes, and rolls forward', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const previousLibrary = process.env.PAPERS_DIR
  process.env.PAPERS_DIR = libraryRoot
  t.after(() => {
    if (previousLibrary === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previousLibrary
  })
  const source = addLegacy(libraryRoot)
  const sourceSnapshot = shaTree(source.packageDir)
  const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  const started = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  const workspace = resolveGenerationWorkspace(started.workspaceId, { libraryRoot })
  const ledger = JSON.parse(fs.readFileSync(path.join(workspace.packageDir, 'evidence-ledger.json'), 'utf8'))
  await writeAuthoringBoundary({ paperDir: workspace.packageDir, fixtureId: 'front-matter-noise', gold, ledger })
  const validation = validateWorkspace(workspace, libraryRoot)
  assert.equal(validation.status, 0, validation.stderr || validation.stdout)
  fs.mkdirSync(path.join(libraryRoot, 'papers', 'unrelated-broken'))
  fs.writeFileSync(path.join(libraryRoot, 'papers', 'unrelated-broken/meta.json'), '{broken')
  await assert.rejects(
    commitGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_legacy_archive' }),
    { code: 'MIGRATION_FAULT_INJECTED' },
  )
  const commitRecovery = await recoverGenerationMigrations({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(commitRecovery.failed, 0)
  assert.equal(commitRecovery.recovered, 1)
  const committedTransaction = inspectGenerationMigration(started.migrationId, { libraryRoot })
  const committed = {
    committed: committedTransaction.state === 'committed',
    manifestHash: committedTransaction.currentAfter.manifestHash,
  }
  assert.equal(committed.committed, true)
  assert.equal(fs.existsSync(source.packageDir), false)
  const managed = resolveLibraryPaper(source.slug, { libraryRoot })
  assert.equal(managed.mode, 'managed_v1')
  assert.equal(managed.current.manifestHash, committed.manifestHash)
  const transaction = inspectGenerationMigration(started.migrationId, { libraryRoot })
  assert.equal(transaction.state, 'committed')
  assert.equal(transaction.currentAfter.manifestHash, committed.manifestHash)
  const doctor = inspectLibrary({ libraryRoot })
  assert.equal(doctor.summary.migrationTransactions, 1)
  assert.equal(doctor.summary.pendingMigrations, 0)
  assert.equal(doctor.summary.migrationArchives, 1)
  assert.equal(doctor.summary.migrationArchiveBytes > 0, true)
  assert.equal(doctor.items.some((item) => item.kind === 'migration_transaction' && item.state === 'committed'), true)
  assert.equal(doctor.items.some((item) => item.kind === 'migration_archive' && item.state === 'retained'), true)

  const currentPath = path.join(managed.paperRoot, 'current.json')
  const currentBytes = fs.readFileSync(currentPath)
  const changedCurrent = JSON.parse(currentBytes)
  changedCurrent.manifestHash = 'f'.repeat(64)
  writeJson(currentPath, changedCurrent)
  await assert.rejects(
    rollbackGenerationMigration(started.migrationId, committed.manifestHash, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'MIGRATION_CURRENT_CONFLICT' },
  )
  assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'committed')
  fs.writeFileSync(currentPath, currentBytes)

  await assert.rejects(
    rollbackGenerationMigration(started.migrationId, committed.manifestHash, {
      libraryRoot, lockTimeoutMs: 0, faultAt: 'after_legacy_source_restore',
    }),
    { code: 'MIGRATION_FAULT_INJECTED' },
  )
  const rollbackRecovery = await recoverGenerationMigrations({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rollbackRecovery.failed, 0)
  assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'rolled_back')
  const legacy = resolveLibraryPaper(source.slug, { libraryRoot })
  assert.equal(legacy.mode, 'legacy_flat')
  assert.equal(shaTree(legacy.packageDir), sourceSnapshot)

  const legacyMetaPath = path.join(legacy.packageDir, 'meta.json')
  const legacyMeta = fs.readFileSync(legacyMetaPath)
  const legacyMetaMode = fs.statSync(legacyMetaPath).mode & 0o777
  fs.appendFileSync(legacyMetaPath, '\n')
  await assert.rejects(
    rollforwardGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'MIGRATION_ROLLFORWARD_CONFLICT' },
  )
  assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'rolled_back')
  assert.equal(fs.existsSync(path.join(libraryRoot, '.codex-paper/store-v1/papers', transaction.target.paperKey)), false)
  assert.equal(fs.existsSync(path.join(libraryRoot, '.codex-paper/migration-archives-v1', started.migrationId, 'target')), true)
  fs.writeFileSync(legacyMetaPath, legacyMeta, { mode: legacyMetaMode })
  fs.chmodSync(legacyMetaPath, legacyMetaMode)
  await assert.rejects(
    rollforwardGenerationMigration(started.migrationId, {
      libraryRoot, lockTimeoutMs: 0, faultAt: 'after_legacy_source_archive',
    }),
    { code: 'MIGRATION_FAULT_INJECTED' },
  )
  const rollforwardRecovery = await recoverGenerationMigrations({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rollforwardRecovery.failed, 0)
  assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'committed')
  const restored = resolveLibraryPaper(source.slug, { libraryRoot })
  assert.equal(restored.mode, 'managed_v1')
  assert.equal(restored.current.manifestHash, committed.manifestHash)

  const noOp = await startGenerationMigration(source.slug, 'not-a-backup-id', { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(noOp.status, 'not_required')
  assert.equal(noOp.plan.backup.required, false)
  assert.equal(noOp.plan.backup.status, 'not_required')
  assert.equal(noOp.plan.diagnostics.some((item) => item.code === 'MIGRATION_BACKUP_REQUIRED'), false)
})

test('legacy commit recovery converges after current commit and before index commit', async (t) => {
  for (const faultAt of ['after_current_commit', 'before_index_commit']) {
    const libraryRoot = temporaryLibrary(t)
    useLibraryEnvironment(t, libraryRoot)
    const source = addLegacy(libraryRoot)
    const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
    const started = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
    const workspace = resolveGenerationWorkspace(started.workspaceId, { libraryRoot })
    const ledger = JSON.parse(fs.readFileSync(path.join(workspace.packageDir, 'evidence-ledger.json'), 'utf8'))
    await writeAuthoringBoundary({ paperDir: workspace.packageDir, fixtureId: 'front-matter-noise', gold, ledger })
    assert.equal(validateWorkspace(workspace, libraryRoot).status, 0)
    await assert.rejects(
      commitGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0, faultAt }),
      { code: 'PUBLICATION_FAULT_INJECTED' },
    )
    const recovery = await recoverGenerationMigrations({ libraryRoot, lockTimeoutMs: 0 })
    assert.equal(recovery.failed, 0, `${faultAt}: ${JSON.stringify(recovery)}`)
    assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'committed')
    assert.equal(resolveLibraryPaper(source.slug, { libraryRoot }).mode, 'managed_v1')
    assert.equal(fs.existsSync(source.packageDir), false)
  }
})

test('deleted legacy source is rejected before publication changes authority', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  useLibraryEnvironment(t, libraryRoot)
  const source = addLegacy(libraryRoot)
  const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  const started = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  const workspace = resolveGenerationWorkspace(started.workspaceId, { libraryRoot })
  const ledger = JSON.parse(fs.readFileSync(path.join(workspace.packageDir, 'evidence-ledger.json'), 'utf8'))
  await writeAuthoringBoundary({ paperDir: workspace.packageDir, fixtureId: 'front-matter-noise', gold, ledger })
  assert.equal(validateWorkspace(workspace, libraryRoot).status, 0)
  fs.renameSync(source.packageDir, `${source.packageDir}.removed`)
  await assert.rejects(
    commitGenerationMigration(started.migrationId, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'MIGRATION_SOURCE_MISSING' },
  )
  assert.equal(inspectGenerationMigration(started.migrationId, { libraryRoot }).state, 'workspace_created')
  assert.equal(fs.existsSync(path.join(libraryRoot, '.codex-paper/store-v1/papers')), false)
})

test('migration planner emits a blocked plan for corrupt managed authority and isolates unrelated damage', (t) => {
  const libraryRoot = temporaryLibrary(t)
  const legacy = addLegacy(libraryRoot)
  const baselinePlan = buildMigrationPlan(legacy.slug, { libraryRoot })
  const managed = addManagedGolden(libraryRoot, 'managed-manifest-1-identity-1')
  fs.writeFileSync(path.join(managed.recordDir, 'current.json'), '{broken')
  const managedPlan = buildMigrationPlan(managed.record.paperKey, { libraryRoot })
  assert.equal(managedPlan.eligibility, 'blocked')
  assert.equal(managedPlan.executionAvailable, false)
  const legacyPlan = buildMigrationPlan(legacy.slug, { libraryRoot })
  assert.equal(legacyPlan.eligibility, 'blocked')
  assert.deepEqual(legacyPlan.source, baselinePlan.source)
  assert.equal(legacyPlan.planId, baselinePlan.planId)
  assert.equal(legacyPlan.diagnostics.some((item) => item.path === legacyPlan.target.relativePath
    && item.code === 'LIBRARY_RECORD_INVALID'), false)
  assert.equal(legacyPlan.diagnostics.some((item) => item.code === 'LIBRARY_RECORD_INVALID'), false)
  assert.equal(legacyPlan.diagnostics.some((item) => item.code === 'MIGRATION_BACKUP_REQUIRED'), true)
})

test('workspace-addressed transaction lookup isolates corrupt and unsupported siblings', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  useLibraryEnvironment(t, libraryRoot)
  const source = addLegacy(libraryRoot)
  const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  const started = await startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 })
  const registry = path.join(libraryRoot, '.codex-paper/migration-transactions-v1')
  fs.writeFileSync(path.join(registry, `mig-sha256-${'0'.repeat(64)}.json`), '{broken')
  writeJson(path.join(registry, `mig-sha256-${'1'.repeat(64)}.json`), { schemaVersion: '9.0.0' })
  assert.equal(inspectGenerationMigration(started.workspaceId, { libraryRoot }).migrationId, started.migrationId)
  assert.throws(
    () => inspectGenerationMigration(`mig-sha256-${'0'.repeat(64)}`, { libraryRoot }),
    { code: 'MIGRATION_TRANSACTION_INVALID' },
  )
  assert.throws(
    () => inspectGenerationMigration(`mig-sha256-${'1'.repeat(64)}`, { libraryRoot }),
    { code: 'MIGRATION_TRANSACTION_UNSUPPORTED' },
  )
  const doctor = inspectLibrary({ libraryRoot, now: new Date(0).toISOString() })
  assert.equal(doctor.diagnostics.some((item) => item.code === 'MIGRATION_TRANSACTION_INVALID'), true)
  assert.equal(doctor.diagnostics.some((item) => item.code === 'MIGRATION_TRANSACTION_UNSUPPORTED' && item.severity === 'warning'), true)
})

test('failed authoring copy identifies the file and leaves an actionable exact workspace', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  useLibraryEnvironment(t, libraryRoot)
  const source = addLegacy(libraryRoot)
  fs.mkdirSync(path.join(source.packageDir, 'code'))
  fs.writeFileSync(path.join(source.packageDir, 'code/oversize.js'), Buffer.alloc(1024 * 1024 + 1, 0x61))
  const backup = await createPaperBackup(source.slug, { libraryRoot, lockTimeoutMs: 0 })
  await assert.rejects(
    startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 }),
    (error) => error.code === 'STORAGE_FILE_TOO_LARGE' && error.message.includes('code/oversize.js'),
  )
  await assert.rejects(
    startGenerationMigration(source.slug, backup.backupId, { libraryRoot, lockTimeoutMs: 0 }),
    (error) => error.code === 'MIGRATION_START_INCOMPLETE' && WORKSPACE_ID_PATTERN.test(error.details.workspaceId),
  )
})

test('target reindex dry-run is read-only and apply preserves unrelated entries', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const source = addLegacy(libraryRoot)
  const unrelated = { slug: 'unrelated', title: 'Curated unrelated entry', retained: true }
  writeJson(path.join(libraryRoot, 'index.json'), [
    { slug: source.slug, title: 'stale title' },
    unrelated,
  ])
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(libraryRoot, 'index.json'))).digest('hex')
  const plan = planLibraryReindex({ libraryRoot, paperRef: source.slug })
  assert.equal(plan.scope, 'paper')
  assert.equal(plan.projectedEntries, 1)
  assert.equal(plan.resultEntries, 2)
  assert.equal(plan.applyAvailable, true)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(libraryRoot, 'index.json'))).digest('hex'), before)
  const applied = await rebuildLibraryIndex({ libraryRoot, paperRef: source.slug, lockTimeoutMs: 0 })
  assert.equal(applied.entries.some((entry) => entry.slug === 'unrelated' && entry.retained === true), true)
  assert.equal(applied.entries.find((entry) => entry.slug === source.slug).title, gold.requiredAssertions.title)
  assert.equal(shaBytes(fs.readFileSync(path.join(libraryRoot, 'index.json'))), plan.indexAfterSha256)
})

test('library reindex dry-run explicitly blocks the same invalid legacy authority as apply', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  addLegacy(libraryRoot)
  fs.mkdirSync(path.join(libraryRoot, 'papers', 'broken-legacy'))
  const plan = planLibraryReindex({ libraryRoot })
  assert.equal(plan.scope, 'library')
  assert.equal(plan.applyAvailable, false)
  assert.equal(plan.indexAfterSha256, null)
  assert.equal(plan.blockers.some((item) => item.path === 'papers/broken-legacy'), true)
  await assert.rejects(
    rebuildLibraryIndex({ libraryRoot, lockTimeoutMs: 0 }),
    { code: 'LIBRARY_INDEX_REPAIR_BLOCKED' },
  )
  const cli = spawnSync(process.execPath, [publicationCli, 'reindex', '--paper', 'broken-legacy', '--json', '--lock-timeout-ms', '0'], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
  })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /LIBRARY_INDEX_REPAIR_BLOCKED/)
})

test('library reindex dry-run reports an unsafe papers registry as a blocker', (t) => {
  const libraryRoot = temporaryLibrary(t)
  fs.rmSync(path.join(libraryRoot, 'papers'), { recursive: true })
  fs.writeFileSync(path.join(libraryRoot, 'papers'), 'not a directory')
  const plan = planLibraryReindex({ libraryRoot })
  assert.equal(plan.applyAvailable, false)
  assert.equal(plan.indexAfterSha256, null)
  assert.equal(plan.blockers.some((item) => item.code === 'LIBRARY_PATH_MISSING'), true)
})
