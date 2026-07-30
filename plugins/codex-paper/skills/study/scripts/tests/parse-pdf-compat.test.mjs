import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePdf, parsePdfDetailed, parsePdfDetailedWorkerInternal } from '../parse-pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parseScript = path.resolve(__dirname, '../parse-pdf.js');
const managedPython = process.env.CODEX_PAPER_PYTHON_BIN
  || path.join(
    process.env.CODEX_PAPER_RUNTIME_DIR
      || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'codex-paper', 'runtime-v1'),
    'python-3.11.15',
    'bin',
    'python',
  );

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
  const result = spawnSync(managedPython, ['-I', '-B', '-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to create smoke PDF');
  }
  return { tempDir, pdfPath };
}

test('pdf-parse fallback preserves the bounded public contract', async () => {
  const { tempDir, pdfPath } = createSmokePdf();
  const originalWorker = process.env.CODEX_PAPER_PARSER_WORKER;
  process.env.CODEX_PAPER_PARSER_WORKER = '1';
  try {
    const detailed = await parsePdfDetailedWorkerInternal(pdfPath, {
      sourceFilename: path.basename(pdfPath),
      forcePyMuPdfFailureForTest: true,
    });
    assert.equal(detailed.parserMetadata.parser, 'pdf-parse');
    assert.equal(detailed.parserMetadata.hasLayout, false);
    assert.match(detailed.parserMetadata.warnings.join('\n'), /forced PyMuPDF failure/);
    assert.equal(Object.hasOwn(detailed.publicData, 'rawText'), false);
    assert.ok(detailed.publicData.title);
  } finally {
    if (originalWorker === undefined) delete process.env.CODEX_PAPER_PARSER_WORKER;
    else process.env.CODEX_PAPER_PARSER_WORKER = originalWorker;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('moving both parser override and claimed canonical anchor cannot execute an out-of-tree interpreter', () => {
  const { tempDir, pdfPath } = createSmokePdf();
  const fakePython = path.join(tempDir, 'fake-python');
  const executed = path.join(tempDir, 'executed');
  fs.writeFileSync(fakePython, `#!/bin/sh\ntouch ${JSON.stringify(executed)}\nexit 0\n`, { mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, [parseScript, pdfPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_PAPER_PYTHON_BIN: fakePython,
        CODEX_PAPER_MANAGED_PYTHON_BIN: fakePython,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Noncanonical parser runtime overrides are disabled/);
    assert.equal(fs.existsSync(executed), false);

    const forgedWorker = spawnSync(process.execPath, [parseScript, pdfPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_PAPER_PARSER_WORKER: '1',
        CODEX_PAPER_PYTHON_BIN: fakePython,
        CODEX_PAPER_MANAGED_PYTHON_BIN: fakePython,
      },
    });
    assert.notEqual(forgedWorker.status, 0);
    assert.match(forgedWorker.stderr, /Noncanonical parser runtime overrides are disabled/);
    assert.equal(fs.existsSync(executed), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
