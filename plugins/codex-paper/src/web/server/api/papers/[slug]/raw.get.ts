import path from 'node:path'
import { LIMITS, readFileNoFollow, resolvePublicFile, validateSlug } from '../../../utils/librarySecurity.mjs'

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = getQuery(event).path
  if (!validateSlug(slug) || typeof filePath !== 'string') throw createError({ statusCode: 400, statusMessage: 'Valid slug and path are required' })
  const resolved = resolvePublicFile(slug!, filePath)
  const buffer = readFileNoFollow(resolved.path, LIMITS.rawBytes)
  setHeader(event, 'Content-Type', MIME_TYPES[path.extname(resolved.path).toLowerCase()] || 'application/octet-stream')
  setHeader(event, 'Content-Length', String(buffer.length))
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return buffer
})
