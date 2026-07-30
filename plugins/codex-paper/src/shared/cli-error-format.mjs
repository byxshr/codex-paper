const SECRET_KEY = /(?:secret|token|password|credential|authorization|cookie)/i
const ABSOLUTE_PATH = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/
const HTTP_URL = /https?:\/\/[^\s'"]+/gi

function sanitizeHttpUrl(candidate) {
  try {
    const url = new URL(candidate)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[redacted-url]'
  }
}

function redactPathText(value) {
  return value
    .replace(/(['"])(?:\/|~\/|[A-Za-z]:[\\/])[^'"]*\1/g, '$1[redacted-path]$1')
    .replace(/\/+(?:[^/\s'",;)\]}<>]+\/)+[^/\s'",;)\]}<>]+/g, '[redacted-path]')
    .replace(/~\/[^\s'",;)\]}<>]+(?:\/[^\s'",;)\]}<>]+)*/g, '[redacted-path]')
    .replace(/[A-Za-z]:[\\/][^\s'",;)\]}<>]+(?:[\\/][^\s'",;)\]}<>]+)*/g, '[redacted-path]')
}

function sanitizeText(value, maxLength = 512) {
  const normalized = String(value).replace(/[\r\n]+/g, ' ')
  const chunks = []
  let cursor = 0
  for (const match of normalized.matchAll(HTTP_URL)) {
    chunks.push(redactPathText(normalized.slice(cursor, match.index)))
    chunks.push(sanitizeHttpUrl(match[0]))
    cursor = match.index + match[0].length
  }
  chunks.push(redactPathText(normalized.slice(cursor)))
  return chunks.join('').slice(0, maxLength)
}

function safeDetail(value, key = '', depth = 0) {
  if (depth > 6) return '[truncated]'
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeDetail(item, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([childKey, child]) => [childKey, safeDetail(child, childKey, depth + 1)]),
    )
  }
  if (typeof value !== 'string') return value
  const normalized = sanitizeText(value)
  if (ABSOLUTE_PATH.test(normalized)) return '[redacted-path]'
  return normalized
}

export function formatCliError(error, fallbackCode, maxMessage = 2048, maxDetails = 4096) {
  const code = String(error?.code || fallbackCode)
  const message = sanitizeText(error?.message || error, maxMessage)
  if (error?.details === undefined || error?.details === null) return `Error [${code}]: ${message}`
  let details
  try {
    details = JSON.stringify(safeDetail(error.details))
  } catch {
    details = '"[unavailable]"'
  }
  if (details === '{}' || details === '[]') return `Error [${code}]: ${message}`
  if (details.length > maxDetails) {
    const marker = JSON.stringify({ truncated: true })
    if (maxDetails <= marker.length + 32) details = marker
    else {
      let preview = details.slice(0, Math.max(0, maxDetails - 48))
      let bounded = JSON.stringify({ truncated: true, preview })
      while (bounded.length > maxDetails && preview.length > 0) {
        preview = preview.slice(0, Math.max(0, preview.length - (bounded.length - maxDetails)))
        bounded = JSON.stringify({ truncated: true, preview })
      }
      details = bounded.length <= maxDetails ? bounded : marker
    }
  }
  return `Error [${code}]: ${message}\nDetails: ${details}`
}
