import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migratePackage } from '../migrate-package.js';

const MIGRATE_SCRIPT = path.resolve('plugins/codex-paper/skills/study/scripts/migrate-package.js');

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

test('migratePackage preserves an existing reasoning review unless force is explicit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-review-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), { slug: 'reviewed-paper', title: 'Reviewed Paper' });
    writeJson(path.join(dir, 'paper-data.json'), {
      paperSlug: 'reviewed-paper', title: 'Reviewed Paper', abstract: 'A retained abstract.',
      sections: { abstract: 'A retained abstract.' }, rawText: 'A retained abstract.'
    });
    fs.mkdirSync(path.join(dir, '.codex-paper'));
    const reviewPath = path.join(dir, '.codex-paper', 'reasoning-review.md');
    fs.writeFileSync(reviewPath, '# Human review\nKeep this content.\n');

    const result = await migratePackage(dir, { externalPath: true });
    assert.equal(fs.readFileSync(reviewPath, 'utf8'), '# Human review\nKeep this content.\n');
    assert.equal(result.wrote.includes('.codex-paper/reasoning-review.md'), false);
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

test('migratePackage rejects unsupported source versions before writing any artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-unsupported-test-'));
  try {
    const metaPath = path.join(dir, 'meta.json');
    writeJson(metaPath, { slug: 'future-paper', title: 'Future Paper', packageVersion: '9.0.0' });
    const before = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    await assert.rejects(
      () => migratePackage(dir, { externalPath: true }),
      /MIGRATION_SOURCE_VERSION_UNSUPPORTED/
    );
    assert.deepEqual(new Set(fs.readdirSync(dir)), new Set(before.keys()));
    for (const [name, content] of before) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratePackage completes an explicitly versioned 1.x package without partial writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-declared-v1-test-'));
  try {
    writeJson(path.join(dir, 'meta.json'), {
      slug: 'declared-v1-paper',
      title: 'Declared V1 Paper',
      packageVersion: '1.0.0'
    });
    writeJson(path.join(dir, 'paper-data.json'), {
      paperSlug: 'declared-v1-paper',
      title: 'Declared V1 Paper',
      abstract: 'A legacy package with an explicit version.',
      rawText: 'A legacy package with an explicit version.',
      sections: {}
    });

    const result = await migratePackage(dir, { externalPath: true });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(result.wrote.includes('reasoning-analysis.json'), true);
    assert.equal(meta.packageVersion, '2.0.0');
    assert.equal(fs.existsSync(path.join(dir, 'evidence-ledger.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'reasoning-analysis.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'reasoning-review.md')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratePackage rejects unsupported ancillary versions before writes with or without force', async () => {
  for (const force of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-paper-migrate-unsupported-ledger-${force}-`));
    try {
      writeJson(path.join(dir, 'meta.json'), {
        slug: 'unsupported-ledger',
        title: 'Unsupported Ledger',
        contextMode: 'literature'
      });
      writeJson(path.join(dir, 'evidence-ledger.json'), { schemaVersion: '3.0.0', evidence: [] });
      const before = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));

      await assert.rejects(
        () => migratePackage(dir, { externalPath: true, force }),
        /MIGRATION_SOURCE_VERSION_UNSUPPORTED.*3\.0\.0/
      );
      assert.deepEqual(new Set(fs.readdirSync(dir)), new Set(before.keys()));
      for (const [name, content] of before) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('migratePackage reports corrupt metadata before writing any artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-corrupt-meta-'));
  try {
    fs.writeFileSync(path.join(dir, 'meta.json'), '{not-json');
    const before = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
    await assert.rejects(
      () => migratePackage(dir, { externalPath: true }),
      /PACKAGE_ARTIFACT_INVALID.*meta\.json/
    );
    assert.deepEqual(fs.readdirSync(dir), ['meta.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration rejects nested in-library paths so every legacy package shares one slug lock', () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-nested-'));
  try {
    const packageDir = path.join(libraryRoot, 'papers', 'legacy-paper');
    const nestedDir = path.join(packageDir, 'notes');
    fs.mkdirSync(nestedDir, { recursive: true });
    writeJson(path.join(packageDir, 'meta.json'), { slug: 'legacy-paper', title: 'Legacy Paper' });
    const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, nestedDir, '--external-path'], {
      encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LEGACY_PACKAGE_ROOT_REQUIRED/);
    assert.equal(fs.existsSync(path.join(nestedDir, 'evidence-ledger.json')), false);
  } finally {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test('migration refuses active generation workspaces even with --external-path', () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-workspace-'));
  try {
    const workspaceId = 'ws-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccccccccccccccccccc';
    const workspaceDir = path.join(libraryRoot, '.codex-paper', 'workspaces-v1', workspaceId);
    const packageDir = path.join(workspaceDir, 'package');
    fs.mkdirSync(packageDir, { recursive: true });
    const sourceRevisionId = `sha256:${'1'.repeat(64)}`;
    const generationId = `gen:sha256:${'2'.repeat(64)}`;
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      schemaVersion: '1.0.0', workspaceId, state: 'authoring', paperKey: `p-${'3'.repeat(64)}`,
      paperId: `source:${sourceRevisionId}`, sourceRevisionId, generationId,
      targetPackageRelativePath: `sources/sha256-${'1'.repeat(64)}/generations/gen-sha256-${'2'.repeat(64)}/package`,
      routeSlug: 'managed-workspace', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      lastSuccessfulStep: 'prepared', diagnostics: [], publishIntent: { paperRecord: {}, reconciliation: null, tags: [] }
    });
    writeJson(path.join(packageDir, 'meta.json'), { slug: 'managed-workspace', title: 'Managed Workspace' });
    const beforeWorkspace = fs.readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8');
    const beforeMeta = fs.readFileSync(path.join(packageDir, 'meta.json'), 'utf8');
    const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, packageDir, '--external-path'], {
      encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MANAGED_LAYOUT_MIGRATION_REFUSED/);
    assert.equal(fs.readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'), beforeWorkspace);
    assert.equal(fs.readFileSync(path.join(packageDir, 'meta.json'), 'utf8'), beforeMeta);
    assert.deepEqual(fs.readdirSync(packageDir), ['meta.json']);
  } finally {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test('migration rejects a symlinked in-library package before lock selection', () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-symlink-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-migrate-symlink-target-'));
  try {
    fs.mkdirSync(path.join(libraryRoot, 'papers'), { recursive: true });
    writeJson(path.join(external, 'meta.json'), { slug: 'linked-paper', title: 'Linked Paper' });
    fs.symlinkSync(external, path.join(libraryRoot, 'papers', 'linked-paper'));
    const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, path.join(libraryRoot, 'papers', 'linked-paper'), '--external-path'], {
      encoding: 'utf8', env: { ...process.env, PAPERS_DIR: libraryRoot }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LIBRARY_PATH_UNSAFE/);
    assert.deepEqual(fs.readdirSync(external), ['meta.json']);
  } finally {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
