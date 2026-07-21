import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  LibraryLayoutError,
  readOverlayState,
  reconcilePaperRecord,
  resolveExplicitPackage,
  resolveLibraryPaper,
} from '../../plugins/codex-paper/src/shared/paper-library.mjs'
import { canWriteValidationReport } from '../../plugins/codex-paper/skills/study/scripts/validation-report.js'
import { buildAnalysisForPaperDir } from '../../plugins/codex-paper/skills/study/scripts/build-analysis.js'
import { renderMaterialsForPaper } from '../../plugins/codex-paper/skills/study/scripts/render-from-analysis.js'
import { buildExecutionPlan } from '../../plugins/codex-paper/skills/study/scripts/sandbox-code.js'
import { scaffoldReasoningAnalysis } from '../../plugins/codex-paper/skills/study/scripts/scaffold-reasoning-analysis.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prepareScript = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
const fixturePdf = path.join(repoRoot, 'benchmarks/fixtures/pdf/front-matter-noise.pdf')

function prepare(library, extra = [], input = fixturePdf) {
  const result = spawnSync(process.execPath, [prepareScript, input, '--workflow', 'study', '--language', 'en', '--context', 'paper-only', '--profile', 'auto', ...extra], {
    encoding: 'utf8', env: { ...process.env, PAPERS_DIR: library }, timeout: 30_000
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function fileSnapshot(root) {
  const output = {}
  function walk(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const itemPath = path.join(current, entry.name)
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name
      const stats = fs.lstatSync(itemPath, { bigint: true })
      if (entry.isSymbolicLink()) output[itemRelative] = { type: 'symlink', target: fs.readlinkSync(itemPath), mtimeNs: String(stats.mtimeNs) }
      else if (entry.isDirectory()) { output[itemRelative] = { type: 'directory', mtimeNs: String(stats.mtimeNs) }; walk(itemPath, itemRelative) }
      else output[itemRelative] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(itemPath)).digest('hex'), mtimeNs: String(stats.mtimeNs), mode: Number(stats.mode) }
    }
  }
  walk(root)
  return output
}

test('shared resolver resolves route, paper ID, and current generation to one stable descriptor', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-current-'))
  try {
    const output = prepare(library)
    const byRoute = resolveLibraryPaper(output.paperSlug, { libraryRoot: library })
    const byPaperId = resolveLibraryPaper(output.identity.paperId, { libraryRoot: library })
    assert.equal(byRoute.mode, 'managed_v1')
    assert.equal(byRoute.packageDir, fs.realpathSync(output.paperDir))
    assert.equal(byPaperId.packageDir, fs.realpathSync(output.paperDir))
    assert.equal(byRoute.paperLockKey, byPaperId.paperLockKey)
    assert.equal(byRoute.generationLockKey, byPaperId.generationLockKey)
  } finally { fs.rmSync(library, { recursive: true, force: true }) }
})

test('current is authoritative and corrupt or stale current fails closed', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-tamper-'))
  try {
    const output = prepare(library)
    const descriptor = resolveLibraryPaper(output.paperSlug, { libraryRoot: library })
    const currentPath = path.join(descriptor.paperRoot, 'current.json')
    const current = JSON.parse(fs.readFileSync(currentPath))
    fs.writeFileSync(currentPath, `${JSON.stringify({ ...current, generationId: `gen:sha256:${'0'.repeat(64)}` }, null, 2)}\n`)
    assert.throws(() => resolveLibraryPaper(output.paperSlug, { libraryRoot: library }), (error) => error instanceof LibraryLayoutError && error.code === 'CURRENT_RECORD_INVALID')
  } finally { fs.rmSync(library, { recursive: true, force: true }) }
})

test('legacy flat packages are read-only and resolver reads are zero-write', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-legacy-'))
  try {
    const paperDir = path.join(library, 'papers/legacy-paper')
    fs.mkdirSync(paperDir, { recursive: true })
    fs.writeFileSync(path.join(paperDir, 'meta.json'), '{"packageVersion":"2.1.0","tags":["kept"]}\n')
    const before = fileSnapshot(library)
    const descriptor = resolveLibraryPaper('legacy-paper', { libraryRoot: library })
    assert.equal(descriptor.mode, 'legacy_flat')
    assert.equal(descriptor.readOnly, true)
    const previous = process.env.PAPERS_DIR
    process.env.PAPERS_DIR = library
    try { assert.equal(canWriteValidationReport(paperDir), false) } finally {
      if (previous === undefined) delete process.env.PAPERS_DIR
      else process.env.PAPERS_DIR = previous
    }
    assert.deepEqual(fileSnapshot(library), before)
    assert.equal(fs.existsSync(path.join(library, '.codex-paper')), false)
  } finally { fs.rmSync(library, { recursive: true, force: true }) }
})

test('explicit legacy package paths stay read-only for every mutating CLI consumer', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-explicit-legacy-'))
  const previous = process.env.PAPERS_DIR
  try {
    const paperDir = path.join(library, 'papers/legacy-paper')
    fs.mkdirSync(path.join(paperDir, 'code'), { recursive: true })
    fs.writeFileSync(path.join(paperDir, 'meta.json'), '{"packageVersion":"2.1.0"}\n')
    fs.writeFileSync(path.join(paperDir, 'code/demo.js'), 'console.log("must not run")\n')
    const before = fileSnapshot(library)
    process.env.PAPERS_DIR = library

    const descriptor = resolveExplicitPackage(paperDir, { libraryRoot: library })
    assert.equal(descriptor.mode, 'legacy_flat')
    assert.equal(descriptor.readOnly, true)
    for (const writer of [buildAnalysisForPaperDir, renderMaterialsForPaper, scaffoldReasoningAnalysis]) {
      assert.throws(() => writer(paperDir), /LEGACY_LAYOUT_READ_ONLY/)
    }
    const plan = buildExecutionPlan(paperDir, { env: { ...process.env, PAPERS_DIR: library }, issueApproval: false })
    assert.equal(plan.capability.status, 'nonconformant')
    assert.match(plan.capability.reason, /read-only/)
    assert.equal(plan.approval, null)
    assert.deepEqual(fileSnapshot(library), before)
  } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previous
    fs.rmSync(library, { recursive: true, force: true })
  }
})

test('new generation becomes current without changing paper overlay or old generation', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-overlay-'))
  try {
    const first = prepare(library)
    const descriptor = resolveLibraryPaper(first.paperSlug, { libraryRoot: library })
    const statePath = path.join(descriptor.overlayDir, 'state.json')
    const state = readOverlayState(descriptor)
    fs.writeFileSync(statePath, `${JSON.stringify({ ...state, tags: ['preserved'] }, null, 2)}\n`)
    const oldPackage = fileSnapshot(first.paperDir)
    const second = prepare(library, ['--language', 'zh'])
    const current = resolveLibraryPaper(first.paperSlug, { libraryRoot: library })
    assert.equal(current.packageDir, fs.realpathSync(second.paperDir))
    assert.deepEqual(readOverlayState(current).tags, ['preserved'])
    assert.deepEqual(fileSnapshot(first.paperDir), oldPackage)
    const reusedOld = prepare(library)
    assert.equal(reusedOld.action, 'reused')
    assert.equal(resolveLibraryPaper(first.paperSlug, { libraryRoot: library }).packageDir, fs.realpathSync(second.paperDir))
  } finally { fs.rmSync(library, { recursive: true, force: true }) }
})

test('record and current path symlinks are rejected', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-layout-symlink-'))
  try {
    const output = prepare(library)
    const descriptor = resolveLibraryPaper(output.paperSlug, { libraryRoot: library })
    const currentPath = path.join(descriptor.paperRoot, 'current.json')
    const external = path.join(library, 'external.json')
    fs.renameSync(currentPath, external)
    fs.symlinkSync(external, currentPath)
    assert.throws(() => resolveLibraryPaper(output.paperSlug, { libraryRoot: library }), (error) => error instanceof LibraryLayoutError && error.statusCode === 403)
  } finally { fs.rmSync(library, { recursive: true, force: true }) }
})

test('local-first and canonical-first reconciliation converge without moving storage keys', () => {
  const sourcePaperId = `source:sha256:${'a'.repeat(64)}`
  const canonicalPaperId = 'arxiv:1706.03762'
  const sourceRevisionId = `sha256:${'a'.repeat(64)}`
  const generationId = `gen:sha256:${'b'.repeat(64)}`
  const base = (paperId) => ({
    schemaVersion: '1.0.0', paperKey: `p-${crypto.createHash('sha256').update(paperId).digest('hex')}`,
    primaryPaperId: paperId, paperIdAliases: [paperId], routeAliases: ['paper'],
    createdAt: new Date(0).toISOString(), reconciliations: []
  })
  const localFirst = reconcilePaperRecord(base(sourcePaperId), canonicalPaperId, { sourceRevisionId, generationId, at: new Date(1).toISOString() })
  const canonicalFirst = reconcilePaperRecord(base(canonicalPaperId), sourcePaperId, { sourceRevisionId, generationId, at: new Date(1).toISOString() })
  assert.equal(localFirst.primaryPaperId, canonicalPaperId)
  assert.equal(canonicalFirst.primaryPaperId, canonicalPaperId)
  assert.deepEqual(localFirst.paperIdAliases, canonicalFirst.paperIdAliases)
  assert.notEqual(localFirst.paperKey, canonicalFirst.paperKey)
  assert.equal(localFirst.reconciliations.length, 1)
})
