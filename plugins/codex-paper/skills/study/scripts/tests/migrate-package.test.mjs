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

    const result = await migratePackage(dir);
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
