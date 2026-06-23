import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePdf, parsePdfDetailed } from '../parse-pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parseScript = path.resolve(__dirname, '../parse-pdf.js');

function createSmokePdf() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-parse-test-'));
  const pdfPath = path.join(tempDir, 'compat.pdf');
  const script = `
import fitz
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 72), '''Compat Parser Paper
A. Author
Abstract
We propose a compatibility test method with 3% improvement.
1 Introduction
Existing parser output must stay stable.
2 Method
The detailed parser adds internal page evidence only.
3 Conclusion
The public JSON remains unchanged.''')
doc.save(r'''${pdfPath}''')
doc.close()
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to create smoke PDF');
  }
  return { tempDir, pdfPath };
}

test('parsePdf public JSON matches parsePdfDetailed.publicData and omits internal fields', async () => {
  const { tempDir, pdfPath } = createSmokePdf();
  try {
    const publicData = await parsePdf(pdfPath);
    const detailed = await parsePdfDetailed(pdfPath);

    assert.deepEqual(publicData, detailed.publicData);
    assert.equal(Object.hasOwn(publicData, 'rawText'), false);
    assert.equal(Object.hasOwn(publicData, 'pages'), false);
    assert.equal(Array.isArray(detailed.pages), true);
    assert.equal(typeof detailed.rawText, 'string');
    assert.ok(Array.isArray(detailed.sectionTree));
    assert.ok(detailed.parserMetadata.parser);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parse-pdf CLI continues to print only the public parser object', async () => {
  const { tempDir, pdfPath } = createSmokePdf();
  try {
    const result = spawnSync(process.execPath, [parseScript, pdfPath], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(Object.hasOwn(parsed, 'rawText'), false);
    assert.equal(Object.hasOwn(parsed, 'pages'), false);
    assert.ok(parsed.title);
    assert.ok(parsed.parserVersion);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
