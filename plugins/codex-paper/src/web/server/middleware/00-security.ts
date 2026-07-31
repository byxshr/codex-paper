import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  getViewerSession,
  isAllowedHost,
  isAllowedOrigin,
  validateCsrf,
} from '../utils/sessionSecurity.mjs'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export default defineEventHandler((event) => {
  const pathname = getRequestURL(event).pathname
  if (!pathname.startsWith('/api/')) return
  if (import.meta.prerender) return

  const host = getHeader(event, 'host') || ''
  if (!isAllowedHost(host)) {
    throw createError({ statusCode: 403, statusMessage: 'Host is not allowed' })
  }

  if (pathname === '/api/health') return

  const method = event.method.toUpperCase()
  const origin = getHeader(event, 'origin') || ''
  if (pathname === '/api/session/pair') {
    if (method !== 'POST' || !isAllowedOrigin(origin, host)) {
      throw createError({ statusCode: 403, statusMessage: 'Pairing requires a same-origin request' })
    }
    return
  }

  const sessionId = getCookie(event, SESSION_COOKIE_NAME) || ''
  const session = getViewerSession(sessionId)
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Pairing is required' })
  }
  event.context.codexPaperSession = { id: sessionId, csrfToken: session.csrfToken }

  if (MUTATING_METHODS.has(method)) {
    if (!isAllowedOrigin(origin, host)) {
      throw createError({ statusCode: 403, statusMessage: 'Mutation requires a same-origin request' })
    }
    const csrfToken = getHeader(event, CSRF_HEADER_NAME) || ''
    if (!validateCsrf(sessionId, csrfToken)) {
      throw createError({ statusCode: 403, statusMessage: 'CSRF token is invalid' })
    }
  }
})
