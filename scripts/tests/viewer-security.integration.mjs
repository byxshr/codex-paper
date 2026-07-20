import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverEntry = path.join(repoRoot, 'plugins/codex-paper/src/web/.output/server/index.mjs')
if (!fs.existsSync(serverEntry)) throw new Error('Production Viewer build is required before security-test')
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-http-security-'))
const port = 59000 + Math.floor(Math.random() * 500)
const origin = `http://127.0.0.1:${port}`
const token = randomBytes(32).toString('hex')
const paperDir = path.join(libraryRoot, 'papers', 'sample-paper')
fs.mkdirSync(path.join(paperDir, 'notes'), { recursive: true })
fs.writeFileSync(path.join(paperDir, 'README.md'), '# HTTP Security Fixture\n\n<script>globalThis.markdownPwned = true</script>\n\n[bad](javascript:alert(1))\n')
fs.writeFileSync(path.join(paperDir, 'notes', 'public.md'), '# Public\n\n<img src=x onerror=alert(1)>\n')
fs.writeFileSync(path.join(paperDir, 'chat-notes.md'), '# Chat\n\n<iframe src="http://127.0.0.1/canary"></iframe>\n')
fs.writeFileSync(path.join(paperDir, 'unsafe.html'), '<style>body{display:none}</style><script>globalThis.htmlPwned=true</script><form action="https://evil.test"><button>go</button></form><a href="https://evil.test">leave</a><p style="color:red" onclick="pwn()">visible</p>')
fs.writeFileSync(path.join(paperDir, 'unsafe.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.svgPwned=true"><script>alert(1)</script><image href="https://evil.test/pixel" /></svg>')
fs.writeFileSync(path.join(paperDir, 'unsafe.ipynb'), JSON.stringify({
  metadata: { kernelspec: { language: 'python' } },
  cells: [
    { cell_type: 'markdown', source: ['<script>globalThis.notebookPwned=true</script>'] },
    { cell_type: 'code', source: ['print(1)'], outputs: [
      { output_type: 'display_data', data: { 'text/html': '<img src=x onerror=pwn()>' } },
      { output_type: 'display_data', data: { 'image/svg+xml': '<svg onload=pwn()></svg>' } },
      { output_type: 'display_data', data: { 'application/javascript': 'fetch("/api/papers")' } }
    ] }
  ]
}))
fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ title: 'Fixture', slug: 'sample-paper', tags: [], packageVersion: '2.1.0' }))
fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify({ schemaVersion: '2.1.0', coreClaims: [], resultClaims: [], keyResults: [], limitations: [] }))
fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify({ analysisVersion: '1.0.0', resultsTable: [] }))
fs.writeFileSync(path.join(paperDir, 'evidence-ledger.json'), JSON.stringify({ schemaVersion: '2.0.0', evidence: [] }))
fs.writeFileSync(path.join(paperDir, 'reasoning-analysis.json'), JSON.stringify({ schemaVersion: '2.0.0', centralClaims: [], researchQuestion: {}, authorReasoningPath: [], validations: [] }))
const unknownDir = path.join(libraryRoot, 'papers', 'unknown-paper')
fs.mkdirSync(unknownDir, { recursive: true })
fs.writeFileSync(path.join(unknownDir, 'meta.json'), JSON.stringify({ title: 'Unknown', slug: 'unknown-paper', packageVersion: '9.0.0' }))
fs.writeFileSync(path.join(unknownDir, 'facts.json'), JSON.stringify({ keyResults: [] }))
fs.writeFileSync(path.join(unknownDir, 'analysis.json'), JSON.stringify({ resultsTable: [] }))
const mismatchDir = path.join(libraryRoot, 'papers', 'mismatch-paper')
fs.mkdirSync(mismatchDir, { recursive: true })
fs.writeFileSync(path.join(mismatchDir, 'facts.json'), JSON.stringify({ keyResults: [] }))
fs.writeFileSync(path.join(mismatchDir, 'analysis.json'), JSON.stringify({ resultsTable: [] }))
fs.writeFileSync(path.join(mismatchDir, 'reasoning-analysis.json'), JSON.stringify({ schemaVersion: '2.0.0', centralClaims: [], researchQuestion: {}, authorReasoningPath: [], validations: [] }))
fs.writeFileSync(path.join(mismatchDir, 'evidence-ledger.json'), JSON.stringify({ schemaVersion: '3.0.0', evidence: [] }))
const corruptLedgerDir = path.join(libraryRoot, 'papers', 'corrupt-ledger-paper')
fs.mkdirSync(corruptLedgerDir, { recursive: true })
fs.writeFileSync(path.join(corruptLedgerDir, 'facts.json'), JSON.stringify({ keyResults: [] }))
fs.writeFileSync(path.join(corruptLedgerDir, 'analysis.json'), JSON.stringify({ resultsTable: [] }))
fs.writeFileSync(path.join(corruptLedgerDir, 'evidence-ledger.json'), '{not-json')
const corruptMetaDir = path.join(libraryRoot, 'papers', 'corrupt-meta-paper')
fs.mkdirSync(corruptMetaDir, { recursive: true })
fs.writeFileSync(path.join(corruptMetaDir, 'facts.json'), JSON.stringify({ keyResults: [] }))
fs.writeFileSync(path.join(corruptMetaDir, 'analysis.json'), JSON.stringify({ resultsTable: [] }))
fs.writeFileSync(path.join(corruptMetaDir, 'meta.json'), '{not-json')
fs.writeFileSync(path.join(paperDir, '.secret'), 'hidden')
fs.writeFileSync(path.join(libraryRoot, 'index.json'), JSON.stringify([
  { title: 'Fixture', slug: 'sample-paper', authors: [], abstract: '', tags: [], url: 'javascript:alert(1)', githubLinks: ['https://github.com/example/repo', 'file:///tmp/secret'], codeLinks: ['vbscript:bad'] },
  { title: 'Unknown', slug: 'unknown-paper', authors: [], abstract: '', tags: [] },
  { title: 'Mismatch', slug: 'mismatch-paper', authors: [], abstract: '', tags: [] },
  { title: 'Corrupt Ledger', slug: 'corrupt-ledger-paper', authors: [], abstract: '', tags: [] },
  { title: 'Corrupt Meta', slug: 'corrupt-meta-paper', authors: [], abstract: '', tags: [] }
]))
try { fs.symlinkSync('/etc/passwd', path.join(paperDir, 'escape.txt')) } catch {}

const child = spawn(process.execPath, [serverEntry], {
  cwd: path.dirname(serverEntry),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    PAPERS_DIR: libraryRoot,
    CODEX_PAPER_PAIRING_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (chunk) => { logs += chunk })
child.stderr.on('data', (chunk) => { logs += chunk })

function request(method, requestPath, { headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const request = http.request({ hostname: '127.0.0.1', port, method, path: requestPath, headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request('GET', '/api/health')
      if (response.status === 200) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Viewer did not start:\n${logs}`)
}

try {
  await waitForHealth()
  const shell = await request('GET', '/')
  assert.equal(shell.status, 200)
  assert.match(String(shell.headers['content-security-policy']), /script-src 'self'/)
  assert.match(String(shell.headers['content-security-policy']), /script-src-attr 'none'/)
  assert.match(String(shell.headers['content-security-policy']), /style-src-attr 'none'/)
  assert.match(String(shell.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.equal(shell.headers['x-frame-options'], 'DENY')
  assert.equal(shell.headers['referrer-policy'], 'no-referrer')
  assert.doesNotMatch(shell.text, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
  assert.doesNotMatch(shell.text, /<script>(?!\s*<\/script>)/i, 'SPA shell must not contain inline executable scripts')
  assert.match(shell.text, /<script src="\/__codex-paper-spa-bootstrap\.js"><\/script>/)
  const bootstrap = await request('GET', '/__codex-paper-spa-bootstrap.js')
  assert.equal(bootstrap.status, 200)
  assert.match(String(bootstrap.headers['content-type']), /^application\/javascript/)
  assert.match(bootstrap.text, /^window\.__NUXT__=\{\};window\.__NUXT__\.config=/)
  assert.equal((await request('GET', '/api/health', { host: `localhost:${port}` })).status, 200)
  assert.equal((await request('GET', '/api/health', { host: `evil.test:${port}` })).status, 403)
  for (const requestPath of ['/api/papers', '/api/papers/sample-paper', '/api/papers/sample-paper/files', '/api/papers/sample-paper/file?path=README.md', '/api/papers/sample-paper/raw?path=README.md', '/api/trash']) {
    assert.equal((await request('GET', requestPath)).status, 401, requestPath)
  }
  assert.equal((await request('PATCH', '/api/papers/sample-paper/tags', { headers: { Origin: origin }, body: { tags: [] } })).status, 401)
  assert.equal((await request('POST', '/api/session/pair', { headers: { Origin: `http://localhost:${port}` }, body: { token } })).status, 403)
  assert.equal((await request('POST', '/api/session/pair', { headers: { Origin: origin }, body: { token: 'wrong' } })).status, 401)

  const paired = await request('POST', '/api/session/pair', { headers: { Origin: origin }, body: { token } })
  assert.equal(paired.status, 200)
  assert.match(String(paired.headers['set-cookie']), /HttpOnly/i)
  assert.match(String(paired.headers['set-cookie']), /SameSite=Strict/i)
  assert.equal(logs.includes(token), false, 'pairing token must not enter server logs')
  const cookie = String(paired.headers['set-cookie'][0]).split(';')[0]
  const csrf = paired.json.csrfToken
  const auth = { Cookie: cookie }
  const mutation = { Cookie: cookie, Origin: origin, 'X-Codex-Paper-CSRF': csrf }
  assert.equal((await request('GET', '/api/session', { headers: auth })).status, 200)
  const papers = await request('GET', '/api/papers', { headers: auth })
  assert.equal(papers.status, 200)
  assert.equal(papers.headers['cache-control'], 'no-store')
  assert.equal(papers.json[0].url, null)
  assert.deepEqual(papers.json[0].githubLinks, ['https://github.com/example/repo'])
  assert.deepEqual(papers.json[0].codeLinks, [])

  const detail = await request('GET', '/api/papers/sample-paper', { headers: auth })
  assert.equal(detail.status, 200)
  assert.match(detail.json.markdown, /<script>/)
  assert.match(detail.json.renderedHtml, /&lt;script&gt;/)
  assert.doesNotMatch(detail.json.renderedHtml, /<script|javascript:/i)

  const ledgerPath = path.join(paperDir, 'evidence-ledger.json')
  const ledgerContent = fs.readFileSync(ledgerPath, 'utf8')
  fs.writeFileSync(ledgerPath, '{not-json')
  try {
    for (const endpoint of ['facts', 'analysis', 'reasoning']) {
      const response = await request('GET', `/api/papers/sample-paper/${endpoint}`, { headers: auth })
      assert.equal(response.status, 200)
      assert.equal(response.json.compatibility.mode, 'native_2_1')
      assert.equal(response.json.compatibility.readOnly, false)
    }
  } finally {
    fs.writeFileSync(ledgerPath, ledgerContent)
  }
  const unknownBefore = new Map(['meta.json', 'facts.json', 'analysis.json'].map((name) => [name, fs.statSync(path.join(unknownDir, name)).mtimeMs]))
  for (const endpoint of ['facts', 'analysis', 'reasoning']) {
    const response = await request('GET', `/api/papers/unknown-paper/${endpoint}`, { headers: auth })
    assert.equal(response.status, 200)
    assert.equal(response.json.compatibility.mode, 'unknown_read_only')
    assert.equal(response.json.compatibility.diagnostics[0].code, 'PACKAGE_VERSION_UNSUPPORTED')
  }
  for (const [name, mtime] of unknownBefore) assert.equal(fs.statSync(path.join(unknownDir, name)).mtimeMs, mtime)

  for (const endpoint of ['facts', 'analysis', 'reasoning']) {
    const response = await request('GET', `/api/papers/mismatch-paper/${endpoint}`, { headers: auth })
    assert.equal(response.status, 200)
    assert.equal(response.json.compatibility.mode, 'unknown_read_only')
    assert.equal(response.json.compatibility.diagnostics[0].code, 'PACKAGE_VERSION_UNSUPPORTED')
  }

  for (const endpoint of ['facts', 'analysis', 'reasoning']) {
    const response = await request('GET', `/api/papers/corrupt-ledger-paper/${endpoint}`, { headers: auth })
    assert.equal(response.status, 200)
    assert.equal(response.json.compatibility.mode, 'unknown_read_only')
    assert.equal(response.json.compatibility.readOnly, true)
    assert.equal(response.json.compatibility.diagnostics[0].code, 'PACKAGE_ARTIFACT_INVALID')
  }

  for (const endpoint of ['facts', 'analysis']) {
    const response = await request('GET', `/api/papers/corrupt-meta-paper/${endpoint}`, { headers: auth })
    assert.equal(response.status, 200)
    assert.equal(response.json.compatibility.mode, 'unknown_read_only')
    assert.equal(response.json.compatibility.readOnly, true)
    assert.equal(response.json.compatibility.diagnostics[0].code, 'PACKAGE_ARTIFACT_INVALID')
    assert.match(response.json.compatibility.diagnostics[0].message, /meta\.json/)
  }

  const markdownFile = await request('GET', '/api/papers/sample-paper/file?path=notes%2Fpublic.md', { headers: auth })
  assert.equal(markdownFile.status, 200)
  assert.match(markdownFile.json.content, /onerror=/)
  assert.doesNotMatch(markdownFile.json.renderedHtml, /<img[^>]+onerror=/i)

  const chatNotes = await request('GET', '/api/papers/sample-paper/file?path=chat-notes.md', { headers: auth })
  assert.equal(chatNotes.status, 200)
  assert.doesNotMatch(chatNotes.json.renderedHtml, /<iframe/i)

  const htmlFile = await request('GET', '/api/papers/sample-paper/file?path=unsafe.html', { headers: auth })
  assert.equal(htmlFile.status, 200)
  assert.match(htmlFile.json.content, /<script>/)
  assert.equal((htmlFile.json.previewHtml.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1)
  assert.doesNotMatch(htmlFile.json.previewHtml, /<script|<style>body|<form|onclick=|https:\/\/evil\.test/i)
  assert.match(htmlFile.json.previewHtml, /script-src 'none'/)

  const notebookFile = await request('GET', '/api/papers/sample-paper/file?path=unsafe.ipynb', { headers: auth })
  assert.equal(notebookFile.status, 200)
  assert.equal(notebookFile.json.content, null)
  assert.match(notebookFile.json.notebook.cells[0].renderedHtml, /&lt;script&gt;/)
  assert.deepEqual(notebookFile.json.notebook.cells[1].outputs.map((output) => output.kind), ['blocked', 'blocked', 'blocked'])

  const svgFile = await request('GET', '/api/papers/sample-paper/file?path=unsafe.svg', { headers: auth })
  assert.equal(svgFile.status, 200)
  assert.equal(svgFile.json.type, 'svg')
  assert.match(svgFile.json.content, /onload=/)
  assert.match(svgFile.json.downloadUrl, /unsafe\.svg/)
  const svgRaw = await request('GET', '/api/papers/sample-paper/raw?path=unsafe.svg', { headers: auth })
  assert.equal(svgRaw.status, 200)
  assert.equal(svgRaw.headers['content-type'], 'application/octet-stream')
  assert.match(String(svgRaw.headers['content-disposition']), /^attachment;/)
  assert.match(String(svgRaw.headers['content-security-policy']), /sandbox/)
  const htmlRaw = await request('GET', '/api/papers/sample-paper/raw?path=unsafe.html', { headers: auth })
  assert.equal(htmlRaw.status, 200)
  assert.equal(htmlRaw.headers['content-type'], 'application/octet-stream')
  assert.match(String(htmlRaw.headers['content-disposition']), /^attachment;/)
  assert.equal((await request('PATCH', '/api/papers/sample-paper/tags', { headers: auth, body: { tags: ['x'] } })).status, 403)
  assert.equal((await request('PATCH', '/api/papers/sample-paper/tags', { headers: { ...auth, Origin: origin }, body: { tags: ['x'] } })).status, 403)
  assert.equal((await request('PATCH', '/api/papers/sample-paper/tags', { headers: mutation, body: { tags: ['x', 'x'] } })).status, 200)
  assert.equal((await request('GET', '/api/papers/sample-paper/file?path=..%2F..%2Fetc%2Fpasswd', { headers: auth })).status, 403)
  assert.equal((await request('GET', '/api/papers/sample-paper/file?path=.secret', { headers: auth })).status, 404)
  assert.equal((await request('GET', '/api/papers/sample-paper/file?path=escape.txt', { headers: auth })).status, 403)

  assert.equal((await request('DELETE', '/api/papers/sample-paper/delete', { headers: mutation })).status, 409)
  const prepared = await request('POST', '/api/papers/sample-paper/delete/prepare', { headers: mutation })
  assert.equal(prepared.status, 200)
  const deleted = await request('DELETE', '/api/papers/sample-paper/delete', { headers: { ...mutation, 'X-Codex-Paper-Confirmation': prepared.json.confirmationToken } })
  assert.equal(deleted.status, 200)
  assert.equal(fs.existsSync(paperDir), false)
  assert.equal((await request('DELETE', '/api/papers/sample-paper/delete', { headers: { ...mutation, 'X-Codex-Paper-Confirmation': prepared.json.confirmationToken } })).status, 409)
  const trash = await request('GET', '/api/trash', { headers: auth })
  assert.equal(trash.status, 200)
  assert.equal(trash.json.length, 1)
  assert.equal((await request('POST', `/api/trash/${trash.json[0].trashId}/restore`, { headers: mutation })).status, 200)
  assert.equal(fs.existsSync(paperDir), true)
  assert.equal((await request('POST', `/api/trash/${trash.json[0].trashId}/restore`, { headers: mutation })).status, 404)
  const restoredIndex = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8'))
  assert.equal(restoredIndex.find((entry) => entry.slug === 'sample-paper').tags[0], 'x')
  process.stdout.write('Viewer HTTP security integration passed.\n')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  fs.rmSync(libraryRoot, { recursive: true, force: true })
}
