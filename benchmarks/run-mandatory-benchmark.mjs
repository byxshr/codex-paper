import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mandatoryTotalsPass, validateMandatoryManifest } from './mandatory/contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = process.env.MANDATORY_BENCHMARK_MANIFEST || path.join(__dirname, 'mandatory/manifest.json');
const reportPath = process.env.MANDATORY_BENCHMARK_REPORT_FILE || '/tmp/codex-paper-mandatory-benchmark.json';
const workerPath = path.join(__dirname, 'mandatory/run-fixture.mjs');
const generatorPath = path.join(__dirname, 'fixtures/generate-pdf-fixtures.py');

function writeReport(report) {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function makeTreeRemovable(root) {
  if (!fs.existsSync(root)) return;
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root)) makeTreeRemovable(path.join(root, entry));
  } else if (stats.isFile()) fs.chmodSync(root, 0o600);
}

function configurationFailure(errors) {
  const report = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    suite: 'mandatory-pdf-regression',
    configurationErrors: errors,
    totals: { declared: 0, executed: 0, completed: 0, passed: 0, failed: 0 },
    fixtures: []
  };
  writeReport(report);
  for (const error of errors) console.error(`Configuration error: ${error}`);
  console.error(`Mandatory benchmark report: ${reportPath}`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  configurationFailure([`mandatory manifest is unavailable or invalid: ${error.message}`]);
}

const validated = validateMandatoryManifest({ repoRoot, manifest });
if (validated.errors.length > 0) configurationFailure(validated.errors);

const python = process.env.CODEX_PAPER_PYTHON_BIN || 'python3';
const generatorCheck = spawnSync(python, [generatorPath, '--check'], { cwd: repoRoot, encoding: 'utf8' });
if (generatorCheck.status !== 0) {
  configurationFailure([String(generatorCheck.stdout || generatorCheck.stderr || 'deterministic fixture check failed').trim()]);
}

const fixtureResults = [];
for (const fixture of validated.fixtures) {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-paper-mandatory-${fixture.entry.id}-`));
  try {
    fs.mkdirSync(path.join(libraryRoot, 'papers'), { recursive: true });
    fs.writeFileSync(path.join(libraryRoot, 'index.json'), '[]\n');
    const worker = spawnSync(process.execPath, [workerPath, fixture.entry.id, fixture.pdfPath, fixture.licensePath, fixture.goldPath], {
      cwd: repoRoot,
      env: { ...process.env, PAPERS_DIR: libraryRoot },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    let result;
    try {
      result = JSON.parse(String(worker.stdout || '').trim());
    } catch {
      result = {
        fixtureId: fixture.entry.id,
        executed: false,
        completed: false,
        pass: false,
        error: `fixture worker failed without a valid report (exit ${worker.status ?? 'unknown'})`
      };
    }
    fixtureResults.push(result);
  } finally {
    makeTreeRemovable(libraryRoot);
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
}

const totals = {
  declared: validated.fixtures.length,
  executed: fixtureResults.filter((result) => result.executed).length,
  completed: fixtureResults.filter((result) => result.completed).length,
  passed: fixtureResults.filter((result) => result.pass).length,
  failed: fixtureResults.filter((result) => !result.pass).length
};
const report = {
  schemaVersion: '1.0.0',
  generatedAt: new Date().toISOString(),
  suite: 'mandatory-pdf-regression',
  totals,
  fixtures: fixtureResults
};
writeReport(report);

console.log(`Mandatory benchmark report: ${reportPath}`);
console.log(`Declared: ${totals.declared}; executed: ${totals.executed}; completed: ${totals.completed}; passed: ${totals.passed}; failed: ${totals.failed}`);
for (const result of fixtureResults) {
  console.log(`- ${result.fixtureId}: ${result.pass ? 'PASS' : 'FAIL'}`);
  for (const code of result.observedFindings || []) console.log(`  expected finding observed: ${code}`);
  for (const code of result.missingExpectedFindings || []) console.log(`  XPASS / contract drift: ${code}`);
  if (result.error) console.log(`  error: ${result.error}`);
  for (const diagnostic of result.diagnostics || []) console.log(`  diagnostic: ${diagnostic}`);
}

process.exit(mandatoryTotalsPass(totals) ? 0 : 1);
