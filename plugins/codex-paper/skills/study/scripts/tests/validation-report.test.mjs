import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  createValidationReport,
  inspectPackageArtifacts,
  makeFinding,
  persistWorkspaceValidationReport,
  validateReport,
  writeValidationReportAtomic
} from '../validation-report.js';
import { buildPaperIdentity, canonicalStringify, identityProjection } from '../paper-identity.js';

const EVIDENCE_A = 'ev-p001-par-aaaaaaaaaa';
const EVIDENCE_B = 'ev-p001-par-bbbbbbbbbb';

function warning(code = 'TEST_WARNING') {
  return makeFinding({
    severity: 'warning',
    code,
    category: 'package',
    artifact: 'facts.json',
    path: '/',
    message: 'A deterministic warning.'
  });
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writableWorkspaceFixture(prefix = 'codex-paper-validation-workspace-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceId = 'ws-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccccccccccccccccccc';
  const workspaceDir = path.join(root, '.codex-paper', 'workspaces-v1', workspaceId);
  const packageDir = path.join(workspaceDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(workspaceDir, 'workspace.json', {
    schemaVersion: '1.0.0', workspaceId, state: 'authoring', paperKey: `p-${'3'.repeat(64)}`,
    paperId: `source:sha256:${'1'.repeat(64)}`, sourceRevisionId: `sha256:${'1'.repeat(64)}`,
    generationId: `gen:sha256:${'2'.repeat(64)}`,
    targetPackageRelativePath: `sources/sha256-${'1'.repeat(64)}/generations/gen-sha256-${'2'.repeat(64)}/package`,
    routeSlug: 'validation-fixture', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    lastSuccessfulStep: 'initialized', diagnostics: [], publishIntent: { paperRecord: {}, reconciliation: null, tags: [] }
  });
  return { root, workspaceDir, packageDir };
}

function withLibraryRoot(libraryRoot, operation) {
  const previous = process.env.PAPERS_DIR;
  process.env.PAPERS_DIR = libraryRoot;
  try { return operation(); } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR;
    else process.env.PAPERS_DIR = previous;
  }
}

function makePackage({ reasoningDisclose = true, visibleDisclose = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-validation-'));
  const evidence = [
    {
      id: EVIDENCE_A,
      kind: 'table',
      roles: ['result'],
      text: 'On WMT 2014 EN-FR, the model achieves 41.8 BLEU.',
      quote: 'On WMT 2014 EN-FR, the model achieves 41.8 BLEU.',
      location: { page: 1, sectionId: null, charStart: 0, charEnd: 50, blockIndex: 0, bbox: null },
      labels: { figureNumber: null, tableNumber: 'Table 2', equationNumber: null },
      source: 'paper',
      confidence: 'high'
    },
    {
      id: EVIDENCE_B,
      kind: 'paragraph',
      roles: ['result'],
      text: 'The prose reports 41.0 BLEU for EN-FR, conflicting with Table 2.',
      quote: 'The prose reports 41.0 BLEU for EN-FR, conflicting with Table 2.',
      location: { page: 1, sectionId: null, charStart: 51, charEnd: 115, blockIndex: 1, bbox: null },
      labels: { figureNumber: null, tableNumber: null, equationNumber: null },
      source: 'paper',
      confidence: 'high'
    }
  ];
  const claims = [
    {
      task: 'machine translation', dataset: 'WMT 2014', split: null, languagePair: 'EN-FR',
      metric: 'BLEU', value: 41.8, unit: 'score', model: null, comparator: 'single-model state-of-the-art',
      direction: 'higher_is_better', location: { page: 1, table: 2 },
      evidenceRefs: [EVIDENCE_A], confidence: 'high'
    },
    {
      task: 'machine translation', dataset: null, split: null, languagePair: 'EN-FR',
      metric: 'BLEU', value: 41.0, unit: 'score', model: null, comparator: 'state-of-the-art',
      direction: 'higher_is_better', location: { page: 1, table: null },
      evidenceRefs: [EVIDENCE_B], confidence: 'high'
    }
  ];
  writeJson(dir, 'meta.json', { packageVersion: '2.1.0' });
  writeJson(dir, 'paper-data.json', { abstract: 'A controlled translation fixture.' });
  writeJson(dir, 'evidence-ledger.json', {
    schemaVersion: '2.0.0',
    paperSlug: 'validation-fixture',
    parserVersion: 'test',
    generatedAt: '2026-07-20T00:00:00.000Z',
    document: {
      title: 'Validation fixture',
      authors: [],
      pageCount: 1,
      language: 'en',
      sourceUrl: null,
      sha256: 'a'.repeat(64)
    },
    sections: [],
    pages: [],
    evidence,
    quality: { parser: 'pymupdf', readingOrder: 'high', sectionCoverage: 'partial', tableExtraction: 'text-only', warnings: [] }
  });
  writeJson(dir, 'facts.json', {
    schemaVersion: '2.1.0',
    paperSlug: 'validation-fixture',
    parserVersion: 'test',
    resultClaims: claims,
    keyResults: claims.map((claim) => ({
      label: claim.metric,
      value: String(claim.value),
      context: evidence.find((item) => item.id === claim.evidenceRefs[0]).text,
      evidence: { section: 'results', quote: evidence.find((item) => item.id === claim.evidenceRefs[0]).text },
      evidenceRefs: claim.evidenceRefs
    })),
    coreClaims: [],
    limitations: []
  });
  writeJson(dir, 'analysis.json', { analysisVersion: '1.0.0', resultsTable: [], evidenceRefs: [] });
  writeJson(dir, 'reasoning-analysis.json', {
    schemaVersion: '2.0.0',
    status: 'complete',
    evidenceQuality: 'complete_enough',
    uncertaintyZones: reasoningDisclose ? [{ topic: 'conflict', reason: '41.8 and 41.0 BLEU are inconsistent.', evidenceRefs: [EVIDENCE_A, EVIDENCE_B] }] : []
  });
  fs.writeFileSync(path.join(dir, 'README.md'), visibleDisclose
    ? 'The paper reports 41.8 BLEU and 41.0 BLEU; this conflict is unresolved.\n'
    : 'The paper reports 41.8 BLEU.\n');
  return dir;
}

test('standard and strict reports preserve intrinsic state and stable report hash', () => {
  const standard = createValidationReport({ phase: 'complete', findings: [warning()] });
  const strict = createValidationReport({ phase: 'complete', strict: true, findings: [warning()] });
  assert.equal(standard.status, 'pass_with_warnings');
  assert.equal(standard.publishable, true);
  assert.equal(standard.gate.outcome, 'allow_publish');
  assert.equal(strict.gate.outcome, 'block');
  assert.equal(strict.status, standard.status);
  assert.equal(strict.publishable, standard.publishable);
  assert.deepEqual(strict.findings, standard.findings);
  assert.equal(strict.reportHash.value, standard.reportHash.value);
  assert.equal(validateReport(standard), true);
});

test('draft reports are not publishable and can allow authoring', () => {
  const report = createValidationReport({ phase: 'draft' });
  assert.equal(report.status, 'pass');
  assert.equal(report.publishable, false);
  assert.equal(report.gate.outcome, 'allow_authoring');
});

test('finding overflow fails closed with a truncation finding', () => {
  const findings = Array.from({ length: 510 }, (_, index) => warning(`WARNING_${index}`));
  const report = createValidationReport({ phase: 'complete', findings });
  assert.equal(report.status, 'fail');
  assert.equal(report.findings.length, 500);
  assert.ok(report.findings.some((finding) => finding.code === 'VALIDATION_FINDINGS_TRUNCATED'));
});

test('cross-artifact inspection reports disclosed conflicts as warnings only', () => {
  const dir = makePackage();
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    const codes = inspection.findings.map((finding) => finding.code);
    assert.ok(codes.includes('RESULT_VALUE_CONFLICT'));
    assert.ok(!codes.includes('RESULT_CONFLICT_UNDISCLOSED'));
    assert.equal(inspection.artifacts.ledger.quality.sectionCoverage, 'partial');
    assert.ok(!codes.includes('PARSER_QUALITY_LIMITED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-artifact inspection fails an undisclosed conflict', () => {
  const dir = makePackage({ reasoningDisclose: false, visibleDisclose: false });
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.ok(inspection.findings.some((finding) => finding.code === 'RESULT_CONFLICT_UNDISCLOSED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conflict disclosure is required independently in reasoning and visible materials', () => {
  for (const options of [
    { reasoningDisclose: true, visibleDisclose: false },
    { reasoningDisclose: false, visibleDisclose: true }
  ]) {
    const dir = makePackage(options);
    try {
      const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
      assert.ok(inspection.findings.some((finding) => finding.code === 'RESULT_CONFLICT_UNDISCLOSED'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('conflict disclosure requires both exact numeric values, not a shared integer prefix', () => {
  const dir = makePackage();
  writeJson(dir, 'reasoning-analysis.json', {
    schemaVersion: '2.0.0',
    status: 'complete',
    evidenceQuality: 'complete_enough',
    uncertaintyZones: [{
      topic: 'conflict',
      reason: 'The 41.8 BLEU figure is inconsistent with another reported figure.',
      evidenceRefs: [EVIDENCE_A, EVIDENCE_B]
    }]
  });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    'The 41.8 BLEU figure is inconsistent with another reported figure.\n'
  );
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.ok(inspection.findings.some((finding) => finding.code === 'RESULT_VALUE_CONFLICT'));
    assert.ok(inspection.findings.some((finding) => finding.code === 'RESULT_CONFLICT_UNDISCLOSED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compatible 2.0 packages skip native ResultClaim checks and remain warning-only', () => {
  const dir = makePackage();
  writeJson(dir, 'meta.json', { packageVersion: '2.0.0' });
  writeJson(dir, 'facts.json', {
    schemaVersion: '2.0.0',
    paperSlug: 'validation-fixture',
    parserVersion: 'test',
    coreClaims: [],
    keyResults: [{
      label: 'BLEU',
      value: '41.8',
      context: 'On WMT 2014 EN-FR, the model achieves 41.8 BLEU.',
      evidence: { section: 'results', quote: 'On WMT 2014 EN-FR, the model achieves 41.8 BLEU.' },
      evidenceRefs: [EVIDENCE_A]
    }],
    limitations: []
  });
  writeJson(dir, 'analysis.json', {
    analysisVersion: '1.0.0',
    resultsTable: [{ metric: 'BLEU', value: '41.8', evidenceRefs: ['result:0'] }]
  });
  writeJson(dir, 'reasoning-analysis.json', {
    schemaVersion: '2.0.0',
    status: 'complete',
    evidenceQuality: 'complete_enough',
    uncertaintyZones: [{
      topic: 'legacy result',
      reason: 'The package reports 41.8 BLEU.',
      evidenceRefs: ['result:0']
    }]
  });
  fs.writeFileSync(path.join(dir, 'README.md'), 'A legacy visible projection reports 99.9 BLEU.\n');
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    const report = createValidationReport({
      phase: 'complete',
      findings: inspection.findings,
      referenceCoverage: inspection.referenceCoverage,
      scope: inspection.scope
    });
    const codes = inspection.findings.map((finding) => finding.code);
    assert.equal(inspection.compatibility.mode, 'compatible_2_0');
    assert.equal(inspection.canWriteReport, true);
    assert.deepEqual(codes, ['PACKAGE_COMPATIBILITY_LIMITED']);
    assert.equal(report.status, 'pass_with_warnings');
    assert.equal(report.publishable, true);
    assert.equal(report.gate.outcome, 'allow_publish');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analysis and reasoning metric values must map to ResultClaims and evidence', () => {
  const dir = makePackage();
  writeJson(dir, 'analysis.json', {
    analysisVersion: '1.0.0',
    resultsTable: [{ metric: 'BLEU', value: '99.9', evidenceRefs: [EVIDENCE_A] }]
  });
  const reasoning = JSON.parse(fs.readFileSync(path.join(dir, 'reasoning-analysis.json'), 'utf8'));
  reasoning.uncertaintyZones.push({
    topic: 'unsupported',
    reason: 'A separate 77.7 BLEU result is claimed.',
    evidenceRefs: [EVIDENCE_A]
  });
  writeJson(dir, 'reasoning-analysis.json', reasoning);
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    const codes = inspection.findings.map((finding) => finding.code);
    assert.ok(codes.includes('ANALYSIS_RESULT_UNGROUNDED'));
    assert.ok(codes.includes('REASONING_RESULT_UNGROUNDED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('section numbers and evidence-id suffixes are not metric values', () => {
  const dir = makePackage();
  const reasoning = JSON.parse(fs.readFileSync(path.join(dir, 'reasoning-analysis.json'), 'utf8'));
  reasoning.uncertaintyZones.push({
    topic: 'parsing task',
    reason: 'WSJ Section 23 F1 is the evaluation label; internal locator ev-p007-par-3aa190b8f1 is not a result.',
    evidenceRefs: [EVIDENCE_A]
  });
  writeJson(dir, 'reasoning-analysis.json', reasoning);
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.ok(!inspection.findings.some((finding) =>
      finding.code === 'REASONING_RESULT_UNGROUNDED'
      && /(?:23|8) F1/i.test(finding.message)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic report writer refuses a symlinked report target', () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-write-');
  const dir = fixture.packageDir;
  const outside = path.join(fixture.root, 'outside.json');
  const codexDir = path.join(dir, '.codex-paper');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(codexDir, 'validation-report.json'));
  try {
    assert.throws(() => withLibraryRoot(fixture.root, () => writeValidationReportAtomic(dir, createValidationReport({ phase: 'draft' }))), /symlink|unsafe/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('report writer refuses a symlinked .codex-paper directory', () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-dir-link-');
  const dir = fixture.packageDir;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-validation-outside-'));
  fs.symlinkSync(outside, path.join(dir, '.codex-paper'));
  try {
    assert.throws(
      () => withLibraryRoot(fixture.root, () => writeValidationReportAtomic(dir, createValidationReport({ phase: 'draft' }))),
      /non-symlink directory|unsafe/
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace validation records a bounded failed state when report persistence fails', () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-persist-failure-');
  const codexDir = path.join(fixture.packageDir, '.codex-paper');
  const outside = path.join(fixture.root, 'outside-report.json');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(outside, 'unchanged');
  fs.symlinkSync(outside, path.join(codexDir, 'validation-report.json'));
  try {
    assert.throws(
      () => withLibraryRoot(fixture.root, () => persistWorkspaceValidationReport(fixture.packageDir, createValidationReport({ phase: 'draft' }))),
      /unsafe|symlink/i
    );
    const workspace = JSON.parse(fs.readFileSync(path.join(fixture.workspaceDir, 'workspace.json'), 'utf8'));
    assert.equal(workspace.state, 'failed');
    assert.equal(workspace.lastSuccessfulStep, 'validation_report_write_failed');
    assert.equal(workspace.diagnostics.length, 1);
    assert.match(workspace.diagnostics[0].code, /^STORAGE_/);
    assert.doesNotMatch(workspace.diagnostics[0].message, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('workspace validation compensates when the final state update fails after report persistence', () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-final-state-failure-');
  const workspacePath = fs.realpathSync(path.join(fixture.workspaceDir, 'workspace.json'));
  const originalRename = fs.renameSync;
  let workspaceRenames = 0;
  fs.renameSync = (source, destination) => {
    if (destination === workspacePath && ++workspaceRenames === 2) {
      throw Object.assign(new Error(`simulated state failure at ${fixture.root}`), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  try {
    assert.throws(
      () => withLibraryRoot(fixture.root, () => persistWorkspaceValidationReport(fixture.packageDir, createValidationReport({ phase: 'complete' }))),
      /simulated state failure/
    );
    const workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
    assert.equal(workspace.state, 'failed');
    assert.equal(workspace.lastSuccessfulStep, 'validation_state_update_failed');
    assert.equal(workspace.diagnostics.length, 1);
    assert.equal(workspace.diagnostics[0].code, 'EIO');
    assert.doesNotMatch(workspace.diagnostics[0].message, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(path.join(fixture.packageDir, '.codex-paper', 'validation-report.json')), true);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('workspace validation exposes a secondary compensation failure without replacing the primary error', () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-compensation-failure-');
  const workspacePath = fs.realpathSync(path.join(fixture.workspaceDir, 'workspace.json'));
  const originalRename = fs.renameSync;
  let workspaceRenames = 0;
  fs.renameSync = (source, destination) => {
    if (destination === workspacePath && ++workspaceRenames >= 2) {
      const label = workspaceRenames === 2 ? 'primary state failure' : 'secondary compensation failure';
      throw Object.assign(new Error(label), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  let thrown;
  try {
    assert.throws(
      () => withLibraryRoot(fixture.root, () => persistWorkspaceValidationReport(fixture.packageDir, createValidationReport({ phase: 'complete' }))),
      (error) => {
        thrown = error;
        return /primary state failure/.test(error.message);
      }
    );
    assert.match(thrown.preservationError?.message || '', /secondary compensation failure/);
    const workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
    assert.equal(workspace.state, 'validating');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('unknown package versions stay report-free and read-only', () => {
  const dir = makePackage();
  writeJson(dir, 'meta.json', { packageVersion: '99.0.0' });
  const before = new Map(
    fs.readdirSync(dir).map((name) => [name, fs.statSync(path.join(dir, name)).mtimeMs])
  );
  try {
    const inspection = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.equal(inspection.compatibility.mode, 'unknown_read_only');
    assert.equal(inspection.canWriteReport, false);
    assert.ok(inspection.findings.some((finding) => finding.code === 'PACKAGE_VERSION_UNSUPPORTED'));
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'validation-report.json')), false);
    for (const [name, mtime] of before) assert.equal(fs.statSync(path.join(dir, name)).mtimeMs, mtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identity validation is conditional, fail-closed, and does not affect legacy packages', () => {
  const dir = makePackage();
  try {
    const legacy = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.equal(legacy.findings.some((finding) => finding.category === 'identity'), false);

    const pdf = Buffer.from('%PDF-1.4\nidentity fixture\n');
    fs.writeFileSync(path.join(dir, 'paper.pdf'), pdf);
    const sourceSha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    const contractFiles = [{ path: 'fixture', sha256: 'c'.repeat(64) }];
    const identity = buildPaperIdentity({
      slug: 'validation-fixture', sourceSha256, workflow: 'study', language: 'en',
      contextMode: 'paper-only', requestedPaperProfile: 'auto', parserBackend: 'fixture', parserBackendVersion: '1',
      contentContract: {
        version: '1.0.0',
        sha256: crypto.createHash('sha256').update(canonicalStringify({ version: '1.0.0', files: contractFiles })).digest('hex'),
        files: contractFiles
      },
      pluginBuildVersion: '2.0.0+codex.test', platform: 'test', createdAt: '2026-07-21T00:00:00.000Z'
    });
    fs.mkdirSync(path.join(dir, '.codex-paper'));
    writeJson(path.join(dir, '.codex-paper'), 'paper-identity.json', identity);
    for (const name of ['meta.json', 'paper-data.json']) {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      writeJson(dir, name, { ...value, ...identityProjection(identity) });
    }
    const valid = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.equal(valid.findings.some((finding) => finding.category === 'identity'), false);

    const corrupt = structuredClone(identity);
    corrupt.generation.fingerprint.value = 'd'.repeat(64);
    writeJson(path.join(dir, '.codex-paper'), 'paper-identity.json', corrupt);
    const invalid = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.ok(invalid.findings.some((finding) => finding.code === 'IDENTITY_SCHEMA_INVALID'));

    writeJson(path.join(dir, '.codex-paper'), 'paper-identity.json', identity);
    fs.appendFileSync(path.join(dir, 'paper.pdf'), 'changed');
    const changed = inspectPackageArtifacts(dir, { phase: 'complete' });
    assert.ok(changed.findings.some((finding) => finding.code === 'SOURCE_HASH_MISMATCH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent atomic writers leave one complete schema-valid report', async () => {
  const fixture = writableWorkspaceFixture('codex-paper-validation-concurrent-');
  const dir = fixture.packageDir;
  const engineUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../validation-report.js')).href;
  const childScript = `
    import { createValidationReport, writeValidationReportAtomic } from ${JSON.stringify(engineUrl)};
    const report = createValidationReport({
      phase: 'complete',
      generatedAt: process.argv[2],
      findings: []
    });
    writeValidationReportAtomic(process.argv[1], report);
  `;
  try {
    await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, dir, new Date(1_000 + index).toISOString()], {
        stdio: 'pipe', env: { ...process.env, PAPERS_DIR: fixture.root }
      });
      let error = '';
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)));
    })));
    const report = JSON.parse(fs.readFileSync(path.join(dir, '.codex-paper', 'validation-report.json'), 'utf8'));
    assert.equal(validateReport(report), true);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, '.codex-paper')).sort(),
      ['validation-report.json']
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
