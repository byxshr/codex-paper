import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaffoldReasoningAnalysis } from '../scaffold-reasoning-analysis.js';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePaperDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-scaffold-test-'));
  writeJson(path.join(dir, 'meta.json'), {
    slug: 'scaffold-paper',
    title: 'Scaffold Paper'
  });
  writeJson(path.join(dir, 'paper-data.json'), {
    paperSlug: 'scaffold-paper',
    title: 'Scaffold Paper',
    abstract: 'We prove a theorem about convergence.',
    rawText: 'Theorem. Proof. Convergence bound.'
  });
  writeJson(path.join(dir, 'evidence-ledger.json'), {
    paperSlug: 'scaffold-paper',
    quality: {
      readingOrder: 'high',
      sectionCoverage: 'high',
      tableExtraction: 'text-only'
    },
    evidence: []
  });
  return dir;
}

test('scaffoldReasoningAnalysis writes draft skeleton and review template without high-level analysis', () => {
  const dir = makePaperDir();
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
