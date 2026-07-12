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
fs.writeFileSync(path.join(paperDir, 'README.md'), '# HTTP Security Fixture\n')
fs.writeFileSync(path.join(paperDir, 'notes', 'public.md'), 'public content')
fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ title: 'Fixture', slug: 'sample-paper', tags: [] }))
fs.writeFileSync(path.join(paperDir, '.secret'), 'hidden')
fs.writeFileSync(path.join(libraryRoot, 'index.json'), JSON.stringify([{ title: 'Fixture', slug: 'sample-paper', authors: [], abstract: '', tags: [] }]))
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
  assert.equal((await request('GET', '/api/papers', { headers: auth })).status, 200)
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json')))[0].tags[0], 'x')
  process.stdout.write('Viewer HTTP security integration passed.\n')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  fs.rmSync(libraryRoot, { recursive: true, force: true })
}
