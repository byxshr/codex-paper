import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  mandatoryTotalsPass,
  parseProjectedResultValue,
  validateMandatoryManifest,
  validateReservedTargets,
  validateValidationReportTarget
} from '../../benchmarks/mandatory/contract.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = path.join(repoRoot, 'benchmarks/mandatory/manifest.json');

test('canonical mandatory fixture contract passes configuration validation', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = validateMandatoryManifest({ repoRoot, manifest });
  assert.deepEqual(result.errors, []);
  assert.equal(result.fixtures.length, 2);
});

test('mandatory fixture contract rejects zero declared fixtures', () => {
  const result = validateMandatoryManifest({ repoRoot, manifest: { schemaVersion: '1.0.0', fixtures: [] } });
  assert.match(result.errors.join('\n'), /at least one fixture/);
});

test('missing mandatory PDF remains fatal even when optional corpus skipping is enabled', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.fixtures[0].pdf = 'benchmarks/fixtures/pdf/does-not-exist.pdf';
  process.env.CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS = '1';
  try {
    const result = validateMandatoryManifest({ repoRoot, manifest });
    assert.match(result.errors.join('\n'), /PDF is missing/);
  } finally {
    delete process.env.CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS;
  }
});

test('Validation Report 1.0 target rejects a missing active warning', () => {
  const report = {
    schemaVersion: '1.0.0',
    status: 'pass_with_warnings',
    phase: 'complete',
    publishable: true,
    findings: [],
    gate: { policy: 'standard', outcome: 'allow_publish' },
    reportHash: { value: 'a'.repeat(64) }
  };
  const errors = validateValidationReportTarget(report, {
    expectedStatus: 'pass_with_warnings',
    expectedFindingCodes: ['PARSER_FRONT_MATTER_CONTAMINATION']
  });
  assert.match(errors.join('\n'), /PARSER_FRONT_MATTER_CONTAMINATION/);
});

test('active ResultClaim targets require evidence-backed values and B3 warning semantics', () => {
  const gold = JSON.parse(fs.readFileSync(path.join(repoRoot, 'benchmarks/mandatory/gold/result-conflict.json'), 'utf8'));
  assert.deepEqual(validateReservedTargets(gold, '28.4 BLEU and 41.8 BLEU'), []);
  assert.match(validateReservedTargets(gold, '28.4 BLEU').join('\n'), /41\.8/);
});

test('mandatory totals reject all zero, partial execution, and any failed fixture', () => {
  assert.equal(mandatoryTotalsPass({ declared: 0, executed: 0, completed: 0, passed: 0, failed: 0 }), false);
  assert.equal(mandatoryTotalsPass({ declared: 2, executed: 1, completed: 1, passed: 1, failed: 1 }), false);
  assert.equal(mandatoryTotalsPass({ declared: 2, executed: 2, completed: 2, passed: 1, failed: 1 }), false);
  assert.equal(mandatoryTotalsPass({ declared: 2, executed: 2, completed: 2, passed: 2, failed: 0 }), true);
});

test('keyResults projection comparison accepts percent values without accepting junk suffixes', () => {
  assert.equal(parseProjectedResultValue('95.2%'), 95.2);
  assert.equal(parseProjectedResultValue('41.0'), 41);
  assert.equal(Number.isNaN(parseProjectedResultValue('41.0 BLEU')), true);
});

test('mandatory CLI returns exit 2 and a report for an empty manifest', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-mandatory-test-'));
  try {
    const emptyManifest = path.join(tempRoot, 'manifest.json');
    const reportPath = path.join(tempRoot, 'report.json');
    fs.writeFileSync(emptyManifest, '{"schemaVersion":"1.0.0","fixtures":[]}\n');
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'benchmarks/run-mandatory-benchmark.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MANDATORY_BENCHMARK_MANIFEST: emptyManifest,
        MANDATORY_BENCHMARK_REPORT_FILE: reportPath
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 2);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.totals.executed, 0);
    assert.match(report.configurationErrors.join('\n'), /at least one fixture/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deterministic PDF generator reproduces committed fixtures byte-for-byte', () => {
  const result = spawnSync('python3', [path.join(repoRoot, 'benchmarks/fixtures/generate-pdf-fixtures.py'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.match(result.stdout, /2 deterministic PDF fixture/);
});
