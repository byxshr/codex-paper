import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { slugify } from '../prepare-paper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../../..');
const prepareScript = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js');
const fixturePdf = path.join(repoRoot, 'benchmarks/fixtures/pdf/front-matter-noise.pdf');

function runPrepare(library, input = fixturePdf, extra = []) {
  return spawnSync(process.execPath, [prepareScript, input, '--workflow', 'study', '--language', 'en', '--context', 'paper-only', '--profile', 'auto', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PAPERS_DIR: library },
    timeout: 30000
  });
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshot(root) {
  const result = {};
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const itemPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(itemPath, itemRelative);
      else if (entry.isFile()) result[itemRelative] = { sha256: hashFile(itemPath), mtimeMs: fs.statSync(itemPath).mtimeMs };
    }
  }
  walk(root);
  return result;
}

test('prepare creates identity, reuses without writes, and rejects flat-layout collisions', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-prepare-identity-'));
  try {
    const created = runPrepare(library);
    assert.equal(created.status, 0, created.stderr);
    const output = JSON.parse(created.stdout);
    assert.equal(output.action, 'created');
    assert.match(output.identity.paperId, /^source:sha256:/);
    const paperDir = path.join(library, 'papers', output.paperSlug);
    const identity = JSON.parse(fs.readFileSync(path.join(paperDir, '.codex-paper/paper-identity.json')));
    const metaPath = path.join(paperDir, 'meta.json');
    const indexPath = path.join(library, 'index.json');
    const meta = JSON.parse(fs.readFileSync(metaPath));
    const index = JSON.parse(fs.readFileSync(indexPath));
    meta.tags = ['preserved'];
    index[0].tags = ['preserved'];
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const beforeReuse = snapshot(library);

    const reused = runPrepare(library);
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).action, 'reused');
    assert.deepEqual(snapshot(library), beforeReuse);

    const differentLanguage = runPrepare(library, fixturePdf, ['--language', 'zh']);
    assert.equal(differentLanguage.status, 1);
    assert.match(differentLanguage.stderr, /\[GENERATION_CONFLICT\]/);
    assert.deepEqual(snapshot(library), beforeReuse);

    const alteredPdf = path.join(library, 'same-title-different-source.pdf');
    fs.copyFileSync(fixturePdf, alteredPdf);
    fs.appendFileSync(alteredPdf, '\n% different source revision\n');
    const differentSource = runPrepare(library, alteredPdf);
    assert.equal(differentSource.status, 1);
    assert.match(differentSource.stderr, /\[SOURCE_REVISION_CONFLICT\]/);
    const afterDifferentSource = snapshot(library);
    delete afterDifferentSource['same-title-different-source.pdf'];
    assert.deepEqual(afterDifferentSource, beforeReuse);

    const staleIndex = JSON.parse(fs.readFileSync(indexPath));
    fs.writeFileSync(indexPath, '[]\n');
    const beforeStale = snapshot(library);
    const stale = runPrepare(library);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /\[INDEX_PROJECTION_CONFLICT\]/);
    assert.deepEqual(snapshot(library), beforeStale);
    fs.writeFileSync(indexPath, `${JSON.stringify(staleIndex, null, 2)}\n`);

    const duplicateDir = path.join(library, 'papers', 'duplicate-generation');
    fs.mkdirSync(path.join(duplicateDir, '.codex-paper'), { recursive: true });
    fs.writeFileSync(path.join(duplicateDir, '.codex-paper/paper-identity.json'), `${JSON.stringify({ ...identity, slug: 'duplicate-generation' }, null, 2)}\n`);
    const duplicate = runPrepare(library);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /\[IDENTITY_REGISTRY_CONFLICT\]/);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare refuses a legacy package using the target slug', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-legacy-collision-'));
  try {
    const paperDir = path.join(library, 'papers', 'synthetic-front-matter-noise');
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(path.join(paperDir, 'meta.json'), '{}\n');
    fs.writeFileSync(path.join(library, 'index.json'), '[]\n');
    const before = snapshot(library);
    const result = runPrepare(library);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[LEGACY_IDENTITY_COLLISION\]/);
    assert.deepEqual(snapshot(library), before);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare rejects an unsafe index before creating a target', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-unsafe-index-'));
  const externalIndex = path.join(os.tmpdir(), `codex-paper-external-index-${crypto.randomUUID()}.json`);
  try {
    fs.mkdirSync(path.join(library, 'papers'), { recursive: true });
    fs.writeFileSync(externalIndex, '[]\n');
    fs.symlinkSync(externalIndex, path.join(library, 'index.json'));
    const result = runPrepare(library);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[INDEX_PATH_UNSAFE\]/);
    assert.deepEqual(fs.readdirSync(path.join(library, 'papers')), []);
    assert.equal(fs.readFileSync(externalIndex, 'utf8'), '[]\n');
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
    fs.rmSync(externalIndex, { force: true });
  }
});

test('prepare rejects a dangling index symlink before creating a target', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-dangling-index-'));
  try {
    fs.mkdirSync(path.join(library, 'papers'), { recursive: true });
    fs.symlinkSync(path.join(library, 'missing-index-target.json'), path.join(library, 'index.json'));
    const result = runPrepare(library);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[INDEX_PATH_UNSAFE\]/);
    assert.deepEqual(fs.readdirSync(path.join(library, 'papers')), []);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare refuses read-only reuse when a managed artifact is missing', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-partial-identity-'));
  try {
    const created = runPrepare(library);
    assert.equal(created.status, 0, created.stderr);
    const output = JSON.parse(created.stdout);
    fs.rmSync(path.join(library, 'papers', output.paperSlug, 'facts.json'));
    const before = snapshot(library);
    const result = runPrepare(library);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[IDENTITY_STATE_INCOMPLETE\]/);
    assert.deepEqual(snapshot(library), before);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('slug generation is deterministic and bounded to the identity schema limit', () => {
  const slug = slugify(`A very long paper title ${'with repeated content '.repeat(20)}`);
  assert.ok(slug.length <= 160);
  assert.match(slug, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  assert.equal(slug, slugify(`A very long paper title ${'with repeated content '.repeat(20)}`));
});

test('prepare rejects removed force/overwrite options with argument exit 2', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-force-rejected-'));
  try {
    const result = runPrepare(library, fixturePdf, ['--force']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /\[ARGUMENT_INVALID\]/);
    assert.equal(fs.existsSync(path.join(library, 'papers')), false);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});
