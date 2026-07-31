import path from 'node:path'
import { LIMITS, readFileNoFollow, resolvePublicFile, validateSlug } from '../../../utils/librarySecurity.mjs'
import { createNotebookView, createStaticHtmlPreview, renderSafeMarkdown } from '../../../utils/activeContentSecurity.mjs'

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

function getFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (RASTER_EXTENSIONS.has(ext)) return 'image'
  if (ext === '.svg') return 'svg'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.ipynb') return 'notebook'
  if (['.md', '.markdown'].includes(ext)) return 'markdown'
  if (['.txt', '.log'].includes(ext)) return 'text'
  if ([
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh',
    '.bash', '.zsh', '.fish', '.ps1', '.r', '.m', '.sql', '.json', '.xml',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.vue', '.svelte',
    '.css', '.scss', '.sass', '.less'
  ].includes(ext)) return 'code'
  return 'unknown'
}

function getLanguageFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return ({
    '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript',
    '.tsx': 'typescript', '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.h': 'c',
    '.hpp': 'cpp', '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
    '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.sql': 'sql', '.json': 'json',
    '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.vue': 'vue'
  } as Record<string, string>)[ext] || 'plaintext'
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = getQuery(event).path
  if (!validateSlug(slug) || typeof filePath !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Valid slug and path are required' })
  }

  try {
    const resolved = resolvePublicFile(slug!, filePath)
    const type = getFileType(filePath)
    const rawUrl = `/api/papers/${slug}/raw?path=${encodeURIComponent(filePath)}`
    if (type === 'image' || type === 'pdf') return { path: filePath, type, content: null, url: rawUrl }

    const content = readFileNoFollow(resolved.path, LIMITS.publicTextBytes).toString('utf8')
    if (type === 'notebook') {
      return {
        path: filePath,
        type,
        content: null,
        language: 'plaintext',
        notebook: createNotebookView(content, { slug, sourcePath: filePath })
      }
    }
    if (type === 'markdown') {
      return { path: filePath, type, content, renderedHtml: renderSafeMarkdown(content, { slug, sourcePath: filePath }) }
    }
    if (type === 'html') {
      return { path: filePath, type, content, previewHtml: createStaticHtmlPreview(content), language: 'html' }
    }
    if (type === 'svg') {
      return { path: filePath, type, content, language: 'xml', downloadUrl: rawUrl }
    }
    return { path: filePath, type, content, language: type === 'code' ? getLanguageFromExtension(filePath) : undefined }
  } catch (error: any) {
    if (error?.statusCode) throw error
    if (path.extname(filePath).toLowerCase() === '.ipynb') {
      throw createError({ statusCode: 422, statusMessage: 'Notebook is malformed' })
    }
    throw createError({ statusCode: 500, statusMessage: 'Failed to load file' })
  }
})
