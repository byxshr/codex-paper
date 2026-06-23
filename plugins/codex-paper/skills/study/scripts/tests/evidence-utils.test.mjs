import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEvidenceRefs,
  formatEvidenceLocator,
  makeEvidenceId,
  makeSectionId,
  normalizeEvidenceText
} from '../evidence-utils.js';

test('normalizeEvidenceText preserves meaning while stabilizing whitespace and Unicode', () => {
  assert.equal(normalizeEvidenceText('A\u0301  method\n\n\nworks'), 'Á method\n\nworks');
  assert.equal(normalizeEvidenceText(' alpha\t beta \n gamma '), 'alpha beta\ngamma');
});

test('makeEvidenceId is stable and sensitive to page and charStart', () => {
  const input = { page: 8, kind: 'paragraph', text: 'The method improves accuracy.', charStart: 18420 };
  const first = makeEvidenceId(input);
  const second = makeEvidenceId({ ...input });

  assert.equal(first, second);
  assert.match(first, /^ev-p008-par-[a-f0-9]{10}$/);
  assert.notEqual(first, makeEvidenceId({ ...input, charStart: 18421 }));
});

test('makeSectionId uses stable page, role, and ordinal components', () => {
  assert.equal(
    makeSectionId({ pageStart: 4, canonicalRole: 'method', ordinal: 1 }),
    'sec-p004-method-01'
  );
});

test('formatEvidenceLocator uses natural paper location text', () => {
  const section = {
    id: 'sec-p004-method-01',
    title: '3 Method'
  };
  const evidence = {
    location: {
      page: 5,
      sectionId: section.id
    },
    labels: {
      tableNumber: 'Table 2',
      figureNumber: null,
      equationNumber: null
    }
  };

  assert.equal(formatEvidenceLocator(evidence, [section]), '论文 p.5，§3 Method，Table 2');
});

test('collectEvidenceRefs recursively finds unique refs', () => {
  const refs = collectEvidenceRefs({
    evidenceRefs: ['ev-p001-par-aaaaaaaaaa'],
    children: [
      { evidenceRefs: ['ev-p002-tab-bbbbbbbbbb', 'ev-p001-par-aaaaaaaaaa'] },
      { nested: { evidenceRefs: ['ext-src01-01'] } }
    ]
  });

  assert.deepEqual(refs, ['ev-p001-par-aaaaaaaaaa', 'ev-p002-tab-bbbbbbbbbb', 'ext-src01-01']);
});
