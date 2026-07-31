import { SESSION_COOKIE_NAME, pairSession } from '../../utils/sessionSecurity.mjs'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ token?: unknown }>(event)
  const clientKey = event.node.req.socket.remoteAddress || 'loopback'
  const result = pairSession(body?.token, clientKey)
  if (!result.ok) {
    throw createError({ statusCode: result.statusCode, statusMessage: result.statusMessage })
  }

  setCookie(event, SESSION_COOKIE_NAME, result.sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  })
  setHeader(event, 'Cache-Control', 'no-store')
  return { authenticated: true, csrfToken: result.csrfToken }
})
