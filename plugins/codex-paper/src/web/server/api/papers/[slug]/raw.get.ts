import path from 'node:path'
import { LIMITS, readFileNoFollow, resolvePublicFile, validateSlug } from '../../../utils/librarySecurity.mjs'

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = getQuery(event).path
  if (!validateSlug(slug) || typeof filePath !== 'string') throw createError({ statusCode: 400, statusMessage: 'Valid slug and path are required' })
  const resolved = resolvePublicFile(slug!, filePath)
  const buffer = readFileNoFollow(resolved.path, LIMITS.rawBytes)
  const extension = path.extname(resolved.path).toLowerCase()
  setHeader(event, 'Content-Type', MIME_TYPES[extension] || 'application/octet-stream')
  setHeader(event, 'Content-Length', String(buffer.length))
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Content-Security-Policy', "default-src 'none'; sandbox")
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  if (extension === '.svg') {
    const filename = path.basename(resolved.path).replace(/["\\\r\n]/g, '_')
    setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  } else if (extension === '.pdf') {
    setHeader(event, 'Content-Disposition', 'inline')
  } else if (!MIME_TYPES[extension]) {
    const filename = path.basename(resolved.path).replace(/["\\\r\n]/g, '_')
    setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  }
  return buffer
})
