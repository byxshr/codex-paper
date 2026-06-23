import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migratePackage } from '../migrate-package.js';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('migratePackage creates v2 evidence ledger and draft reasoning without inventing analysis', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), {
      slug: 'legacy-paper',
      title: 'Legacy Paper',
      authors: ['A. Author']
    });
    writeJson(path.join(dir, 'paper-data.json'), {
      paperSlug: 'legacy-paper',
      title: 'Legacy Paper',
      abstract: 'Abstract. We introduce a method for a benchmark.',
      sections: {
        abstract: 'Abstract. We introduce a method for a benchmark.',
        introduction: 'Introduction. The benchmark has a gap.',
        conclusion: 'Conclusion. The method is limited to the retained text.'
      },
      rawText: [
        'Abstract. We introduce a method for a benchmark.',
        'Introduction. The benchmark has a gap.',
        'Conclusion. The method is limited to the retained text.'
      ].join('\n\n')
    });

    const result = await migratePackage(dir, { externalPath: true });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-ledger.json'), 'utf8'));
    const reasoning = JSON.parse(fs.readFileSync(path.join(dir, 'reasoning-analysis.json'), 'utf8'));

    assert.equal(result.paperSlug, 'legacy-paper');
    assert.equal(meta.packageVersion, '2.0.0');
    assert.equal(meta.migrationStatus, 'reasoning-draft');
    assert.equal(ledger.schemaVersion, '2.0.0');
    assert.ok(ledger.evidence.length > 0);
    assert.equal(reasoning.status, 'draft');
    assert.deepEqual(reasoning.centralClaims, []);
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'reasoning-review.md')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratePackage preserves context/profile and completed migration status on rerun', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-rerun-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), {
      slug: 'canonical-paper',
      title: 'Canonical Paper',
      contextMode: 'canonical',
      requestedPaperProfile: 'survey',
      migrationStatus: 'complete'
    });
    writeJson(path.join(dir, 'paper-data.json'), {
      paperSlug: 'canonical-paper',
      title: 'Canonical Paper',
      abstract: 'Survey. We organize prior work into a taxonomy.',
      rawText: 'Survey. We organize prior work into a taxonomy.',
      sections: {}
    });
    writeJson(path.join(dir, 'evidence-ledger.json'), {
      schemaVersion: '2.0.0',
      paperSlug: 'canonical-paper',
      evidence: []
    });
    writeJson(path.join(dir, 'reasoning-analysis.json'), {
      schemaVersion: '2.0.0',
      status: 'complete',
      paperSlug: 'canonical-paper'
    });

    await migratePackage(dir, { externalPath: true });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

    assert.equal(meta.contextMode, 'canonical');
    assert.equal(meta.requestedPaperProfile, 'survey');
    assert.equal(meta.migrationStatus, 'complete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratePackage handles legacy packages without paper-data.json and writes meta last', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-no-paper-data-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), {
      slug: 'missing-paper-data',
      title: 'Missing Paper Data',
      contextMode: 'literature'
    });

    const result = await migratePackage(dir, { externalPath: true });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const paperData = JSON.parse(fs.readFileSync(path.join(dir, 'paper-data.json'), 'utf8'));
    const reasoning = JSON.parse(fs.readFileSync(path.join(dir, 'reasoning-analysis.json'), 'utf8'));

    assert.equal(result.contextMode, 'literature');
    assert.equal(meta.packageVersion, '2.0.0');
    assert.equal(meta.contextMode, 'literature');
    assert.equal(meta.migrationStatus, 'reasoning-draft');
    assert.equal(paperData.paperSlug, 'missing-paper-data');
    assert.equal(reasoning.status, 'draft');
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'external-evidence.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratePackage refuses out-of-library paths unless explicitly allowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-external-path-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), {
      slug: 'external-path',
      title: 'External Path'
    });

    await assert.rejects(
      () => migratePackage(dir),
      /--external-path/
    );
    const result = await migratePackage(dir, { externalPath: true });
    assert.equal(result.paperSlug, 'external-path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
