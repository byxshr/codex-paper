import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'plugins/codex-paper/src/web/.output/server/index.mjs')
if (!fs.existsSync(serverEntry)) throw new Error('Run the production Viewer build first')

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-browser-qa-'))
const paperDir = path.join(libraryRoot, 'papers', 'active-content-fixture')
const port = Number(process.env.CODEX_PAPER_BROWSER_QA_PORT || 59615)
const canaryPort = Number(process.env.CODEX_PAPER_CANARY_PORT || port + 1)
const token = randomBytes(32).toString('hex')
const origin = `http://127.0.0.1:${port}`
const canaryOrigin = `http://127.0.0.1:${canaryPort}`
let canaryHits = []

fs.mkdirSync(path.join(paperDir, 'images'), { recursive: true })
fs.writeFileSync(path.join(paperDir, 'README.md'), `# Active Content Fixture

Safe Markdown remains visible.

<script>globalThis.markdownPwned = true; fetch('${canaryOrigin}/markdown')</script>

![external](${canaryOrigin}/pixel.png)
`)
fs.writeFileSync(path.join(paperDir, 'chat-notes.md'), `# Ask History

<img src=x onerror="globalThis.askPwned=true;fetch('${canaryOrigin}/ask')">
`)
fs.writeFileSync(path.join(paperDir, 'unsafe.html'), `<!doctype html><html><head>
<style>body{display:none}</style><meta http-equiv="refresh" content="0;url=${canaryOrigin}/navigate">
</head><body onload="globalThis.htmlPwned=true">
<script>globalThis.htmlPwned=true;fetch('${canaryOrigin}/html')</script>
<form action="${canaryOrigin}/form"><button>submit</button></form>
<iframe src="${canaryOrigin}/frame"></iframe><a href="${canaryOrigin}/link">leave</a>
<p style="color:red">STATIC_PREVIEW_VISIBLE</p></body></html>`)
fs.writeFileSync(path.join(paperDir, 'unsafe.svg'), `<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.svgPwned=true;fetch('${canaryOrigin}/svg')"><script>alert(1)</script><text>SVG_SOURCE_VISIBLE</text></svg>`)
fs.writeFileSync(path.join(paperDir, 'unsafe.ipynb'), JSON.stringify({
  metadata: { kernelspec: { language: 'python' } },
  cells: [
    { cell_type: 'markdown', source: [`# Notebook Markdown\n<script>globalThis.notebookMarkdownPwned=true;fetch('${canaryOrigin}/nb-md')</script>`] },
    { cell_type: 'code', source: ['print("safe")'], execution_count: 1, outputs: [
      { output_type: 'stream', name: 'stdout', text: ['safe\n'] },
      { output_type: 'display_data', data: { 'text/html': `<img src=x onerror="fetch('${canaryOrigin}/nb-html')">` } },
      { output_type: 'display_data', data: { 'image/svg+xml': `<svg onload="fetch('${canaryOrigin}/nb-svg')"></svg>` } },
      { output_type: 'display_data', data: { 'application/javascript': `globalThis.notebookJsPwned=true;fetch('${canaryOrigin}/nb-js')` } }
    ] }
  ]
}))
fs.writeFileSync(path.join(paperDir, 'images', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7V8AAAAASUVORK5CYII=', 'base64'))
fs.writeFileSync(path.join(libraryRoot, 'index.json'), JSON.stringify([{ title: 'Active Content Fixture', slug: 'active-content-fixture', authors: ['Codex'], abstract: 'Synthetic redistributable browser QA fixture.', tags: ['security'], url: 'javascript:alert(1)' }]))

const canary = http.createServer((request, response) => {
  if (request.url === '/stats') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ hits: canaryHits }))
    return
  }
  canaryHits.push({ method: request.method, url: request.url })
  response.statusCode = 204
  response.end()
})

await new Promise((resolve) => canary.listen(canaryPort, '127.0.0.1', resolve))
const viewer = spawn(process.execPath, [serverEntry], {
  cwd: path.dirname(serverEntry),
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
    PAPERS_DIR: libraryRoot, CODEX_PAPER_PAIRING_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
viewer.stdout.on('data', (chunk) => process.stderr.write(chunk))
viewer.stderr.on('data', (chunk) => process.stderr.write(chunk))

const cleanup = () => {
  viewer.kill('SIGTERM')
  canary.close()
  fs.rmSync(libraryRoot, { recursive: true, force: true })
}
process.once('SIGINT', () => { cleanup(); process.exit(0) })
process.once('SIGTERM', () => { cleanup(); process.exit(0) })
viewer.once('exit', (code) => {
  if (code && code !== 0) process.exitCode = code
})

process.stdout.write(`${JSON.stringify({ origin, token, canaryStats: `${canaryOrigin}/stats`, libraryRoot })}\n`)
await new Promise(() => {})
