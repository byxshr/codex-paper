import path from 'node:path'
import sanitizeHtml from 'sanitize-html'
import { Marked, Renderer } from 'marked'
import markedKatex from 'marked-katex-extension'
import { isPublicRelativePath, normalizeRelativePath } from './librarySecurity.mjs'

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/=\s]+)$/i
const SAFE_FRAGMENT = /^#[A-Za-z0-9_.:-]+$/
const SAFE_BASE64 = /^[A-Za-z0-9+/=\s]+$/

// Raw HTML is escaped before KaTeX runs, so these classes can only come from
// the pinned KaTeX renderer. Keep the list aligned with its bundled CSS rather
// than allowing arbitrary user-controlled class names.
const KATEX_ALLOWED_CLASSES = Object.freeze([
  'accent', 'accent-body', 'accent-full', 'amsrm', 'angl', 'anglpad', 'arraycolsep',
  'base', 'boldsymbol', 'boxpad', 'brace-center', 'brace-left', 'brace-right',
  'cancel-lap', 'cancel-pad', 'cd-arrow-pad', 'cd-label-left', 'cd-label-right',
  'cd-vert-arrow', 'clap', 'col-align-c', 'col-align-l', 'col-align-r', 'delim-size1',
  'delim-size4', 'delimcenter', 'delimsizing', 'eqn-num', 'fbox', 'fcolorbox', 'fix',
  'fleqn', 'fontsize-ensurer', 'frac-line', 'halfarrow-left', 'halfarrow-right',
  'hbox', 'hdashline', 'hide-tail', 'hline', 'inner', 'katex', 'katex-display',
  'katex-html', 'katex-mathml', 'katex-version', 'large-op', 'leqno', 'llap',
  'mainrm', 'mathbb', 'mathbf', 'mathboldfrak', 'mathboldsf', 'mathcal', 'mathfrak',
  'mathit', 'mathitsf', 'mathnormal', 'mathrm', 'mathscr', 'mathsf', 'mathsfit',
  'mathtt', 'mfrac', 'mml-eqn-num', 'mover', 'mspace', 'msupsub', 'mtable',
  'mtr-glue', 'mult', 'munder', 'newline', 'nulldelimiter', 'op-limits', 'op-symbol',
  'overlay', 'overline', 'overline-line', 'pstrut', 'rlap', 'root', 'rule', 'sizing',
  'small-op', 'smash', 'sout', 'sqrt', 'stretchy', 'strut', 'svg-align', 'tag',
  'textbb', 'textbf', 'textboldfrak', 'textboldsf', 'textfrak', 'textit', 'textitsf',
  'textrm', 'textscr', 'textsf', 'texttt', 'thinbox', 'underline', 'underline-line',
  'vbox', 'vertical-separator', 'vlist', 'vlist-r', 'vlist-s', 'vlist-t', 'vlist-t2',
  'x-arrow', 'x-arrow-pad',
  ...Array.from({ length: 11 }, (_, index) => `reset-size${index + 1}`),
  ...Array.from({ length: 11 }, (_, index) => `size${index + 1}`),
])

function hasRasterSignature(buffer, subtype) {
  if (subtype === 'png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (subtype === 'jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (subtype === 'gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  if (subtype === 'webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}

function safeDataImage(value) {
  const match = String(value || '').match(DATA_IMAGE)
  if (!match) return null
  const encoded = match[2].replace(/\s+/g, '')
  if (encoded.length > 24 * 1024 * 1024) return null
  try {
    const buffer = Buffer.from(encoded, 'base64')
    if (!hasRasterSignature(buffer, match[1].toLowerCase())) return null
    return `data:image/${match[1].toLowerCase()};base64,${encoded}`
  } catch {
    return null
  }
}

const MARKDOWN_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del',
  'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'a', 'img', 'span', 'div', 'details', 'summary', 'kbd', 'sup', 'sub',
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace',
  'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom', 'menclose'
]

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function joinText(value) {
  return Array.isArray(value) ? value.join('') : String(value ?? '')
}

function safePaperImageUrl(value, slug, sourcePath) {
  const source = String(value || '').trim()
  const dataImage = safeDataImage(source)
  if (dataImage) return dataImage
  if (!slug || !source || source.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//')) return null

  try {
    const withoutQuery = source.split(/[?#]/, 1)[0]
    const sourceDirectory = path.posix.dirname(sourcePath || 'README.md')
    const combined = sourceDirectory === '.' ? withoutQuery : path.posix.join(sourceDirectory, withoutQuery)
    const normalized = normalizeRelativePath(path.posix.normalize(combined))
    if (!isPublicRelativePath(normalized) || !RASTER_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return null
    return `/api/papers/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(normalized)}`
  } catch {
    return null
  }
}

function sanitizeRenderedMarkdown(html, options) {
  const { slug, sourcePath } = options
  return sanitizeHtml(html, {
    allowedTags: MARKDOWN_TAGS,
    allowedAttributes: {
      '*': ['class', 'aria-hidden'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      ol: ['start'],
      li: ['value'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      annotation: ['encoding'],
      math: ['xmlns'],
    },
    allowedClasses: {
      '*': [
        ...KATEX_ALLOWED_CLASSES,
        /^(?:language-[a-z0-9_-]+|m(?:ord|op|bin|rel|open|close|punct|inner|space|tight|supsub|frac))$/i,
      ]
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (tagName, attribs) => {
        const href = String(attribs.href || '').trim()
        if (SAFE_FRAGMENT.test(href)) return { tagName, attribs: { href } }
        const externalUrl = sanitizeExternalUrl(href)
        if (externalUrl) {
          return { tagName, attribs: { href: externalUrl, target: '_blank', rel: 'noopener noreferrer' } }
        }
        return { tagName: 'span', attribs: {} }
      },
      img: (tagName, attribs) => {
        const src = safePaperImageUrl(attribs.src, slug, sourcePath)
        if (!src) return { tagName: 'span', attribs: { class: 'blocked-image' } }
        return {
          tagName,
          attribs: {
            src,
            alt: String(attribs.alt || ''),
            ...(attribs.title ? { title: String(attribs.title) } : {})
          }
        }
      }
    }
  })
}

export function renderSafeMarkdown(markdown, options = {}) {
  const renderer = new Renderer()
  renderer.html = (token) => {
    const text = typeof token === 'string' ? token : token?.text
    return `<pre class="raw-html"><code>${escapeHtml(text)}</code></pre>`
  }
  const marked = new Marked({ gfm: true, breaks: false, renderer })
  marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))
  const rendered = marked.parse(String(markdown ?? ''))
  return sanitizeRenderedMarkdown(rendered, {
    slug: options.slug || '',
    sourcePath: options.sourcePath || 'README.md'
  })
}

function sanitizedPreviewBody(rawHtml) {
  return sanitizeHtml(String(rawHtml ?? ''), {
    allowedTags: [
      'main', 'section', 'article', 'header', 'footer', 'nav', 'h1', 'h2', 'h3', 'h4',
      'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol',
      'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'span', 'div', 'details', 'summary', 'kbd', 'sup', 'sub', 'img'
    ],
    allowedAttributes: {
      img: ['src', 'alt', 'title'],
      ol: ['start'],
      li: ['value'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan']
    },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'template'],
    transformTags: {
      a: () => ({ tagName: 'span', attribs: {} }),
      img: (tagName, attribs) => {
        const src = safeDataImage(attribs.src)
        return src
          ? { tagName, attribs: { src, alt: String(attribs.alt || ''), ...(attribs.title ? { title: String(attribs.title) } : {}) } }
          : { tagName: 'span', attribs: {} }
      }
    }
  })
}

export function createStaticHtmlPreview(rawHtml) {
  const body = sanitizedPreviewBody(rawHtml)
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const style = 'html{color-scheme:light;background:#fff}body{max-width:960px;margin:0 auto;padding:24px;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937}pre{overflow:auto;padding:12px;background:#f3f4f6}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}table{border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:6px 10px}img{max-width:100%;height:auto}'
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${style}</style></head><body>${body}</body></html>`
}

function safeRasterOutput(data, mimeType) {
  const value = joinText(data).replace(/\s+/g, '')
  if (!value || !SAFE_BASE64.test(value)) return null
  const subtype = mimeType === 'image/jpeg' ? 'jpeg' : 'png'
  let buffer
  try {
    buffer = Buffer.from(value, 'base64')
  } catch {
    return null
  }
  if (!hasRasterSignature(buffer, subtype)) return null
  return { kind: 'image', mimeType, dataUrl: `data:${mimeType};base64,${value}` }
}

function notebookOutputView(output) {
  if (output?.output_type === 'stream') {
    return { kind: output.name === 'stderr' ? 'error' : 'text', text: joinText(output.text) }
  }
  if (output?.output_type === 'error') {
    return { kind: 'error', text: joinText(output.traceback).replace(/\x1b\[[0-9;]*m/g, '') }
  }

  const data = output?.data || {}
  if (data['image/png']) return safeRasterOutput(data['image/png'], 'image/png') || { kind: 'blocked', mimeType: 'image/png', text: '[invalid PNG output]' }
  if (data['image/jpeg']) return safeRasterOutput(data['image/jpeg'], 'image/jpeg') || { kind: 'blocked', mimeType: 'image/jpeg', text: '[invalid JPEG output]' }

  for (const mimeType of ['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript']) {
    if (data[mimeType] != null) return { kind: 'blocked', mimeType, text: joinText(data[mimeType]) }
  }
  if (data['text/plain'] != null) return { kind: 'text', text: joinText(data['text/plain']) }
  return { kind: 'blocked', mimeType: 'unknown', text: '[unsupported notebook output]' }
}

export function createNotebookView(raw, options = {}) {
  const notebook = JSON.parse(raw)
  if (!Array.isArray(notebook.cells)) throw new Error('Notebook cells must be an array')
  const language = String(notebook.metadata?.kernelspec?.language || notebook.metadata?.language_info?.name || 'python').toLowerCase()
  return {
    language,
    cells: notebook.cells.map((cell, index) => {
      const source = joinText(cell?.source)
      if (cell?.cell_type === 'markdown') {
        return { index, type: 'markdown', renderedHtml: renderSafeMarkdown(source, options) }
      }
      if (cell?.cell_type === 'code') {
        return {
          index,
          type: 'code',
          source,
          executionCount: cell.execution_count ?? null,
          outputs: Array.isArray(cell.outputs) ? cell.outputs.map(notebookOutputView) : []
        }
      }
      return { index, type: 'raw', source }
    })
  }
}

export function sanitizeExternalUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function sanitizePaperIndexEntry(entry) {
  const safe = { ...entry }
  safe.url = sanitizeExternalUrl(entry?.url)
  safe.githubLinks = Array.isArray(entry?.githubLinks) ? entry.githubLinks.map(sanitizeExternalUrl).filter(Boolean) : []
  safe.codeLinks = Array.isArray(entry?.codeLinks) ? entry.codeLinks.map(sanitizeExternalUrl).filter(Boolean) : []
  return safe
}
