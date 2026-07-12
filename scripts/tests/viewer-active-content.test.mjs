import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createNotebookView,
  createStaticHtmlPreview,
  renderSafeMarkdown,
  sanitizeExternalUrl,
  sanitizePaperIndexEntry,
} from '../../plugins/codex-paper/src/web/server/utils/activeContentSecurity.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('Markdown escapes raw HTML and removes active attributes, schemes, frames, and external images', () => {
  const html = renderSafeMarkdown(`
# Safe heading
[javascript](javascript:alert(1))
[vbscript](vbscript:msgbox(1))
![external](https://evil.test/pixel.png)
![internal](images/chart.png)
![svg](images/payload.svg)
![fake-png](data:image/png;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)

<script>globalThis.pwned = true</script>

<img src=x onerror=alert(1)>

<meta http-equiv="refresh" content="0;url=https://evil.test">

<iframe src="https://evil.test"></iframe>
`, { slug: 'sample-paper', sourcePath: 'README.md' })

  assert.match(html, /<h1>Safe heading<\/h1>/)
  assert.doesNotMatch(html, /<script|<iframe|<meta|<img[^>]+onerror\s*=/i)
  assert.doesNotMatch(html, /https:\/\/evil\.test\/pixel/)
  assert.match(html, /\/api\/papers\/sample-paper\/raw\?path=images%2Fchart\.png/)
  assert.doesNotMatch(html, /payload\.svg/)
  assert.doesNotMatch(html, /PHN2ZyBvbmxvYWQ/)
  assert.match(html, /&lt;script&gt;/)
})

test('Markdown preserves safe structure, KaTeX, fragments, and hardened HTTP links', () => {
  const html = renderSafeMarkdown(`
| A | B |
| - | - |
| 1 | 2 |

<details><summary>raw HTML is shown, not executed</summary></details>

$x^2$

[section](#part) [source](https://example.com/paper)
`, { slug: 'sample-paper', sourcePath: 'notes/topic.md' })

  assert.match(html, /<table>/)
  assert.match(html, /class="katex/)
  assert.match(html, /href="#part"/)
  assert.match(html, /href="https:\/\/example\.com\/paper" target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /\sstyle=/i)
})

test('KaTeX keeps pinned complex-layout classes without allowing raw HTML classes', () => {
  const html = renderSafeMarkdown(String.raw`
$$\begin{pmatrix}a&b\\c&d\end{pmatrix} \quad \widehat{abc} \quad \overrightarrow{xy}$$

<span class="tag cancel-pad col-align-c" onclick="alert(1)">raw</span>
`)
  const renderedClasses = new Set(
    [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))
  )
  for (const className of ['mtable', 'col-align-c', 'arraycolsep', 'accent', 'delimcenter', 'hide-tail', 'svg-align']) {
    assert.ok(renderedClasses.has(className), className)
  }
  assert.doesNotMatch(html, /<span[^>]+onclick=/i)
  assert.match(html, /&lt;span class="tag cancel-pad col-align-c"/)
})

test('static HTML preview has one restrictive CSP and removes active content, CSS, navigation, and resources', () => {
  const preview = createStaticHtmlPreview(`<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="script-src *">
    <meta http-equiv="refresh" content="0;url=https://evil.test">
    <link rel="stylesheet" href="https://evil.test/a.css"><style>body{display:none}</style>
  </head><body onload="pwn()">
    <script>pwn()</script><form action="https://evil.test"><input></form>
    <iframe src="https://evil.test"></iframe><video src="https://evil.test/a"></video>
    <a href="https://evil.test">leave</a><div style="color:red">safe text</div>
    <img src="https://evil.test/pixel"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7V8AAAAASUVORK5CYII=">
  </body></html>`)

  assert.equal((preview.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1)
  assert.match(preview, /script-src 'none'/)
  assert.match(preview, /connect-src 'none'/)
  assert.match(preview, /form-action 'none'/)
  assert.doesNotMatch(preview, /<script|<form|<iframe|<video|<link|onload=|https:\/\/evil\.test|body\{display:none\}|color:red/i)
  assert.match(preview, /<span>leave<\/span>/)
  assert.match(preview, /data:image\/png;base64,iVBORw0KGgo/)
})

test('Notebook produces structured cells and blocks HTML, SVG, and JavaScript rich output', () => {
  const notebook = createNotebookView(JSON.stringify({
    metadata: { kernelspec: { language: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n<script>pwn()</script>'] },
      {
        cell_type: 'code', source: ['print(1)'], execution_count: 7, outputs: [
          { output_type: 'stream', name: 'stdout', text: ['1\n'] },
          { output_type: 'display_data', data: { 'text/html': '<img src=x onerror=pwn()>' } },
          { output_type: 'display_data', data: { 'image/svg+xml': '<svg onload=pwn()></svg>' } },
          { output_type: 'display_data', data: { 'application/javascript': 'pwn()' } },
          { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7V8AAAAASUVORK5CYII=' } },
          { output_type: 'error', traceback: ['\u001b[31mboom\u001b[0m'] }
        ]
      },
      { cell_type: 'raw', source: ['<script>raw</script>'] }
    ]
  }), { slug: 'sample-paper', sourcePath: 'demo.ipynb' })

  assert.equal(notebook.language, 'python')
  assert.match(notebook.cells[0].renderedHtml, /&lt;script&gt;/)
  assert.equal(notebook.cells[1].outputs[0].kind, 'text')
  assert.deepEqual(notebook.cells[1].outputs.slice(1, 4).map((item) => item.kind), ['blocked', 'blocked', 'blocked'])
  assert.match(notebook.cells[1].outputs[4].dataUrl, /^data:image\/png;base64,iVBORw0KGgo/)
  assert.equal(notebook.cells[1].outputs[5].text, 'boom')
  assert.equal(notebook.cells[2].source, '<script>raw</script>')
})

test('paper metadata exposes only HTTP(S) external URLs', () => {
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeExternalUrl('file:///etc/passwd'), null)
  assert.equal(sanitizeExternalUrl('https://example.com/paper'), 'https://example.com/paper')
  const safe = sanitizePaperIndexEntry({
    url: 'javascript:alert(1)',
    githubLinks: ['https://github.com/example/repo', 'vbscript:bad'],
    codeLinks: ['file:///tmp/code', 'http://example.com/code']
  })
  assert.equal(safe.url, null)
  assert.deepEqual(safe.githubLinks, ['https://github.com/example/repo'])
  assert.deepEqual(safe.codeLinks, ['http://example.com/code'])
})

test('Notebook rejects non-raster bytes mislabeled as PNG', () => {
  const notebook = createNotebookView(JSON.stringify({
    cells: [{ cell_type: 'code', source: [], outputs: [{ output_type: 'display_data', data: { 'image/png': 'PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+' } }] }]
  }))
  assert.equal(notebook.cells[0].outputs[0].kind, 'blocked')
  assert.equal(notebook.cells[0].outputs[0].mimeType, 'image/png')
})

test('Viewer v-html is limited to server-sanitized outputs or highlight.js output', () => {
  const viewerRoot = path.join(repoRoot, 'plugins/codex-paper/src/web')
  const vueFiles = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.name.endsWith('.vue')) vueFiles.push(target)
    }
  }
  visit(viewerRoot)

  const allowed = new Set(['askAnswerHtml', 'highlightedHtmlCode', 'highlightedCode', 'cell.renderedHtml', 'fileRenderedHtml'])
  for (const file of vueFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/v-html="([^"]+)"/g)) {
      assert.ok(allowed.has(match[1]), `${path.relative(repoRoot, file)} has unapproved v-html expression: ${match[1]}`)
    }
  }
  assert.equal(fs.existsSync(path.join(viewerRoot, 'components/PaperContent.vue')), false)
})

test('Viewer source contains no active HTML preview escape hatch or remote fonts', () => {
  const viewerRoot = path.join(repoRoot, 'plugins/codex-paper/src/web')
  const detail = fs.readFileSync(path.join(viewerRoot, 'pages/papers/[slug].vue'), 'utf8')
  assert.doesNotMatch(detail, /allow-scripts|allow-same-origin|createObjectURL|window\.open|processedHtmlContent|marked\.parse/)
  assert.match(detail, /sandbox=""/)
  const sources = fs.readFileSync(path.join(viewerRoot, 'pages/index.vue'), 'utf8') + detail
  assert.doesNotMatch(sources, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
})
