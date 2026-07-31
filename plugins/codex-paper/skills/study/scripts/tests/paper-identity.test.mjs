import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildContentContract,
  buildPaperIdentity,
  canonicalStringify,
  identityProjection,
  normalizeArxiv,
  normalizeDoi,
  resolveCanonicalIdentity,
  validatePaperIdentity
} from '../paper-identity.js';

const SOURCE_HASH = 'a'.repeat(64);

function tempContractFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-identity-contract-'));
  fs.mkdirSync(path.join(root, 'skills/study'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills/summary'), { recursive: true });
  fs.writeFileSync(path.join(root, 'common.txt'), 'common\n');
  fs.writeFileSync(path.join(root, 'study.txt'), 'study\n');
  fs.writeFileSync(path.join(root, 'summary.txt'), 'summary\n');
  fs.writeFileSync(path.join(root, 'skills/study/generation-contract-2.0.json'), JSON.stringify({
    version: '2.0.0',
    common: ['common.txt'],
    workflows: { study: ['study.txt'], summary: ['summary.txt'] }
  }));
  return root;
}

function build(overrides = {}) {
  const contractFiles = [{ path: 'contract.txt', sha256: 'c'.repeat(64) }];
  const contentContract = overrides.contentContract || {
    version: '2.0.0',
    sha256: crypto.createHash('sha256').update(canonicalStringify({ version: '2.0.0', files: contractFiles })).digest('hex'),
    files: contractFiles
  };
  return buildPaperIdentity({
    slug: 'sample-paper',
    sourceSha256: SOURCE_HASH,
    pages: [],
    workflow: 'study',
    language: 'en',
    contextMode: 'paper-only',
    requestedPaperProfile: 'auto',
    parserBackend: 'pymupdf',
    parserBackendVersion: '1.26.0',
    contentContract,
    pluginBuildVersion: overrides.pluginBuildVersion || '2.0.0+codex.one',
    platform: overrides.platform || 'darwin-arm64',
    createdAt: overrides.createdAt || '2026-07-21T00:00:00.000Z',
    ...overrides
  });
}

test('normalizes DOI and modern/legacy arXiv identifiers', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC.1.'), '10.1000/abc.1');
  assert.equal(normalizeDoi('DOI: 10.5555/Test(2)'), '10.5555/test(2)');
  assert.equal(normalizeDoi('not-a-doi'), null);
  assert.equal(normalizeArxiv('arXiv:1706.03762v7'), '1706.03762');
  assert.equal(normalizeArxiv('hep-th/9901001v2'), 'hep-th/9901001');
  assert.equal(normalizeArxiv('1706.1'), null);
});

test('trusts exact URL and front-matter identifiers but ignores free prose', () => {
  const resolved = resolveCanonicalIdentity({
    inputUrl: 'https://arxiv.org/pdf/1706.03762v7.pdf',
    sourceSha256: SOURCE_HASH,
    pages: [
      { text: 'Title\narXiv:1706.03762v5 [cs.CL]\nThe DOI 10.9999/not-explicit appears in prose.' },
      { text: 'DOI: 10.1000/TRANSFORMER' },
      { text: 'DOI: 10.2000/ignored-third-page' }
    ]
  });
  assert.equal(resolved.paperId, 'doi:10.1000/transformer');
  assert.equal(resolved.canonical.primary.kind, 'doi');
  assert.deepEqual(resolved.canonical.aliases.map((item) => `${item.kind}:${item.value}`), ['arxiv:1706.03762']);
  assert.equal(resolved.canonical.candidates.some((item) => item.value.includes('ignored-third-page')), false);
});

test('URL canonical candidates reject lookalikes and non-exact locators', () => {
  for (const inputUrl of [
    'https://www.arxiv.org/abs/1706.03762',
    'https://arxiv.org/abs/1706.03762?download=1',
    'https://arxiv.org:443/abs/1706.03762',
    'https://dx.doi.org/10.1000/example',
    'https://doi.org/10.1000/example#fragment',
    'https://doi.org.evil.example/10.1000/example'
  ]) {
    assert.equal(resolveCanonicalIdentity({ inputUrl, sourceSha256: SOURCE_HASH }).paperId, `source:sha256:${SOURCE_HASH}`);
  }
});

test('falls back to source identity when same-kind canonical candidates conflict', () => {
  const resolved = resolveCanonicalIdentity({
    inputUrl: 'https://arxiv.org/abs/1706.03762',
    sourceSha256: SOURCE_HASH,
    pages: [{ text: 'arXiv:2401.12345 [cs.AI]' }]
  });
  assert.equal(resolved.paperId, `source:sha256:${SOURCE_HASH}`);
  assert.equal(resolved.canonical.resolution, 'source_fallback');
  assert.deepEqual(resolved.canonical.diagnostics, [{
    code: 'CANONICAL_ID_CONFLICT',
    kind: 'arxiv',
    values: ['1706.03762', '2401.12345']
  }]);
});

test('canonical serialization is independent of object insertion order', () => {
  assert.equal(canonicalStringify({ b: 2, a: { d: 4, c: 3 } }), canonicalStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

test('content contract is workflow-specific and changes with trusted files', () => {
  const root = tempContractFixture();
  try {
    const study = buildContentContract('study', { pluginRoot: root });
    const summary = buildContentContract('summary', { pluginRoot: root });
    assert.notEqual(study.sha256, summary.sha256);
    const before = study.sha256;
    fs.writeFileSync(path.join(root, 'study.txt'), 'changed\n');
    assert.notEqual(buildContentContract('study', { pluginRoot: root }).sha256, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generation ID changes for content inputs but not provenance-only fields', () => {
  const baseline = build();
  const provenanceOnly = build({
    pluginBuildVersion: '2.0.0+codex.two',
    platform: 'linux-x64',
    createdAt: '2026-07-22T00:00:00.000Z'
  });
  assert.equal(provenanceOnly.generationId, baseline.generationId);
  assert.notEqual(build({ language: 'zh' }).generationId, baseline.generationId);
  assert.notEqual(build({ workflow: 'summary' }).generationId, baseline.generationId);
  assert.notEqual(build({ contextMode: 'canonical', sourceUrl: 'https://example.com/paper.pdf' }).generationId, baseline.generationId);
  assert.notEqual(build({ requestedPaperProfile: 'architecture' }).generationId, baseline.generationId);
  assert.notEqual(build({ parserBackendVersion: '1.27.0' }).generationId, baseline.generationId);
  assert.notEqual(build({ runtimeContract: { ...baseline.generation.inputs.runtimeContract, node: '22.23.2' } }).generationId, baseline.generationId);
  assert.notEqual(build({ authoringProvider: 'openai', authoringModel: 'gpt-provenance-test' }).generationId, baseline.generationId);
  assert.notEqual(build({ sourceSha256: 'd'.repeat(64) }).generationId, baseline.generationId);
});

test('validates identity and produces the stable projection', () => {
  const identity = build();
  assert.equal(validatePaperIdentity(identity).valid, true);
  assert.deepEqual(identityProjection(identity), {
    identitySchemaVersion: '2.0.0',
    paperId: `source:sha256:${SOURCE_HASH}`,
    sourceRevisionId: `sha256:${SOURCE_HASH}`,
    generationId: identity.generationId,
    sourceSha256: SOURCE_HASH
  });
  identity.generation.inputs.language = 'zh';
  assert.equal(validatePaperIdentity(identity).valid, false);
  const contractMismatch = build();
  contractMismatch.generation.inputs.contentContract.sha256 = '0'.repeat(64);
  contractMismatch.generation.fingerprint.value = crypto.createHash('sha256').update(canonicalStringify(contractMismatch.generation.inputs)).digest('hex');
  contractMismatch.generationId = `gen:sha256:${contractMismatch.generation.fingerprint.value}`;
  assert.match(validatePaperIdentity(contractMismatch).errors.join('\n'), /content contract hash/);
});
