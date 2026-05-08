import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

const HIDDEN_MACHINE_FILES = new Set([
  'analysis.json',
  'facts.json',
  'meta.json',
  'paper-data.json'
])

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  const query = getQuery(event)
  const filePath = query.path as string

  if (!slug || !filePath) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Slug and path are required'
    })
  }

  try {
    const paperDir = path.join(homedir(), 'codex-papers/papers', slug)
    const fullPath = path.resolve(paperDir, filePath)
    const relativeFullPath = path.relative(paperDir, fullPath)

    // Security check
    if (relativeFullPath.startsWith('..') || path.isAbsolute(relativeFullPath)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Access denied'
      })
    }

    if (!relativeFullPath.includes(path.sep) && HIDDEN_MACHINE_FILES.has(path.basename(relativeFullPath))) {
      throw createError({
        statusCode: 404,
        statusMessage: 'File not found'
      })
    }

    if (!fs.existsSync(fullPath)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'File not found'
      })
    }

    // Get file extension to set content type
    const ext = path.extname(fullPath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream'

    // Read file as buffer
    const fileBuffer = fs.readFileSync(fullPath)

    // Set headers
    setHeader(event, 'Content-Type', contentType)
    setHeader(event, 'Content-Length', fileBuffer.length.toString())

    return fileBuffer
  } catch (e: any) {
    if (e.statusCode) throw e

    throw createError({
      statusCode: 500,
      statusMessage: e.message || 'Failed to load file'
    })
  }
})
