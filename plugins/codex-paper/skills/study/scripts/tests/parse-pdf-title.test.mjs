import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parsePdf } from '../parse-pdf.js';

const managedPython = process.env.CODEX_PAPER_PYTHON_BIN
  || path.join(
    process.env.CODEX_PAPER_RUNTIME_DIR
      || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'codex-paper', 'runtime-v1'),
    'python-3.11.15',
    'bin',
    'python',
  );

function generatePdf(tempPrefix, filename, scriptBody) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const pdfPath = path.join(tempDir, filename);
  const script = `
import fitz
doc = fitz.open()
${scriptBody}
doc.save(r'''${pdfPath}''')
doc.close()
`;
  const generated = spawnSync(managedPython, ['-I', '-B', '-c', script], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  return { tempDir, pdfPath };
}

test('metadata title split across layout blocks does not contaminate authors', async () => {
  const fixture = generatePdf(
    'codex-paper-parse-title-test-',
    'split-title.pdf',
    `doc.set_metadata({"title": "How to Allocate, How to Learn? Dynamic Rollout Allocation and Advantage Modulation for Policy Optimization"})
page = doc.new_page()
page.insert_text((72, 72), "How to Allocate, How to Learn? Dynamic Rollout Allocation and")
page.insert_text((72, 90), "Advantage Modulation for Policy Optimization")
page.insert_text((72, 108), "Yangyi Fang, Jiaye Lin")
page.insert_text((72, 126), "Abstract")
page.insert_text((72, 144), "A deterministic parser compatibility fixture.")`,
  );
  try {
    const parsed = await parsePdf(fixture.pdfPath);
    assert.ok(parsed.authors.some((author) => author.includes('Yangyi Fang')));
    assert.ok(parsed.authors.every((author) => !author.includes('Dynamic Rollout Allocation')));
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('metadata title split across five front-matter blocks does not contaminate authors', async () => {
  const title = 'One Two Three Four Five';
  const fixture = generatePdf(
    'codex-paper-parse-title-five-test-',
    'split-title-five.pdf',
    `doc.set_metadata({"title": "${title}"})
page = doc.new_page()
for index, word in enumerate("${title}".split()):
    page.insert_text((72, 72 + index * 18), word)
page.insert_text((72, 180), "Ada Stone, Ben River")
page.insert_text((72, 198), "Abstract")
page.insert_text((72, 216), "A deterministic parser compatibility fixture.")`,
  );
  try {
    const parsed = await parsePdf(fixture.pdfPath);
    assert.equal(parsed.title, title);
    assert.ok(parsed.authors.some((author) => author.includes('Ada Stone')));
    assert.ok(parsed.authors.every((author) => !author.includes('One Two')));
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
