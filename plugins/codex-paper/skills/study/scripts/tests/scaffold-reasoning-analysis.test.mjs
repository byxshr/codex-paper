import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaffoldReasoningAnalysis } from '../scaffold-reasoning-analysis.js';
import { writeTestProvenanceDraft } from './helpers/provenance-fixture.js';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePaperDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-scaffold-test-'));
  const workspaceId = 'ws-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccccccccccccccccccc';
  const workspaceDir = path.join(root, '.codex-paper', 'workspaces-v1', workspaceId);
  const dir = path.join(workspaceDir, 'package');
  fs.mkdirSync(dir, { recursive: true });
  const paperKey = `p-${'3'.repeat(64)}`;
  const paperId = `source:sha256:${'1'.repeat(64)}`;
  const sourceRevisionId = `sha256:${'1'.repeat(64)}`;
  const generationId = `gen:sha256:${'2'.repeat(64)}`;
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    schemaVersion: '1.0.0', workspaceId, state: 'authoring', paperKey,
    paperId, sourceRevisionId,
    generationId,
    targetPackageRelativePath: `sources/sha256-${'1'.repeat(64)}/generations/gen-sha256-${'2'.repeat(64)}/package`,
    routeSlug: 'scaffold-paper', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    lastSuccessfulStep: 'initialized', diagnostics: [], publishIntent: { paperRecord: {}, reconciliation: null, tags: [] }
  });
  writeTestProvenanceDraft({
    workspaceDir, workspaceId, paperKey, paperId, sourceRevisionId, generationId
  });
  writeJson(path.join(dir, 'meta.json'), {
    slug: 'scaffold-paper',
    title: 'Scaffold Paper',
    packageVersion: '2.1.0'
  });
  writeJson(path.join(dir, 'paper-data.json'), {
    paperSlug: 'scaffold-paper',
    title: 'Scaffold Paper',
    abstract: 'We prove a theorem about convergence.',
    rawText: 'Theorem. Proof. Convergence bound.'
  });
  writeJson(path.join(dir, 'evidence-ledger.json'), {
    schemaVersion: '2.0.0',
    paperSlug: 'scaffold-paper',
    quality: {
      readingOrder: 'high',
      sectionCoverage: 'high',
      tableExtraction: 'text-only'
    },
    evidence: []
  });
  writeJson(path.join(dir, 'facts.json'), {
    schemaVersion: '2.1.0',
    paperSlug: 'scaffold-paper',
    resultClaims: [],
    keyResults: [],
    coreClaims: [],
    limitations: []
  });
  writeJson(path.join(dir, 'analysis.json'), {
    analysisVersion: '1.0.0',
    evidenceRefs: []
  });
  return { root, dir };
}

test('scaffoldReasoningAnalysis writes draft skeleton and review template without high-level analysis', () => {
  const { root, dir } = makePaperDir();
  const previous = process.env.PAPERS_DIR;
  process.env.PAPERS_DIR = root;
  try {
    const result = scaffoldReasoningAnalysis(dir);
    const reasoning = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));

    assert.equal(reasoning.status, 'draft');
    assert.equal(reasoning.paperSlug, 'scaffold-paper');
    assert.equal(reasoning.paperType, 'theoretical');
    assert.deepEqual(reasoning.centralClaims, []);
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'reasoning-review.md')), true);
    assert.throws(() => scaffoldReasoningAnalysis(dir), /already exists/);
  } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR;
    else process.env.PAPERS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
