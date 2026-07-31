import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  PDF_SECURITY_POLICY,
  copyPdfSnapshot,
  preflightPdfFile,
  quarantinePdf,
  sweepPdfQuarantine,
  validateParsedPdf,
} from '../../plugins/codex-paper/skills/study/scripts/pdf-security.js'
import { parsePdfDetailed, parsePdfDetailedWorkerInternal } from '../../plugins/codex-paper/skills/study/scripts/parse-pdf.js'

const require = createRequire(import.meta.url)
const {
  downloadFile,
  isPublicAddress,
  resolveSafeTarget,
  stagePdfInput,
  validateHttpsUrl,
} = require('../../plugins/codex-paper/skills/study/scripts/download-pdf.cjs')
const managedPython = process.env.CODEX_PAPER_PYTHON_BIN
  || path.join(
    process.env.CODEX_PAPER_RUNTIME_DIR
      || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'codex-paper', 'runtime-v1'),
    'python-3.11.15',
    'bin',
    'python',
  )

function fakeRequest(responses, seen = []) {
  return (options, callback) => {
    seen.push(options)
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.destroy = (error) => { if (error) request.emit('error', error) }
    request.end = () => {
      const spec = responses.shift()
      setImmediate(() => {
        const response = new PassThrough()
        response.statusCode = spec.statusCode ?? 200
        response.headers = spec.headers || {}
        Object.defineProperty(response, 'socket', { value: { remoteAddress: spec.peer || '93.184.216.34' } })
        callback(response)
        setImmediate(() => response.end(spec.body || Buffer.alloc(0)))
      })
    }
    return request
  }
}

test('SSRF address policy rejects local, metadata, reserved, ULA, and mapped IPv4', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.2', '198.18.0.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fec0::1', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isPublicAddress(address), false, address)
  }
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})

test('SSRF address policy rejects deprecated IPv4-compatible IPv6 addresses', () => {
  for (const address of ['::a9fe:a9fe', '::169.254.169.254', '::808:808', '::8.8.8.8']) {
    assert.equal(isPublicAddress(address), false, address)
  }
})

test('URL and DNS policy is HTTPS-only and rejects mixed public/private answers', async () => {
  assert.throws(() => validateHttpsUrl('http://example.com/paper'), /require HTTPS/)
  assert.throws(() => validateHttpsUrl('https://user:secret@example.com/paper'), /credentials/)
  await assert.rejects(
    resolveSafeTarget(new URL('https://example.com/paper'), { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }),
    /private, local, metadata, or reserved/
  )
})

test('every redirect is re-resolved, DNS-pinned, peer-checked, and safely staged', async () => {
  const seen = []
  const lookups = []
  const result = await downloadFile('https://first.test/start', {
    lookup: async (hostname) => {
      lookups.push(hostname)
      return [{ address: hostname === 'first.test' ? '93.184.216.34' : '1.1.1.1', family: 4 }]
    },
    requestFactory: fakeRequest([
      { statusCode: 302, headers: { location: 'https://second.test/paper' }, peer: '93.184.216.34' },
      { headers: { 'content-type': 'application/octet-stream' }, peer: '1.1.1.1', body: Buffer.from('%PDF-1.7\nfixture') },
    ], seen),
    timeoutMs: 1000,
    maxBytes: 1024,
  })
  try {
    assert.deepEqual(lookups, ['first.test', 'second.test'])
    assert.equal(seen[0].headers.Host, 'first.test')
    assert.equal(seen[1].headers.Host, 'second.test')
    const pinned = await new Promise((resolve, reject) => seen[1].lookup('second.test', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)))
    assert.deepEqual(pinned, [{ address: '1.1.1.1', family: 4 }])
    assert.equal(fs.readFileSync(result.path, 'utf8').startsWith('%PDF-'), true)
    assert.equal(fs.lstatSync(result.path).mode & 0o077, 0)
    assert.equal(fs.lstatSync(path.dirname(result.path)).mode & 0o077, 0)
    assert.equal(result.warnings.length, 1)
  } finally {
    const directory = path.dirname(result.path)
    result.cleanup()
    assert.equal(fs.existsSync(directory), false)
  }
})

test('peer mismatch, declared oversize, and streamed oversize fail closed', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  await assert.rejects(downloadFile('https://example.test/a', { lookup, requestFactory: fakeRequest([{ peer: '1.1.1.1', body: Buffer.from('%PDF-x') }]), maxBytes: 64 }), /DNS-pinned/)
  await assert.rejects(downloadFile('https://example.test/a', { lookup, requestFactory: fakeRequest([{ headers: { 'content-length': '999' }, body: Buffer.from('%PDF-x') }]), maxBytes: 64 }), /exceeds/)
  await assert.rejects(downloadFile('https://example.test/a', { lookup, requestFactory: fakeRequest([{ body: Buffer.from('%PDF-' + 'x'.repeat(100)) }]), maxBytes: 64 }), /exceeds/)
})

test('synchronous staging write failures reject and remove the private temp directory', async () => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codex-paper-download-')))
  const writeError = Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
  await assert.rejects(
    downloadFile('https://example.test/a', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      requestFactory: fakeRequest([{ body: Buffer.from('%PDF-1.7\nfixture') }]),
      writeChunk: () => { throw writeError },
      maxBytes: 1024,
    }),
    (error) => error === writeError
  )
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codex-paper-download-'))
  assert.deepEqual(after.filter((name) => !before.has(name)), [])
})

test('local staging rejects symlinks and fake PDFs but accepts signature without extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-pdf-stage-test-'))
  try {
    const source = path.join(root, 'paper-without-extension')
    fs.writeFileSync(source, '%PDF-1.7\nfixture')
    const staged = await stagePdfInput(source)
    const directory = path.dirname(staged.path)
    assert.match(staged.warnings[0], /no \.pdf extension/)
    staged.cleanup()
    assert.equal(fs.existsSync(directory), false)
    const fake = path.join(root, 'fake.pdf')
    fs.writeFileSync(fake, 'not a pdf')
    await assert.rejects(stagePdfInput(fake), /signature/)
    const link = path.join(root, 'linked.pdf')
    fs.symlinkSync(source, link)
    await assert.rejects(stagePdfInput(link), /invalid file type/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('PDF preflight and parsed page budget are hard conditions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-pdf-policy-test-'))
  try {
    const valid = path.join(root, 'valid.bin')
    fs.writeFileSync(valid, '%PDF-1.4\nfixture')
    assert.equal(preflightPdfFile(valid).magic, '%PDF-')
    const snapshot = path.join(root, 'snapshot.pdf')
    copyPdfSnapshot(valid, snapshot)
    assert.equal(fs.lstatSync(snapshot).mode & 0o777, 0o400)
    assert.equal(fs.readFileSync(snapshot, 'utf8'), fs.readFileSync(valid, 'utf8'))
    assert.throws(() => validateParsedPdf({ publicData: { pageCount: 0 } }), /no valid pages/)
    assert.throws(() => validateParsedPdf({ publicData: { pageCount: PDF_SECURITY_POLICY.maxPages + 1 } }), /page limit/)
    const oversized = path.join(root, 'oversized.pdf')
    fs.writeFileSync(oversized, '%PDF-')
    fs.truncateSync(oversized, PDF_SECURITY_POLICY.maxInputBytes + 1)
    assert.throws(() => preflightPdfFile(oversized), /exceeds/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('quarantine is private, bounded metadata omits source paths, and expiry cleanup works', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-quarantine-test-'))
  const env = { ...process.env, PAPERS_DIR: path.join(root, 'library') }
  try {
    const source = path.join(root, 'malformed.pdf')
    fs.writeFileSync(source, '%PDF-malformed')
    const item = quarantinePdf(source, Object.assign(new Error('synthetic malformed input'), { code: 'pdf_malformed' }), { env })
    const entry = path.join(env.PAPERS_DIR, '.quarantine', item.entryId)
    assert.equal(fs.lstatSync(path.dirname(entry)).mode & 0o077, 0)
    assert.equal(fs.lstatSync(entry).mode & 0o077, 0)
    assert.equal(fs.lstatSync(path.join(entry, 'source.pdf')).mode & 0o077, 0)
    const metadataText = fs.readFileSync(path.join(entry, 'metadata.json'), 'utf8')
    assert.doesNotMatch(metadataText, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    fs.utimesSync(entry, new Date(0), new Date(0))
    assert.deepEqual(sweepPdfQuarantine({ env }), { entries: 0, bytes: 0 })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('in-process parser entrypoint refuses to bypass the bounded supervisor', async () => {
  await assert.rejects(parsePdfDetailedWorkerInternal('/tmp/anything.pdf'), /In-process PDF parsing is disabled/)
})

test('bounded parser rejects encrypted, over-page, and malformed PDFs into a temporary quarantine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-parser-policy-test-'))
  const previous = process.env.PAPERS_DIR
  process.env.PAPERS_DIR = path.join(root, 'library')
  try {
    const encrypted = path.join(root, 'encrypted.pdf')
    const overPages = path.join(root, 'over-pages.pdf')
    const generated = spawnSync(managedPython, ['-I', '-B', '-c', [
      'import fitz, sys',
      'encrypted=fitz.open(); encrypted.new_page(); encrypted.save(sys.argv[1], encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")',
      'many=fitz.open()',
      `for _ in range(${PDF_SECURITY_POLICY.maxPages + 1}): many.new_page()`,
      'many.save(sys.argv[2])',
    ].join('\n'), encrypted, overPages], { encoding: 'utf8', timeout: 30000 })
    assert.equal(generated.status, 0, generated.stderr)
    await assert.rejects(parsePdfDetailed(encrypted), (error) => error.code === 'pdf_encrypted')
    await assert.rejects(parsePdfDetailed(overPages), (error) => error.code === 'pdf_page_limit')
    const malformed = path.join(root, 'malformed.pdf')
    fs.writeFileSync(malformed, '%PDF-this-is-not-a-valid-document')
    await assert.rejects(parsePdfDetailed(malformed), (error) => error.code === 'pdf_parse_failed')
    const entries = fs.readdirSync(path.join(process.env.PAPERS_DIR, '.quarantine'))
    assert.equal(entries.length, 3)
    for (const entry of entries) {
      assert.equal(fs.lstatSync(path.join(process.env.PAPERS_DIR, '.quarantine', entry)).mode & 0o077, 0)
    }
  } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('prepare workflow uses the safe staging snapshot and cleans it after success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-prepare-security-test-'))
  const source = path.join(root, 'valid-source-without-extension')
  const generated = spawnSync(managedPython, ['-I', '-B', '-c', [
    'import fitz, sys',
    'doc=fitz.open(); page=doc.new_page(); page.insert_text((72,72), "Secure Prepare Paper\\nA. Author\\nAbstract\\nA bounded parser fixture.\\n1 Introduction\\nSafe staging.\\n2 Conclusion\\nDone."); doc.save(sys.argv[1])',
  ].join('\n'), source], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const previous = process.env.PAPERS_DIR
  process.env.PAPERS_DIR = path.join(root, 'library')
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codex-paper-download-')))
  try {
    const module = await import(`../../plugins/codex-paper/skills/study/scripts/prepare-paper.js?security-test=${Date.now()}`)
    const result = await module.preparePaper(source)
    assert.equal(fs.existsSync(path.join(result.paperDir, 'paper.pdf')), true)
    assert.equal(result.sourceFilename, path.basename(source))
    assert.match(result.paperData.warnings.join(' '), /no \.pdf extension/)
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codex-paper-download-') && !before.has(name))
    assert.deepEqual(after, [])
  } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
