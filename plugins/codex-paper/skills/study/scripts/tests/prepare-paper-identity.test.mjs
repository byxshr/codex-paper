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

test('prepare creates managed identity, reuses without writes, and keeps multiple generations', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-prepare-identity-'));
  try {
    const created = runPrepare(library);
    assert.equal(created.status, 0, created.stderr);
    const output = JSON.parse(created.stdout);
    assert.equal(output.action, 'created');
    assert.match(output.identity.paperId, /^source:sha256:/);
    const paperDir = output.paperDir;
    const identity = JSON.parse(fs.readFileSync(path.join(paperDir, '.codex-paper/paper-identity.json')));
    const indexPath = path.join(library, 'index.json');
    const paperRoot = path.resolve(paperDir, '../../../../..');
    const overlayPath = path.join(paperRoot, 'overlay/state.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath));
    const index = JSON.parse(fs.readFileSync(indexPath));
    overlay.tags = ['preserved'];
    index[0].tags = ['preserved'];
    fs.writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const beforeReuse = snapshot(library);

    const reused = runPrepare(library);
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).action, 'reused');
    assert.deepEqual(snapshot(library), beforeReuse);

    const differentLanguage = runPrepare(library, fixturePdf, ['--language', 'zh']);
    assert.equal(differentLanguage.status, 0, differentLanguage.stderr);
    const second = JSON.parse(differentLanguage.stdout);
    assert.equal(second.action, 'created');
    assert.notEqual(second.paperDir, paperDir);
    assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath)).tags, ['preserved']);
    assert.equal(hashFile(path.join(paperDir, 'facts.json')), beforeReuse[path.relative(library, path.join(paperDir, 'facts.json'))].sha256);

    const alteredPdf = path.join(library, 'same-title-different-source.pdf');
    fs.copyFileSync(fixturePdf, alteredPdf);
    fs.appendFileSync(alteredPdf, '\n% different source revision\n');
    const differentSource = runPrepare(library, alteredPdf);
    assert.equal(differentSource.status, 0, differentSource.stderr);
    const differentOutput = JSON.parse(differentSource.stdout);
    assert.equal(differentOutput.action, 'created');
    assert.notEqual(differentOutput.paperSlug, output.paperSlug);
    assert.notEqual(differentOutput.paperDir, paperDir);

    const staleIndex = JSON.parse(fs.readFileSync(indexPath));
    fs.writeFileSync(indexPath, '[]\n');
    const stale = runPrepare(library);
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(JSON.parse(stale.stdout).action, 'reused');
    fs.writeFileSync(indexPath, `${JSON.stringify(staleIndex, null, 2)}\n`);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare preserves a legacy package and allocates a distinct managed route', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-legacy-collision-'));
  try {
    const paperDir = path.join(library, 'papers', 'synthetic-front-matter-noise');
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(path.join(paperDir, 'meta.json'), '{}\n');
    fs.writeFileSync(path.join(library, 'index.json'), '[]\n');
    const before = snapshot(library);
    const result = runPrepare(library);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.notEqual(output.paperSlug, 'synthetic-front-matter-noise');
    const afterLegacy = snapshot(paperDir);
    const beforeLegacy = Object.fromEntries(Object.entries(before).filter(([key]) => key.startsWith('papers/synthetic-front-matter-noise/')).map(([key, value]) => [key.replace('papers/synthetic-front-matter-noise/', ''), value]));
    assert.deepEqual(afterLegacy, beforeLegacy);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare uses the generation fingerprint when base and source-suffixed routes both collide', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-route-fallback-'));
  try {
    const baseSlug = 'synthetic-front-matter-noise';
    const sourceSuffix = hashFile(fixturePdf).slice(0, 12);
    for (const slug of [baseSlug, `${baseSlug}-${sourceSuffix}`]) {
      const legacyDir = path.join(library, 'papers', slug);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'meta.json'), '{}\n');
    }
    fs.writeFileSync(path.join(library, 'index.json'), '[]\n');

    const result = runPrepare(library);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const identity = JSON.parse(fs.readFileSync(path.join(output.paperDir, '.codex-paper/paper-identity.json')));
    assert.equal(output.paperSlug, `${baseSlug}-${identity.generation.fingerprint.value.slice(0, 12)}`);
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
    fs.rmSync(path.join(output.paperDir, 'facts.json'));
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
    const replace = runPrepare(library, fixturePdf, ['--replace']);
    assert.equal(replace.status, 2);
    assert.match(replace.stderr, /--replace is not supported before P0-C2/);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('prepare flags make resume and revision intent explicit', () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-explicit-modes-'));
  try {
    const before = snapshot(library);
    const missingResume = runPrepare(library, fixturePdf, ['--resume']);
    assert.equal(missingResume.status, 1);
    assert.match(missingResume.stderr, /\[RESUME_GENERATION_NOT_FOUND\]/);
    assert.deepEqual(snapshot(library), before);

    const created = runPrepare(library);
    assert.equal(created.status, 0, created.stderr);
    const exactResume = runPrepare(library, fixturePdf, ['--resume']);
    assert.equal(exactResume.status, 0, exactResume.stderr);
    assert.equal(JSON.parse(exactResume.stdout).action, 'reused');

    const wrongGeneration = runPrepare(library, fixturePdf, ['--language', 'zh', '--resume']);
    assert.equal(wrongGeneration.status, 1);
    assert.match(wrongGeneration.stderr, /\[RESUME_GENERATION_NOT_FOUND\]/);
    const sameRevision = runPrepare(library, fixturePdf, ['--new-revision']);
    assert.equal(sameRevision.status, 1);
    assert.match(sameRevision.stderr, /\[NEW_REVISION_REQUIRED\]/);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});
