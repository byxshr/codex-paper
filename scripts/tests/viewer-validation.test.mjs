import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-viewer-validation-'))
process.env.PAPERS_DIR = library
const { readStoredValidationReport } = await import('../../plugins/codex-paper/src/web/server/utils/validationReport.mjs')
const { createValidationReport } = await import('../../plugins/codex-paper/skills/study/scripts/validation-report.js')

function paper(slug) {
  const directory = path.join(library, 'papers', slug, '.codex-paper')
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

test.after(() => fs.rmSync(library, { recursive: true, force: true }))

test('Viewer reports a missing validation report without throwing', () => {
  paper('missing-report')
  const result = readStoredValidationReport('missing-report')
  assert.equal(result.available, false)
  assert.equal(result.diagnostics[0].code, 'VALIDATION_REPORT_MISSING')
})

test('Viewer returns bounded Validation Report 1.0 fields', () => {
  const directory = paper('valid-report')
  const report = createValidationReport({ phase: 'complete' })
  fs.writeFileSync(path.join(directory, 'validation-report.json'), `${JSON.stringify(report)}\n`)
  const result = readStoredValidationReport('valid-report')
  assert.equal(result.available, true)
  assert.equal(result.schemaVersion, '1.0.0')
  assert.equal(result.status, 'pass')
  assert.equal(result.publishable, true)
  assert.equal(result.gate.outcome, 'allow_publish')
})

test('Viewer marks legacy reports non-publishable', () => {
  const directory = paper('legacy-report')
  fs.writeFileSync(path.join(directory, 'validation-report.json'), '{"status":"pass","errors":[],"warnings":[]}\n')
  const result = readStoredValidationReport('legacy-report')
  assert.equal(result.available, true)
  assert.equal(result.legacy, true)
  assert.equal(result.publishable, false)
  assert.equal(result.diagnostics[0].code, 'VALIDATION_REPORT_LEGACY')
})

test('Viewer returns safe diagnostics for invalid report JSON', () => {
  const directory = paper('invalid-report')
  fs.writeFileSync(path.join(directory, 'validation-report.json'), '{not-json')
  const result = readStoredValidationReport('invalid-report')
  assert.equal(result.available, false)
  assert.equal(result.diagnostics[0].code, 'VALIDATION_REPORT_INVALID')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
