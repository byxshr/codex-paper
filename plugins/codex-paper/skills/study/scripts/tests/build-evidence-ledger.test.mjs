import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildEvidenceLedger, buildSectionTree } from '../build-evidence-ledger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../../schemas/evidence-ledger.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function makeDetailedFixture() {
  const page1Text = [
    'Example Paper',
    'Abstract',
    'We propose a small method that improves accuracy by 3%.',
    '1 Introduction',
    'Existing systems have a gap in robust evaluation.'
  ].join('\n');
  const page2Text = [
    '2 Method',
    'The method uses a two-stage mechanism.',
    '3 Experiments',
    'Table 1: Main Results show 81.5 accuracy.',
    '4 Limitations',
    'The paper does not test distribution shift.'
  ].join('\n');
  const page2Start = page1Text.length + 2;

  return {
    publicData: {
      title: 'Example Paper',
      authors: ['A. Author'],
      abstract: 'We propose a small method that improves accuracy by 3%.',
      pageCount: 2,
      year: 2026,
      githubLinks: [],
      codeLinks: [],
      sections: {
        abstract: 'We propose a small method that improves accuracy by 3%.',
        introduction: 'Existing systems have a gap in robust evaluation.',
        conclusion: ''
      },
      warnings: [],
      qualityFlags: ['sections_partial'],
      parserVersion: '2.0.0'
    },
    rawText: `${page1Text}\n\n${page2Text}`,
    pages: [
      {
        page: 1,
        text: page1Text,
        rawTextStart: 0,
        rawTextEnd: page1Text.length,
        blockCount: 5,
        blocks: page1Text.split('\n').map((line, index) => ({
          index,
          text: line,
          bbox: [72, 72 + index * 18, 520, 88 + index * 18],
          fontSizeMedian: index === 0 ? 16 : 10,
          isHeadingCandidate: ['Abstract', '1 Introduction'].includes(line)
        }))
      },
      {
        page: 2,
        text: page2Text,
        rawTextStart: page2Start,
        rawTextEnd: page2Start + page2Text.length,
        blockCount: 6,
        blocks: page2Text.split('\n').map((line, index) => ({
          index,
          text: line,
          bbox: [72, 72 + index * 18, 520, 88 + index * 18],
          fontSizeMedian: /^(\d+|4)\s/.test(line) ? 13 : 10,
          isHeadingCandidate: /^(?:2 Method|3 Experiments|4 Limitations)$/.test(line)
        }))
      }
    ],
    parserMetadata: {
      parser: 'pymupdf',
      parserVersion: '2.0.0',
      hasLayout: true,
      warnings: []
    }
  };
}

test('buildEvidenceLedger creates schema-valid page-aware evidence', () => {
  const detailed = makeDetailedFixture();
  detailed.sectionTree = buildSectionTree({
    pages: detailed.pages,
    rawText: detailed.rawText,
    parserMetadata: detailed.parserMetadata
  });

  const ledger = buildEvidenceLedger({
    parsed: detailed,
    source: {
      sourceUrl: null,
      sha256: 'abc123'
    },
    paperSlug: 'example-paper'
  });

  const validate = schemaValidator();
  assert.equal(validate(ledger), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(ledger.paperSlug, 'example-paper');
  assert.equal(ledger.pages.length, 2);
  assert.equal(ledger.pages[0].rawTextEnd + 2, ledger.pages[1].rawTextStart);
  assert.equal(new Set(ledger.evidence.map((item) => item.id)).size, ledger.evidence.length);
  assert.ok(ledger.sections.some((section) => section.canonicalRole === 'method'));
  assert.ok(ledger.sections.some((section) => section.canonicalRole === 'experiments'));
  assert.ok(ledger.evidence.some((item) => item.kind === 'table' && item.roles.includes('result')));
});

test('buildSectionTree recognizes Chinese and English section titles', () => {
  const pages = [{
    page: 1,
    text: '摘要\n本文提出一个方法。\n1 Introduction\nMotivation text.\n2 方法\n核心机制。',
    rawTextStart: 0,
    rawTextEnd: 62,
    blockCount: 6
  }];

  const sections = buildSectionTree({ pages, rawText: pages[0].text, parserMetadata: {} });
  const roles = sections.map((section) => section.canonicalRole);

  assert.ok(roles.includes('abstract'));
  assert.ok(roles.includes('introduction'));
  assert.ok(roles.includes('method'));
});

test('buildEvidenceLedger schema accepts page numbers beyond 999', () => {
  const pageText = '1000 Appendix\nLong document evidence appears here.';
  const parsed = {
    publicData: {
      title: 'Long Paper',
      authors: [],
      abstract: '',
      pageCount: 1000,
      year: null,
      githubLinks: [],
      codeLinks: [],
      sections: {},
      warnings: [],
      qualityFlags: [],
      parserVersion: '2.0.0'
    },
    pages: [{
      page: 1000,
      text: pageText,
      rawTextStart: 0,
      rawTextEnd: pageText.length,
      blockCount: 1
    }],
    parserMetadata: {
      parser: 'pymupdf',
      parserVersion: '2.0.0',
      hasLayout: true,
      warnings: []
    }
  };

  const ledger = buildEvidenceLedger({ parsed, paperSlug: 'long-paper' });
  const validate = schemaValidator();

  assert.equal(validate(ledger), true, JSON.stringify(validate.errors, null, 2));
  assert.ok(ledger.evidence.every((item) => /^ev-p1000-/.test(item.id)));
});

test('pdf-parse fallback shape still produces a legal degraded ledger', () => {
  const parsed = {
    publicData: {
      title: 'Fallback Paper',
      authors: [],
      abstract: '',
      pageCount: 1,
      year: null,
      githubLinks: [],
      codeLinks: [],
      sections: {},
      warnings: ['PyMuPDF unavailable'],
      qualityFlags: ['sections_partial'],
      parserVersion: '2.0.0'
    },
    rawText: 'Fallback Paper\nAbstract\nShort text only.',
    pages: [{
      page: 1,
      text: 'Fallback Paper\nAbstract\nShort text only.',
      rawTextStart: 0,
      rawTextEnd: 40,
      blockCount: 1
    }],
    parserMetadata: {
      parser: 'pdf-parse',
      parserVersion: '2.0.0',
      hasLayout: false,
      warnings: ['fallback']
    }
  };

  const ledger = buildEvidenceLedger({ parsed, paperSlug: 'fallback-paper' });
  const validate = schemaValidator();

  assert.equal(validate(ledger), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(ledger.quality.parser, 'pdf-parse');
  assert.equal(ledger.quality.readingOrder, 'low');
  assert.ok(ledger.evidence.length > 0);
});
