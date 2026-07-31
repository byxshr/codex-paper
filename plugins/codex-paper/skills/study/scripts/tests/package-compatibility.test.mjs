import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyInvalidPackageArtifacts, classifyPackageCompatibility, resolveEvidenceRefs } from '../../../../src/shared/package-compatibility.mjs';
import { buildAnalysisForPaperDir, buildAnalysisFromArtifacts } from '../build-analysis.js';
import { renderMaterialsForPaper } from '../render-from-analysis.js';
import { scaffoldReasoningAnalysis } from '../scaffold-reasoning-analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('package compatibility classifies native, previous, legacy, inferred, and unknown versions', () => {
  assert.equal(classifyPackageCompatibility({ meta: { packageVersion: '2.1.0' } }).mode, 'native_2_1');
  assert.equal(classifyPackageCompatibility({ meta: { packageVersion: '2.0.0' } }).mode, 'compatible_2_0');
  assert.equal(classifyPackageCompatibility({}).mode, 'legacy_v1');
  assert.equal(classifyPackageCompatibility({ ledger: { schemaVersion: '2.0.0' } }).mode, 'compatible_2_0');
  assert.equal(classifyPackageCompatibility({ reasoning: { schemaVersion: '3.0.0' } }).mode, 'unknown_read_only');
  assert.equal(classifyPackageCompatibility({ reasoning: {} }).mode, 'unknown_read_only');
  assert.equal(classifyPackageCompatibility({ reasoning: {}, ledger: { schemaVersion: '2.0.0' } }).mode, 'unknown_read_only');
  assert.equal(classifyPackageCompatibility({ reasoning: { schemaVersion: '2.1.0' }, ledger: { schemaVersion: '2.1.0' } }).mode, 'unknown_read_only');
  assert.equal(classifyInvalidPackageArtifacts(['meta.json']).diagnostics[0].code, 'PACKAGE_ARTIFACT_INVALID');
  const mixed = classifyPackageCompatibility({ reasoning: { schemaVersion: '2.0.0' }, ledger: { schemaVersion: '3.0.0' } });
  assert.equal(mixed.mode, 'unknown_read_only');
  assert.match(mixed.diagnostics[0].message, /3\.0\.0/);
  assert.doesNotMatch(mixed.diagnostics[0].message, /unsupported or missing version: 2\.0\.0/);
  const unknown = classifyPackageCompatibility({ meta: { packageVersion: '9.0.0' } });
  assert.equal(unknown.mode, 'unknown_read_only');
  assert.equal(unknown.diagnostics[0].code, 'PACKAGE_VERSION_UNSUPPORTED');
});

test('all artifact writers reject compatible 2.0 packages without changing files', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-read-only-'));
  try {
    fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ packageVersion: '2.0.0', slug: 'x' }));
    fs.writeFileSync(path.join(paperDir, 'evidence-ledger.json'), JSON.stringify({ schemaVersion: '2.0.0', paperSlug: 'x', evidence: [], sections: [] }));
    fs.writeFileSync(path.join(paperDir, 'paper-data.json'), JSON.stringify({ paperSlug: 'x', title: 'x' }));
    fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify({ coreClaims: [], keyResults: [], limitations: [] }));
    fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify({}));
    const before = new Map(fs.readdirSync(paperDir).map((name) => [name, fs.readFileSync(path.join(paperDir, name), 'utf8')]));

    for (const writer of [buildAnalysisForPaperDir, renderMaterialsForPaper, scaffoldReasoningAnalysis]) {
      assert.throws(() => writer(paperDir), /PACKAGE_VERSION_READ_ONLY/);
    }

    assert.deepEqual(new Set(fs.readdirSync(paperDir)), new Set(before.keys()));
    for (const [name, content] of before) assert.equal(fs.readFileSync(path.join(paperDir, name), 'utf8'), content);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});

test('legacy fact references resolve in memory without changing facts', () => {
  const facts = { coreClaims: [{ evidenceRefs: ['ev-p001-par-aaaaaaaaaa'] }], keyResults: [], limitations: [] };
  const ledger = { evidence: [{ id: 'ev-p001-par-aaaaaaaaaa' }] };
  const before = JSON.stringify(facts);
  assert.deepEqual(resolveEvidenceRefs(['claim:0'], facts, ledger), ['ev-p001-par-aaaaaaaaaa']);
  assert.deepEqual(resolveEvidenceRefs(['ev-p001-par-aaaaaaaaaa'], facts, ledger), ['ev-p001-par-aaaaaaaaaa']);
  assert.deepEqual(resolveEvidenceRefs(['ev-p999-par-abcdef0123'], facts, ledger), []);
  assert.equal(JSON.stringify(facts), before);
});

test('legacy v1 analysis and rendering remain explicitly read-only', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-legacy-read-only-'));
  try {
    fs.writeFileSync(path.join(paperDir, 'paper-data.json'), JSON.stringify({ paperSlug: 'x', title: 'x' }));
    fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify({ coreClaims: [], keyResults: [], limitations: [] }));
    fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify({}));
    const before = new Map(fs.readdirSync(paperDir).map((name) => [name, fs.readFileSync(path.join(paperDir, name), 'utf8')]));
    assert.throws(() => buildAnalysisForPaperDir(paperDir), /PACKAGE_VERSION_READ_ONLY/);
    assert.throws(() => renderMaterialsForPaper(paperDir), /PACKAGE_VERSION_READ_ONLY/);
    assert.deepEqual(new Set(fs.readdirSync(paperDir)), new Set(before.keys()));
    for (const [name, content] of before) assert.equal(fs.readFileSync(path.join(paperDir, name), 'utf8'), content);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});

test('analysis evidence fallback respects the requested reference limit', () => {
  const refs = [
    'ev-p001-par-aaaaaaaaaa',
    'ev-p001-par-bbbbbbbbbb',
    'ev-p001-par-cccccccccc'
  ];
  const analysis = buildAnalysisFromArtifacts({
    paperSlug: 'limit-fixture',
    title: 'Limit Fixture',
    parserVersion: 'test',
    sections: { abstract: 'The system reports state-of-the-art performance.' }
  }, {
    coreClaims: [{ text: 'An unrelated method claim.', evidenceRefs: refs }],
    keyResults: [],
    limitations: []
  });
  assert.equal(analysis.resultsTable[0].evidenceRefs.length, 2);
  assert.deepEqual(analysis.resultsTable[0].evidenceRefs, refs.slice(0, 2));
});

test('unknown package version prevents renderer writes', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-compat-'));
  try {
    fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ packageVersion: '9.0.0' }));
    fs.writeFileSync(path.join(paperDir, 'evidence-ledger.json'), JSON.stringify({ schemaVersion: '2.0.0' }));
    fs.writeFileSync(path.join(paperDir, 'paper-data.json'), JSON.stringify({ paperSlug: 'x', title: 'x' }));
    fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify({ coreClaims: [], keyResults: [], limitations: [] }));
    fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify({}));
    const before = new Set(fs.readdirSync(paperDir));
    assert.throws(() => renderMaterialsForPaper(paperDir), /PUBLISHED_GENERATION_READ_ONLY/);
    assert.deepEqual(new Set(fs.readdirSync(paperDir)), before);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});

test('study validator reports unknown versions as a validation failure without writes', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-validator-compat-'));
  try {
    const metaPath = path.join(paperDir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ packageVersion: '9.0.0' }));
    const before = fs.readFileSync(metaPath, 'utf8');
    const result = spawnSync(process.execPath, [path.resolve(here, '../validate-study-package.js'), paperDir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PACKAGE_VERSION_UNSUPPORTED/);
    assert.equal(fs.readFileSync(metaPath, 'utf8'), before);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});

test('versioned reasoning artifacts without meta cannot fall back to legacy validation', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-validator-artifact-'));
  try {
    fs.writeFileSync(path.join(paperDir, 'reasoning-analysis.json'), JSON.stringify({ schemaVersion: '3.0.0' }));
    const result = spawnSync(process.execPath, [path.resolve(here, '../validate-study-package.js'), paperDir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PACKAGE_VERSION_UNSUPPORTED/);
    assert.doesNotMatch(result.stdout, /v2 reasoning validation was skipped/);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});

test('study validator reports corrupt package metadata instead of inferring 2.0 compatibility', () => {
  const paperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-validator-corrupt-meta-'));
  try {
    fs.writeFileSync(path.join(paperDir, 'meta.json'), '{not-json');
    fs.writeFileSync(path.join(paperDir, 'reasoning-analysis.json'), JSON.stringify({ schemaVersion: '2.0.0' }));
    fs.writeFileSync(path.join(paperDir, 'evidence-ledger.json'), JSON.stringify({ schemaVersion: '2.0.0' }));
    const result = spawnSync(process.execPath, [path.resolve(here, '../validate-study-package.js'), paperDir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PACKAGE_ARTIFACT_INVALID/);
    assert.match(result.stdout, /meta\.json/);
    assert.doesNotMatch(result.stdout, /PACKAGE_VERSION_INFERRED/);
  } finally {
    fs.rmSync(paperDir, { recursive: true, force: true });
  }
});
