import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildMigrationPlan,
  createPaperBackup,
  inspectLibrary,
  inventoryTree,
  recoverBackupRestores,
  restorePaperBackup,
  validateDoctorReportDocument,
  verifyBackup,
} from '../../plugins/codex-paper/src/shared/library-maintenance.mjs'
import { classifyPackageCompatibility } from '../../plugins/codex-paper/src/shared/package-compatibility.mjs'
import {
  readGenerationManifest,
  verifyGenerationManifest,
} from '../../plugins/codex-paper/src/shared/generation-manifest.mjs'
import { readPaperIdentity } from '../../plugins/codex-paper/skills/study/scripts/paper-identity.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(REPO_ROOT, 'benchmarks/fixtures/pdf/compatibility')
const GENERATOR = path.join(REPO_ROOT, 'benchmarks/fixtures/generate-compatibility-fixtures.mjs')
const MIGRATE = path.join(REPO_ROOT, 'plugins/codex-paper/skills/study/scripts/migrate-package.js')
const CLI = path.join(REPO_ROOT, 'plugins/codex-paper/skills/study/scripts/library-maintenance-cli.js')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function snapshot(root) {
  const values = []
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = relative ? `${relative}/${entry.name}` : entry.name
      const target = path.join(directory, entry.name)
      const stats = fs.lstatSync(target)
      if (entry.isDirectory()) walk(target, item)
      else values.push({
        path: item,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
        mtimeMs: stats.mtimeMs,
        mode: stats.mode & 0o777,
      })
    }
  }
  walk(root)
  return values
}

function temporaryLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-maintenance-'))
  fs.mkdirSync(path.join(root, 'papers'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
  t.after(() => {
    function makeWritable(target) {
      if (!fs.existsSync(target)) return
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink()) return
      if (stats.isDirectory()) {
        fs.chmodSync(target, 0o700)
        for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry))
      } else if (stats.isFile()) fs.chmodSync(target, 0o600)
    }
    makeWritable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function addLegacy(root, slug, version = '2.0.0') {
  const packageDir = path.join(root, 'papers', slug)
  fs.mkdirSync(packageDir, { recursive: true })
  const meta = { slug, title: `Synthetic ${slug}`, ...(version ? { packageVersion: version } : {}) }
  writeJson(path.join(packageDir, 'meta.json'), meta)
  if (version) {
    writeJson(path.join(packageDir, 'evidence-ledger.json'), { schemaVersion: '2.0.0', paperSlug: slug, evidence: [], sections: [] })
    writeJson(path.join(packageDir, 'reasoning-analysis.json'), { schemaVersion: '2.0.0' })
  }
  writeJson(path.join(root, 'index.json'), [meta])
  return packageDir
}

function addManagedGolden(root, fixtureId = 'managed-manifest-2-identity-2') {
  const sourceRecord = path.join(FIXTURES, fixtureId, 'record')
  const record = JSON.parse(fs.readFileSync(path.join(sourceRecord, 'paper.json'), 'utf8'))
  const target = path.join(root, '.codex-paper', 'store-v1', 'papers', record.paperKey)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(sourceRecord, target, { recursive: true, preserveTimestamps: true })
  const current = JSON.parse(fs.readFileSync(path.join(target, 'current.json'), 'utf8'))
  const packageDir = path.join(target, ...current.packageRelativePath.split('/'))
  const meta = JSON.parse(fs.readFileSync(path.join(packageDir, 'meta.json'), 'utf8'))
  const generationManifest = readGenerationManifest(packageDir)
  const entry = {
    ...meta,
    slug: record.routeAliases[0],
    title: meta.title,
    tags: ['synthetic'],
    storageKey: record.paperKey,
    paperId: current.paperId,
    paperIdAliases: record.paperIdAliases,
    sourceRevisionId: current.sourceRevisionId,
    generationId: current.generationId,
    ...(current.manifestId ? {
      generationManifest: {
        schemaVersion: generationManifest.schemaVersion,
        manifestId: current.manifestId,
        manifestHash: current.manifestHash,
        manifestFileSha256: current.manifestFileSha256,
      },
      validationReportHash: current.validationReportHash,
    } : {}),
  }
  writeJson(path.join(root, 'index.json'), [entry])
  return { record, current, recordDir: target, packageDir, indexEntry: entry }
}

function chmodTree(root, directoryMode, fileMode) {
  function walk(target) {
    const stats = fs.lstatSync(target)
    if (stats.isDirectory()) {
      fs.chmodSync(target, 0o700)
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry))
      fs.chmodSync(target, directoryMode)
    } else if (stats.isFile()) fs.chmodSync(target, fileMode)
  }
  walk(root)
}

function packagePath(fixtureId) {
  const root = path.join(FIXTURES, fixtureId)
  const direct = path.join(root, 'package')
  if (fs.existsSync(direct)) return direct
  const manifest = findFile(root, 'generation-manifest.json')
  return path.dirname(path.dirname(manifest))
}

function findFile(root, basename) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(target, basename)
      if (found) return found
    } else if (entry.name === basename) return target
  }
  return null
}

test('compatibility fixtures reproduce byte-for-byte', () => {
  const result = spawnSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /deterministic/)
})

test('flat package goldens use production compatibility readers without writes', () => {
  const expected = new Map([
    ['legacy-v1-flat', 'legacy_v1'],
    ['package-2.0-flat', 'compatible_2_0'],
    ['package-2.1-flat', 'native_2_1'],
  ])
  for (const [fixtureId, mode] of expected) {
    const packageDir = packagePath(fixtureId)
    const before = snapshot(packageDir)
    const meta = JSON.parse(fs.readFileSync(path.join(packageDir, 'meta.json'), 'utf8'))
    const reasoningPath = path.join(packageDir, 'reasoning-analysis.json')
    const ledgerPath = path.join(packageDir, 'evidence-ledger.json')
    const compatibility = classifyPackageCompatibility({
      meta,
      reasoning: fs.existsSync(reasoningPath) ? JSON.parse(fs.readFileSync(reasoningPath, 'utf8')) : null,
      ledger: fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null,
    })
    assert.equal(compatibility.mode, mode)
    assert.deepEqual(snapshot(packageDir), before)
  }
})

test('Manifest and Identity 1.0/2.0 goldens verify without writes', () => {
  for (const [fixtureId, version] of [
    ['managed-manifest-1-identity-1', '1.0.0'],
    ['managed-manifest-2-identity-2', '2.0.0'],
  ]) {
    const packageDir = packagePath(fixtureId)
    const before = snapshot(packageDir)
    assert.equal(readPaperIdentity(path.join(packageDir, '.codex-paper/paper-identity.json')).schemaVersion, version)
    assert.equal(readGenerationManifest(packageDir).schemaVersion, version)
    assert.equal(verifyGenerationManifest(packageDir).manifest.schemaVersion, version)
    assert.deepEqual(snapshot(packageDir), before)
  }
})

test('doctor inventories healthy legacy state without writes or absolute paths', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'legacy-paper', '2.0.0')
  const before = snapshot(root)
  const report = inspectLibrary({ libraryRoot: root, now: '2026-07-30T00:00:00.000Z' })
  assert.equal(report.schemaVersion, '1.1.0')
  assert.equal(report.status, 'healthy')
  assert.equal(report.summary.legacyPackages, 1)
  assert.match(report.inventoryHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(report).includes(root), false)
  const legacyReport = structuredClone(report)
  legacyReport.schemaVersion = '1.0.0'
  for (const field of ['migrationTransactions', 'pendingMigrations', 'migrationArchives', 'migrationArchiveBytes']) {
    delete legacyReport.summary[field]
  }
  const compatibility = validateDoctorReportDocument(legacyReport)
  assert.equal(compatibility.compatibilityMode, 'compatible_1_0')
  assert.equal(compatibility.readOnly, true)
  assert.throws(
    () => validateDoctorReportDocument({ ...legacyReport, schemaVersion: '9.0.0' }),
    { code: 'DOCTOR_REPORT_UNSUPPORTED' },
  )
  assert.deepEqual(snapshot(root), before)
})

test('doctor classifies managed paper, current generation, and mutable overlay', (t) => {
  const root = temporaryLibrary(t)
  const managed = addManagedGolden(root)
  const report = inspectLibrary({ libraryRoot: root })
  assert.equal(report.status, 'healthy')
  assert.equal(report.summary.managedPapers, 1)
  assert.equal(report.summary.managedGenerations, 1)
  assert.equal(report.summary.overlays, 1)
  assert.equal(report.items.find((item) => item.kind === 'managed_generation').id, managed.current.generationId)
})

test('doctor isolates corrupt package and index diagnostics instead of aborting the scan', (t) => {
  const root = temporaryLibrary(t)
  const valid = addLegacy(root, 'valid-paper', '2.0.0')
  const corrupt = path.join(root, 'papers', 'corrupt-paper')
  fs.mkdirSync(corrupt)
  fs.writeFileSync(path.join(corrupt, 'meta.json'), '{not-json')
  fs.writeFileSync(path.join(root, 'index.json'), '{not-json')
  const report = inspectLibrary({ libraryRoot: root })
  assert.equal(report.status, 'errors')
  assert.equal(report.items.some((item) => item.id === 'valid-paper'), true)
  assert.equal(report.diagnostics.some((item) => item.code === 'PACKAGE_ARTIFACT_INVALID'), true)
  assert.equal(report.diagnostics.some((item) => item.code === 'LIBRARY_INDEX_INVALID'), true)
  assert.equal(fs.existsSync(valid), true)
})

test('doctor tolerates unsafe registries and reports corrupted backup payloads without leaking paths', async (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'healthy-paper', '2.0.0')
  const backup = await createPaperBackup('healthy-paper', { libraryRoot: root })
  const payloadMeta = path.join(root, '.codex-paper/backups-v1', backup.backupId, 'payload/meta.json')
  fs.appendFileSync(payloadMeta, '\n')
  const report = inspectLibrary({ libraryRoot: root })
  assert.equal(report.status, 'errors')
  assert.ok(report.diagnostics.some((item) => item.code === 'BACKUP_INTEGRITY_FAILED'))
  assert.equal(JSON.stringify(report).includes(root), false)

  fs.rmSync(path.join(root, '.codex-paper/backups-v1'), { recursive: true })
  fs.symlinkSync(os.tmpdir(), path.join(root, '.codex-paper/backups-v1'))
  fs.symlinkSync(os.tmpdir(), path.join(root, '.codex-paper/workspaces-v1'))
  fs.mkdirSync(path.join(root, '.codex-paper/store-v1'), { recursive: true })
  fs.symlinkSync(os.tmpdir(), path.join(root, '.codex-paper/store-v1/papers'))
  const unsafe = inspectLibrary({ libraryRoot: root })
  assert.equal(unsafe.status, 'errors')
  assert.ok(unsafe.diagnostics.some((item) => item.path === '.codex-paper/backups-v1'))
  assert.ok(unsafe.diagnostics.some((item) => item.path === '.codex-paper/workspaces-v1'))
  assert.ok(unsafe.diagnostics.some((item) => item.path === '.codex-paper/store-v1/papers'))
})

test('migration dry-run carries target Doctor blockers and remains non-executable', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'doctor-blocked', '2.0.0')
  fs.writeFileSync(path.join(root, 'index.json'), '{broken')
  const plan = buildMigrationPlan('doctor-blocked', { libraryRoot: root })
  assert.equal(plan.executionAvailable, false)
  assert.ok(plan.doctor.blockers.some((item) => item.code === 'LIBRARY_INDEX_INVALID'))
  assert.ok(plan.diagnostics.some((item) => item.code === 'LIBRARY_INDEX_INVALID'))
  assert.equal(plan.eligibility, 'blocked')
})

test('backup is content-addressed, verified, reused, and migration dry-run binds freshness', async (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'backup-paper', '2.0.0')
  const first = await createPaperBackup('backup-paper', { libraryRoot: root, now: '2026-07-30T00:00:00.000Z' })
  const second = await createPaperBackup('backup-paper', { libraryRoot: root, now: '2026-07-31T00:00:00.000Z' })
  assert.equal(second.backupId, first.backupId)
  assert.equal(second.reused, true)
  assert.equal(verifyBackup(first.backupId, { libraryRoot: root }).verified, true)
  assert.equal(buildMigrationPlan('backup-paper', { libraryRoot: root, backupId: first.backupId }).backup.status, 'verified')
  fs.appendFileSync(path.join(root, 'papers', 'backup-paper', 'meta.json'), '\n')
  assert.equal(buildMigrationPlan('backup-paper', { libraryRoot: root, backupId: first.backupId }).backup.status, 'stale')
})

test('backup accepts unknown package bytes but migration remains blocked', async (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'future-paper', '9.0.0')
  const backup = await createPaperBackup('future-paper', { libraryRoot: root })
  assert.equal(verifyBackup(backup.backupId, { libraryRoot: root }).verified, true)
  const plan = buildMigrationPlan('future-paper', { libraryRoot: root, backupId: backup.backupId })
  assert.equal(plan.eligibility, 'blocked')
  assert.equal(plan.diagnostics.some((item) => item.code === 'PACKAGE_VERSION_UNSUPPORTED'), true)
})

test('managed backup captures the complete record and restores its current binding and overlay', async (t) => {
  const root = temporaryLibrary(t)
  const managed = addManagedGolden(root)
  const backup = await createPaperBackup(managed.record.paperKey, { libraryRoot: root })
  assert.equal(backup.target.kind, 'managed_paper')
  fs.rmSync(managed.recordDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
  await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(fs.existsSync(path.join(managed.recordDir, 'current.json')), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(managed.recordDir, 'overlay/state.json'), 'utf8')).tags, ['synthetic'])
  assert.equal(verifyGenerationManifest(managed.packageDir).manifest.schemaVersion, '2.0.0')
})

test('restore is idempotent for identical content and restores a missing target plus index', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'restore-paper', '2.0.0')
  const backup = await createPaperBackup('restore-paper', { libraryRoot: root })
  const identical = await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(identical.alreadyPresent, true)
  fs.rmSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
  const restored = await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(restored.alreadyPresent, false)
  assert.equal(inventoryTree(packageDir).snapshotHash, backup.snapshotHash)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))[0].slug, 'restore-paper')
  const again = await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(again.alreadyPresent, true)
})

test('restore refuses divergent target, repairs its own index entry, and never exposes staging payload', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'conflict-paper', '2.0.0')
  const backup = await createPaperBackup('conflict-paper', { libraryRoot: root })
  fs.writeFileSync(path.join(packageDir, 'extra.txt'), 'different\n')
  await assert.rejects(
    () => restorePaperBackup(backup.backupId, { libraryRoot: root }),
    (error) => error.code === 'BACKUP_RESTORE_CONFLICT'
      && /bytes or filesystem modes/.test(error.message),
  )
  fs.rmSync(packageDir, { recursive: true })
  writeJson(path.join(root, 'index.json'), [{ slug: 'conflict-paper', title: 'Different' }])
  await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(fs.existsSync(packageDir), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))[0].title, 'Synthetic conflict-paper')
  const stagingRoot = path.join(root, '.codex-paper/restore-staging-v1')
  assert.deepEqual(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [], [])
})

test('managed restore rejects a route collision owned by another paper and rolls back privately', async (t) => {
  const root = temporaryLibrary(t)
  const managed = addManagedGolden(root)
  const backup = await createPaperBackup(managed.record.paperKey, { libraryRoot: root })
  fs.rmSync(managed.recordDir, { recursive: true })
  writeJson(path.join(root, 'index.json'), [{
    ...managed.indexEntry,
    storageKey: `p-${'f'.repeat(64)}`,
  }])
  await assert.rejects(() => restorePaperBackup(backup.backupId, { libraryRoot: root }), { code: 'BACKUP_RESTORE_CONFLICT' })
  assert.equal(fs.existsSync(managed.recordDir), false)
  assert.equal(fs.readdirSync(path.join(root, '.codex-paper/restore-staging-v1')).length, 1)
})

test('backup rejects symlink content and external path references', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'unsafe-paper', '2.0.0')
  fs.symlinkSync(path.join(packageDir, 'meta.json'), path.join(packageDir, 'linked.json'))
  await assert.rejects(() => createPaperBackup('unsafe-paper', { libraryRoot: root }), { code: 'BACKUP_PATH_UNSAFE' })
  await assert.rejects(() => createPaperBackup(packageDir, { libraryRoot: root }), { code: 'BACKUP_TARGET_INVALID' })
})

test('legacy migrate execution is frozen and its dry-run alias is zero-write', (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'migration-paper', null)
  const before = snapshot(root)
  const refused = spawnSync(process.execPath, [MIGRATE, 'migration-paper'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: root },
  })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /MIGRATION_EXECUTION_DEFERRED/)
  assert.deepEqual(snapshot(root), before)
  const dryRun = spawnSync(process.execPath, [MIGRATE, 'migration-paper', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: root },
  })
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.equal(JSON.parse(dryRun.stdout).executionAvailable, false)
  assert.deepEqual(snapshot(root), before)
  assert.equal(fs.existsSync(path.join(packageDir, 'evidence-ledger.json')), false)
})

test('maintenance CLI returns stable exit codes and redacts local paths', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'cli-paper', '2.0.0')
  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: root },
  })
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.equal(doctor.stdout.includes(root), false)
  const invalid = spawnSync(process.execPath, [CLI, 'backup-verify', 'not-an-id'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: root },
  })
  assert.equal(invalid.status, 2)
  assert.equal(invalid.stderr.includes(root), false)
})

test('backup preserves sealed directory modes and empty directories across managed restore', async (t) => {
  const root = temporaryLibrary(t)
  const managed = addManagedGolden(root)
  const emptyDirectory = path.join(managed.recordDir, 'overlay', 'empty-assets')
  fs.mkdirSync(emptyDirectory)
  chmodTree(managed.packageDir, 0o500, 0o400)
  fs.chmodSync(emptyDirectory, 0o500)
  const backup = await createPaperBackup(managed.record.paperKey, { libraryRoot: root })

  chmodTree(managed.recordDir, 0o700, 0o600)
  fs.rmSync(managed.recordDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
  await restorePaperBackup(backup.backupId, { libraryRoot: root })

  assert.equal(fs.statSync(managed.packageDir).mode & 0o777, 0o500)
  assert.equal(fs.statSync(emptyDirectory).mode & 0o777, 0o500)
  assert.equal(fs.existsSync(emptyDirectory), true)
  assert.throws(() => fs.writeFileSync(path.join(managed.packageDir, 'unexpected.txt'), 'unsafe'))
})

test('Doctor bounds hostile names, ignores Finder metadata, and keeps unrelated migration plans local', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'healthy-paper', '2.0.0')
  fs.writeFileSync(path.join(root, 'papers', '.DS_Store'), 'finder')
  fs.mkdirSync(path.join(root, 'papers', 'weird\nname'))
  fs.mkdirSync(path.join(root, 'papers', 'back\\slash'))
  const workspace = path.join(root, '.codex-paper/workspaces-v1/ws-hostile')
  fs.mkdirSync(workspace, { recursive: true })
  writeJson(path.join(workspace, 'workspace.json'), {
    workspaceId: `ws-${'x'.repeat(2048)}`,
    state: 'failed',
  })

  const report = inspectLibrary({ libraryRoot: root })
  assert.equal(report.status, 'errors')
  assert.equal(JSON.stringify(report).includes('\nname'), false)
  assert.equal(JSON.stringify(report).includes('back\\\\slash'), false)
  assert.equal(report.diagnostics.some((item) => item.path?.includes('.DS_Store')), false)
  assert.ok(report.items.every((item) => item.id.length <= 1024))

  const plan = buildMigrationPlan('healthy-paper', { libraryRoot: root })
  assert.equal(plan.doctor.blockers.some((item) => item.code === 'LEGACY_INDEX_SOURCE_INVALID'), false)
})

test('Doctor still detects target index drift when an unrelated source cannot be projected', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'drift-paper', '2.0.0')
  writeJson(path.join(root, 'index.json'), [{
    slug: 'drift-paper',
    title: 'Stale title',
  }])
  fs.mkdirSync(path.join(root, 'papers', '_scratch'))
  fs.mkdirSync(path.join(root, 'papers', 'broken-paper'))

  const report = inspectLibrary({ libraryRoot: root })
  assert.ok(report.diagnostics.some((item) => (
    item.code === 'LIBRARY_INDEX_DRIFT'
      && item.path === 'papers/drift-paper'
  )))
  assert.ok(report.diagnostics.some((item) => (
    item.code === 'LIBRARY_INDEX_DRIFT_UNDETERMINED'
      && item.path === 'papers/broken-paper'
  )))
  assert.equal(report.diagnostics.some((item) => (
    item.code === 'LIBRARY_INDEX_DRIFT_UNDETERMINED'
      && item.path === 'papers/_scratch'
  )), false)
  const plan = buildMigrationPlan('drift-paper', { libraryRoot: root })
  assert.equal(plan.eligibility, 'blocked')
  assert.ok(plan.doctor.blockers.some((item) => item.code === 'LIBRARY_INDEX_DRIFT'))
})

test('backup failure cleanup removes sealed private initialization trees', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'sealed-cleanup', '2.0.0')
  const nested = path.join(packageDir, '.codex-paper')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'record.json'), '{}\n')
  chmodTree(packageDir, 0o500, 0o400)

  await assert.rejects(
    () => createPaperBackup('sealed-cleanup', {
      libraryRoot: root,
      faultAt: 'after_payload_copy',
    }),
    { code: 'BACKUP_FAULT_INJECTED' },
  )
  const backupsRoot = path.join(root, '.codex-paper/backups-v1')
  assert.deepEqual(fs.readdirSync(backupsRoot), [])
})

test('long legal route diagnostics remain target-scoped and actionable', (t) => {
  const root = temporaryLibrary(t)
  const slug = `paper-${'a'.repeat(90)}`
  addLegacy(root, slug, '2.0.0')
  writeJson(path.join(root, 'index.json'), [{ slug, title: 'Stale long-title entry' }])

  const report = inspectLibrary({ libraryRoot: root })
  const drift = report.diagnostics.find((item) => item.code === 'LIBRARY_INDEX_DRIFT')
  assert.match(drift.path, /^papers\/paper-aaaaaaaa/)
  assert.match(drift.path, /-encoded-[a-f0-9]{32}$/)
  const plan = buildMigrationPlan(slug, { libraryRoot: root })
  assert.ok(plan.doctor.blockers.some((item) => item.code === 'LIBRARY_INDEX_DRIFT'))
})

test('Doctor report records backup verification depth in its intrinsic hash', (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'verification-depth', '2.0.0')
  const deep = inspectLibrary({ libraryRoot: root, now: '2026-07-31T00:00:00.000Z' })
  const shallow = inspectLibrary({
    libraryRoot: root,
    now: '2026-07-31T00:00:00.000Z',
    verifyBackupPayloads: false,
  })

  assert.equal(deep.payloadsVerified, true)
  assert.equal(shallow.payloadsVerified, false)
  assert.notEqual(deep.inventoryHash, shallow.inventoryHash)
  assert.equal(buildMigrationPlan('verification-depth', { libraryRoot: root }).doctor.payloadsVerified, false)
})

test('corrupt content-addressed backup is quarantined and recreated without deletion', async (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'quarantine-paper', '2.0.0')
  const first = await createPaperBackup('quarantine-paper', { libraryRoot: root })
  const backupRoot = path.join(root, '.codex-paper/backups-v1')
  fs.appendFileSync(path.join(backupRoot, first.backupId, 'payload/meta.json'), '\n')

  const recreated = await createPaperBackup('quarantine-paper', { libraryRoot: root })
  assert.equal(recreated.backupId, first.backupId)
  assert.equal(recreated.reused, false)
  assert.equal(verifyBackup(first.backupId, { libraryRoot: root }).verified, true)
  assert.ok(fs.readdirSync(backupRoot).some((entry) => entry.startsWith(`.invalid-${first.backupId}-`)))
  const report = inspectLibrary({ libraryRoot: root })
  assert.equal(report.status, 'warnings')
  assert.ok(report.diagnostics.some((item) => item.code === 'BACKUP_QUARANTINED' && item.severity === 'warning'))
})

test('migration dry-run reports missing and corrupt selected backups as blockers', async (t) => {
  const root = temporaryLibrary(t)
  addLegacy(root, 'backup-plan-paper', '2.0.0')
  const missingId = `bk-sha256-${'f'.repeat(64)}`
  const missing = buildMigrationPlan('backup-plan-paper', {
    libraryRoot: root,
    backupId: missingId,
  })
  assert.equal(missing.backup.status, 'not_found')
  assert.ok(missing.diagnostics.some((item) => item.code === 'MIGRATION_BACKUP_NOT_FOUND'))

  const created = await createPaperBackup('backup-plan-paper', { libraryRoot: root })
  fs.appendFileSync(
    path.join(root, '.codex-paper/backups-v1', created.backupId, 'payload/meta.json'),
    '\n',
  )
  const corrupt = buildMigrationPlan('backup-plan-paper', {
    libraryRoot: root,
    backupId: created.backupId,
  })
  assert.equal(corrupt.backup.status, 'invalid')
  assert.ok(corrupt.diagnostics.some((item) => item.code === 'MIGRATION_BACKUP_INVALID'))
})

test('unrelated corrupt restore journal is isolated from restore and recovery', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'journal-paper', '2.0.0')
  const backup = await createPaperBackup('journal-paper', { libraryRoot: root })
  const journalRoot = path.join(root, '.codex-paper/restore-transactions-v1')
  fs.mkdirSync(journalRoot, { recursive: true })
  fs.writeFileSync(path.join(journalRoot, `restore-${'f'.repeat(32)}.json`), '{broken')
  fs.rmSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.json'), '[]\n')

  const restored = await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(restored.restored, true)
  const recovery = await recoverBackupRestores({ libraryRoot: root })
  assert.equal(recovery.failed, 1)
  assert.equal(recovery.transactions[0].code, 'RESTORE_TRANSACTION_INVALID')
})

test('restore preserves the live index envelope and no-op restore preserves curated metadata', async (t) => {
  const root = temporaryLibrary(t)
  const packageDir = addLegacy(root, 'envelope-paper', '2.0.0')
  const backup = await createPaperBackup('envelope-paper', { libraryRoot: root })

  writeJson(path.join(root, 'index.json'), [{
    slug: 'envelope-paper',
    title: 'Curated title',
    tags: ['important'],
    progress: { read: true },
  }])
  const noOp = await restorePaperBackup(backup.backupId, { libraryRoot: root })
  assert.equal(noOp.alreadyPresent, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))[0].tags, ['important'])

  fs.rmSync(packageDir, { recursive: true })
  writeJson(path.join(root, 'index.json'), {
    schemaVersion: '1.0.0',
    generatedAt: '2026-07-30T00:00:00.000Z',
    papers: [{ slug: 'other-paper', title: 'Other' }],
  })
  await restorePaperBackup(backup.backupId, { libraryRoot: root })
  const restoredIndex = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))
  assert.equal(restoredIndex.schemaVersion, '1.0.0')
  assert.equal(restoredIndex.generatedAt, '2026-07-30T00:00:00.000Z')
  assert.deepEqual(restoredIndex.papers.map((entry) => entry.slug), ['envelope-paper', 'other-paper'])
})

test('Doctor emits one managed paper item and attaches generation enumeration failure', (t) => {
  const root = temporaryLibrary(t)
  const managed = addManagedGolden(root)
  const sourcesRoot = path.join(managed.recordDir, 'sources')
  fs.mkdirSync(path.join(sourcesRoot, 'unsafe-source'))
  const report = inspectLibrary({ libraryRoot: root })
  const paperItems = report.items.filter((item) => item.kind === 'managed_paper' && item.id === managed.record.paperKey)
  assert.equal(paperItems.length, 1)
  assert.equal(paperItems[0].state, 'invalid')
  assert.ok(paperItems[0].diagnostics.some((item) => item.code === 'SOURCE_RECORD_INVALID'))
})

test('all compatibility goldens traverse Doctor, backup, verify, and restore', async (t) => {
  for (const fixtureId of ['legacy-v1-flat', 'package-2.0-flat', 'package-2.1-flat']) {
    const root = temporaryLibrary(t)
    const slug = fixtureId.replaceAll('.', '-')
    const target = path.join(root, 'papers', slug)
    fs.cpSync(packagePath(fixtureId), target, { recursive: true, preserveTimestamps: true })
    const meta = JSON.parse(fs.readFileSync(path.join(target, 'meta.json'), 'utf8'))
    writeJson(path.join(root, 'index.json'), [{ ...meta, slug }])
    assert.ok(inspectLibrary({ libraryRoot: root }).items.some((item) => item.id === slug))
    const backup = await createPaperBackup(slug, { libraryRoot: root })
    assert.equal(verifyBackup(backup.backupId, { libraryRoot: root }).verified, true)
    fs.rmSync(target, { recursive: true })
    fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
    await restorePaperBackup(backup.backupId, { libraryRoot: root })
    assert.equal(fs.existsSync(target), true)
  }
  for (const fixtureId of ['managed-manifest-1-identity-1', 'managed-manifest-2-identity-2']) {
    const root = temporaryLibrary(t)
    const managed = addManagedGolden(root, fixtureId)
    assert.ok(inspectLibrary({ libraryRoot: root }).items.some((item) => item.id === managed.record.paperKey))
    const backup = await createPaperBackup(managed.record.paperKey, { libraryRoot: root })
    assert.equal(verifyBackup(backup.backupId, { libraryRoot: root }).verified, true)
    fs.rmSync(managed.recordDir, { recursive: true })
    fs.writeFileSync(path.join(root, 'index.json'), '[]\n')
    await restorePaperBackup(backup.backupId, { libraryRoot: root })
    assert.equal(fs.existsSync(managed.recordDir), true)
  }
})
