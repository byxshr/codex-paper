import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateMigrationPlanDocument } from '../../../../src/shared/library-maintenance.mjs'

const MIGRATE_SCRIPT = path.resolve('plugins/codex-paper/skills/study/scripts/migrate-package.js')

function fixture(t, version = null) {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-frozen-'))
  const packageDir = path.join(libraryRoot, 'papers', 'legacy-paper')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'meta.json'), `${JSON.stringify({
    slug: 'legacy-paper',
    title: 'Legacy Paper',
    ...(version ? { packageVersion: version } : {}),
  })}\n`)
  fs.writeFileSync(path.join(libraryRoot, 'index.json'), '[]\n')
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  return { libraryRoot, packageDir }
}

function snapshot(packageDir) {
  return fs.readdirSync(packageDir).sort().map((name) => [name, fs.readFileSync(path.join(packageDir, name), 'utf8'), fs.statSync(path.join(packageDir, name)).mtimeMs])
}

function run(libraryRoot, args) {
  return spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: libraryRoot },
  })
}

test('legacy migration execution is frozen without writing package artifacts', (t) => {
  const { libraryRoot, packageDir } = fixture(t)
  const before = snapshot(packageDir)
  const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, 'legacy-paper'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: libraryRoot },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /MIGRATION_EXECUTION_DEFERRED/)
  assert.deepEqual(snapshot(packageDir), before)
})

test('missing paper reference cannot bypass the execution freeze', (t) => {
  const { libraryRoot } = fixture(t)
  const result = run(libraryRoot, [])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /MIGRATION_EXECUTION_DEFERRED/)
})

test('duplicate dry-run option is rejected', (t) => {
  const { libraryRoot } = fixture(t)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--dry-run'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ARGUMENT_INVALID/)
})

test('duplicate JSON option is rejected', (t) => {
  const { libraryRoot } = fixture(t)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--json', '--json'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ARGUMENT_INVALID/)
})

test('backup option requires a value', (t) => {
  const { libraryRoot } = fixture(t)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--backup-id'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ARGUMENT_INVALID/)
})

test('duplicate backup options are rejected', (t) => {
  const { libraryRoot } = fixture(t)
  const id = `bk-sha256-${'a'.repeat(64)}`
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--backup-id', id, '--backup-id', id])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ARGUMENT_INVALID/)
})

test('unknown dry-run options are rejected', (t) => {
  const { libraryRoot } = fixture(t)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--unknown'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ARGUMENT_INVALID/)
})

test('external filesystem paths remain outside migration policy', (t) => {
  const { libraryRoot, packageDir } = fixture(t)
  const before = snapshot(packageDir)
  const result = run(libraryRoot, [packageDir, '--dry-run'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /BACKUP_TARGET_INVALID/)
  assert.deepEqual(snapshot(packageDir), before)
})

test('unknown package version produces a blocked zero-write plan', (t) => {
  const { libraryRoot, packageDir } = fixture(t, '9.0.0')
  const before = snapshot(packageDir)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.eligibility, 'blocked')
  assert.ok(plan.diagnostics.some((item) => item.code === 'PACKAGE_VERSION_UNSUPPORTED'))
  assert.deepEqual(snapshot(packageDir), before)
})

test('corrupt package metadata is diagnosed without migration writes', (t) => {
  const { libraryRoot, packageDir } = fixture(t)
  fs.writeFileSync(path.join(packageDir, 'meta.json'), '{broken')
  const before = snapshot(packageDir)
  const result = run(libraryRoot, ['legacy-paper', '--dry-run', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.eligibility, 'blocked')
  assert.ok(plan.diagnostics.some((item) => item.code === 'PACKAGE_ARTIFACT_INVALID'))
  assert.deepEqual(snapshot(packageDir), before)
})

test('legacy migrate --dry-run delegates to the read-only P1-2b planner', (t) => {
  const { libraryRoot, packageDir } = fixture(t, '2.0.0')
  const before = snapshot(packageDir)
  const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, 'legacy-paper', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: libraryRoot },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.schemaVersion, '1.1.0')
  assert.equal(plan.executionAvailable, false)
  assert.equal(plan.backup.status, 'missing')
  assert.equal(plan.diagnostics.some((item) => item.code === 'MIGRATION_BACKUP_REQUIRED'), true)
  assert.deepEqual(snapshot(packageDir), before)
})

test('Migration Plan 1.0 remains a read-only compatibility document', () => {
  const hash = 'a'.repeat(64)
  const document = {
    schemaVersion: '1.0.0',
    target: { kind: 'legacy_flat', relativePath: 'papers/legacy-paper', paperKey: null, routeSlug: 'legacy-paper' },
    source: {
      layoutMode: 'legacy_flat', compatibilityMode: 'compatible_2_0', packageVersion: '2.0.0',
      identityVersion: null, manifestVersion: null, manifestVerified: false, snapshotHash: hash,
    },
    doctor: { status: 'warnings', payloadsVerified: false, inventoryHash: hash, blockers: [] },
    backup: { required: true, status: 'missing', backupId: null },
    targetContract: {
      packageVersion: '2.1.0', identityVersion: '2.0.0',
      generationManifestVersion: '2.0.0', generationContractVersion: '2.0.0',
    },
    actions: ['verify_backup'],
    eligibility: 'ready_for_p1_2b',
    executionAvailable: false,
    diagnostics: [{ code: 'MIGRATION_EXECUTION_DEFERRED', severity: 'warning', message: 'Execution is deferred.' }],
  }
  const before = JSON.stringify(document)
  const result = validateMigrationPlanDocument(document)
  assert.equal(result.compatibilityMode, 'compatible_1_0')
  assert.equal(result.readOnly, true)
  assert.equal(JSON.stringify(document), before)
  assert.throws(
    () => validateMigrationPlanDocument({ ...document, schemaVersion: '9.0.0' }),
    (error) => error.code === 'MIGRATION_PLAN_VERSION_UNSUPPORTED',
  )
})

test('removed in-place migration flags are rejected without side effects', (t) => {
  for (const flag of ['--force', '--external-path', '--context', '--profile']) {
    const { libraryRoot, packageDir } = fixture(t)
    const before = snapshot(packageDir)
    const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, 'legacy-paper', '--dry-run', flag], {
      encoding: 'utf8',
      env: { ...process.env, PAPERS_DIR: libraryRoot },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /ARGUMENT_INVALID/)
    assert.deepEqual(snapshot(packageDir), before)
  }
})
