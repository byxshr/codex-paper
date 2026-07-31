import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildFactsFromLedger, extractResultClaims, isFrontMatterNoise, validateFactsEvidenceRefs } from '../extract-facts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function evidence(id, text, { kind = 'paragraph', role = 'abstract', roles = [], charStart = 0, table = null, confidence = 'high' } = {}) {
  return {
    id,
    kind,
    roles,
    text,
    quote: text,
    location: { page: 1, sectionId: `sec-p001-${role}-01`, charStart, charEnd: charStart + text.length, blockIndex: 0, bbox: null },
    labels: { figureNumber: null, tableNumber: table === null ? null : `Table ${table}`, equationNumber: null },
    source: 'paper',
    confidence
  };
}

function ledger() {
  return {
    schemaVersion: '2.0.0',
    sections: [
      { id: 'sec-p001-abstract-01', canonicalRole: 'abstract' },
      { id: 'sec-p001-results-01', canonicalRole: 'results' },
      { id: 'sec-p001-conclusion-01', canonicalRole: 'conclusion' }
    ],
    evidence: [
      evidence('ev-p001-abs-aaaaaaaaaa', 'We present a translation model that reaches 28.4 BLEU on EN-DE.', { roles: ['claim_candidate', 'result'], charStart: 10 }),
      evidence('ev-p001-abs-bbbbbbbbbb', '*Equal contribution.', { charStart: 80 }),
      evidence('ev-p001-abs-cccccccccc', 'Copyright 2026 Codex Paper contributors.', { charStart: 110 }),
      evidence('ev-p001-abs-dddddddddd', 'On WMT 2014 EN-FR, the model achieves 41.8 BLEU.', { roles: ['result'], charStart: 160 }),
      evidence('ev-p001-tab-eeeeeeeeee', 'Table 2: EN-FR BLEU 41.8.', { kind: 'table', role: 'results', roles: ['result'], charStart: 230, table: 2 }),
      evidence('ev-p001-par-ffffffffff', 'Training used 8 GPUs for 3.5 days and version 2.0.', { role: 'results', charStart: 280 }),
      evidence('ev-p001-par-2222222222', 'Experiments on two translation tasks achieve 28.4 BLEU.', { role: 'results', charStart: 310 }),
      evidence('ev-p001-par-3333333333', 'Parser Training WSJ 23 F1.', { role: 'results', charStart: 325 }),
      evidence('ev-p001-par-1111111111', 'The prose reports 41.0 BLEU for EN-FR, conflicting with Table 2.', { role: 'conclusion', roles: ['result'], charStart: 340 })
    ]
  };
}

test('typed ResultClaims bind metrics, reject noise, merge corroborating evidence, and preserve conflicts', () => {
  const source = ledger();
  const claims = extractResultClaims(source);
  assert.deepEqual(claims.map((claim) => claim.value), [28.4, 41.8, 28.4, 41]);
  assert.equal(claims.some((claim) => [2014, 2026, 8, 3.5, 2, 23].includes(claim.value)), false);
  assert.equal(claims[1].dataset, 'WMT 2014');
  assert.equal(claims[1].languagePair, 'EN-FR');
  assert.equal(claims[1].location.table, 2);
  assert.deepEqual(claims[1].evidenceRefs, ['ev-p001-abs-dddddddddd', 'ev-p001-tab-eeeeeeeeee']);
  assert.equal(claims[3].location.table, null);
});

test('facts 2.1 uses direct evidence refs and a schema-valid keyResults projection', () => {
  const source = ledger();
  const facts = buildFactsFromLedger('fixture', 'parser-1', source);
  assert.equal(facts.schemaVersion, '2.1.0');
  assert.equal(JSON.stringify(facts.coreClaims).includes('Equal contribution'), false);
  assert.equal(JSON.stringify(facts.coreClaims).includes('Copyright 2026'), false);
  assert.deepEqual(facts.keyResults.map((item) => item.value), ['28.4', '41.8', '28.4', '41.0']);
  for (const ref of [...facts.coreClaims, ...facts.resultClaims, ...facts.keyResults].flatMap((item) => item.evidenceRefs)) {
    assert.match(ref, /^ev-p\d{3,}-[a-z]+-[a-f0-9]{10}$/);
  }

  const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../../schemas/facts-2.1.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(facts), true, JSON.stringify(validate.errors));
});

test('front-matter classifier rejects author, copyright, conference, and arXiv noise', () => {
  for (const text of ['*Equal contribution.', 'Copyright 2026.', 'Presented at Example Conference 2017.', 'arXiv: 1706.03762']) {
    assert.equal(isFrontMatterNoise({ text, kind: 'paragraph', location: {} }), true, text);
  }
});

test('metric-name suffix digits are not extracted as values', () => {
  const source = ledger();
  source.evidence = [
    evidence('ev-p001-par-4444444444', 'We evaluate using ROUGE-1 and ROUGE-2 metrics.'),
    evidence('ev-p001-par-5555555555', 'The model reports a ROUGE-2 score of 37.5.', { charStart: 80 })
  ];
  const claims = extractResultClaims(source);
  assert.deepEqual(claims.map(({ metric, value }) => ({ metric, value })), [{ metric: 'ROUGE-2', value: 37.5 }]);
});

test('evidence confidence is preserved without promoting medium to high', () => {
  const source = ledger();
  source.evidence = [
    evidence('ev-p001-par-6666666666', 'The model achieves 95.2% accuracy.', { confidence: 'medium' }),
    evidence('ev-p001-par-aaaaaaaaab', 'The model achieves 96.0% accuracy.', { confidence: 'low', charStart: 80 })
  ];
  const claims = extractResultClaims(source);
  assert.equal(claims.length, 1);
  const [claim] = claims;
  assert.equal(claim.confidence, 'medium');
  assert.equal(claim.unit, 'percent');
});

test('context-poor equal values remain distinct while shared language-pair evidence can merge', () => {
  const source = ledger();
  source.evidence = [
    evidence('ev-p001-par-7777777777', 'On WMT 2014, the translation model achieves 28.4 BLEU.'),
    evidence('ev-p001-par-8888888888', 'The translation model also achieves 28.4 BLEU.', { role: 'results', charStart: 80 })
  ];
  const claims = extractResultClaims(source);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].dataset, 'WMT 2014');
  assert.equal(claims[1].dataset, null);
});

test('candidate merge is independent of ledger order and preserves a bridging context', () => {
  const candidates = [
    evidence('ev-p001-par-bbbbbbbbba', 'On WMT 2014, the translation model achieves 28.4 BLEU.', { charStart: 10 }),
    evidence('ev-p001-par-bbbbbbbbbb', 'On EN-DE, the translation model achieves 28.4 BLEU.', { charStart: 20 }),
    evidence('ev-p001-par-bbbbbbbbbc', 'On WMT 2014 EN-DE, the translation model achieves 28.4 BLEU.', { charStart: 30 })
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
  ];
  const outputs = permutations.map((order) => {
    const source = ledger();
    source.evidence = order.map((index) => candidates[index]);
    return extractResultClaims(source);
  });
  assert.equal(new Set(outputs.map((claims) => JSON.stringify(claims))).size, 1);
  assert.equal(outputs[0].length, 1);
  assert.equal(outputs[0][0].dataset, 'WMT 2014');
  assert.equal(outputs[0][0].languagePair, 'EN-DE');
  assert.equal(outputs[0][0].evidenceRefs.length, 3);
});

test('non-positive table labels become null and evidence ids are pattern-checked and unique', () => {
  const source = ledger();
  source.evidence = [evidence('ev-p001-tab-9999999999', 'Table 0: EN-FR BLEU 41.8.', { kind: 'table', role: 'results', table: 0 })];
  const [claim] = extractResultClaims(source);
  assert.equal(claim.location.table, null);

  const invalidFacts = {
    coreClaims: [{ evidenceRefs: ['ev-1', 'ev-1'] }],
    resultClaims: [],
    keyResults: [],
    limitations: []
  };
  const validation = validateFactsEvidenceRefs(invalidFacts, { evidence: [{ id: 'ev-1' }] });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /invalid evidence id ev-1/);
  assert.match(validation.errors.join('\n'), /repeats evidence ev-1/);

  const wrongShape = validateFactsEvidenceRefs({
    coreClaims: [{ evidenceRefs: 'ev-p001-par-9999999999' }],
    resultClaims: [], keyResults: [], limitations: []
  }, source);
  assert.deepEqual(wrongShape.errors, ['coreClaims[0] requires evidenceRefs']);
});
