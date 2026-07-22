import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'codex_paper_session'
export const CSRF_HEADER_NAME = 'x-codex-paper-csrf'
export const CONFIRMATION_HEADER_NAME = 'x-codex-paper-confirmation'

const MAX_SESSIONS = 8
const MAX_CONFIRMATIONS = 256
const MAX_PAIR_FAILURES = 5
const PAIR_WINDOW_MS = 60_000
const CONFIRMATION_TTL_MS = 120_000
const STATE_KEY = Symbol.for('codex-paper.session-security')

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest()
}

function constantTimeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right))
}

function pairingToken() {
  const configured = process.env.CODEX_PAPER_PAIRING_TOKEN
  if (configured && configured.length >= 32) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CODEX_PAPER_PAIRING_TOKEN is required in production')
  }
  const generated = randomBytes(32).toString('hex')
  process.stderr.write(`Codex Paper development pairing token: ${generated}\n`)
  return generated
}

function createState() {
  return {
    pairingToken: pairingToken(),
    sessions: new Map(),
    failures: new Map(),
    confirmations: new Map(),
  }
}

function state() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = createState()
  return globalThis[STATE_KEY]
}

export function initializeSecurity() {
  state()
}

function configuredPort() {
  return String(process.env.PORT || '5815')
}

export function isAllowedHost(host) {
  const normalized = String(host || '').trim().toLowerCase()
  const port = configuredPort()
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  if (port === '80') {
    allowed.add('127.0.0.1')
    allowed.add('localhost')
  }
  return allowed.has(normalized)
}

export function isAllowedOrigin(origin, host) {
  if (!isAllowedHost(host)) return false
  const normalizedHost = String(host).trim().toLowerCase()
  const authority = configuredPort() === '80' ? normalizedHost.replace(/:80$/, '') : normalizedHost
  return String(origin || '').trim().toLowerCase() === `http://${authority}`
}

function failureBucket(clientKey, now) {
  const securityState = state()
  const existing = securityState.failures.get(clientKey)
  if (!existing || now - existing.startedAt >= PAIR_WINDOW_MS) {
    const created = { startedAt: now, count: 0 }
    securityState.failures.set(clientKey, created)
    return created
  }
  return existing
}

export function pairSession(candidate, clientKey = 'loopback', now = Date.now()) {
  const securityState = state()
  const bucket = failureBucket(clientKey, now)
  if (bucket.count >= MAX_PAIR_FAILURES) {
    return { ok: false, statusCode: 409, statusMessage: 'Pairing is temporarily unavailable' }
  }

  if (typeof candidate !== 'string' || candidate.length > 256 || !constantTimeEqual(candidate, securityState.pairingToken)) {
    bucket.count += 1
    return { ok: false, statusCode: 401, statusMessage: 'Invalid pairing token' }
  }

  securityState.failures.delete(clientKey)
  const sessionId = randomBytes(32).toString('hex')
  const csrfToken = randomBytes(32).toString('hex')
  securityState.sessions.set(sessionId, { csrfToken, createdAt: now })
  while (securityState.sessions.size > MAX_SESSIONS) {
    securityState.sessions.delete(securityState.sessions.keys().next().value)
  }
  return { ok: true, sessionId, csrfToken }
}

export function getViewerSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 32) return null
  return state().sessions.get(sessionId) || null
}

export function validateCsrf(sessionId, candidate) {
  const session = getViewerSession(sessionId)
  return Boolean(session && typeof candidate === 'string' && constantTimeEqual(candidate, session.csrfToken))
}

function purgeConfirmations(now) {
  const confirmations = state().confirmations
  for (const [token, item] of confirmations) {
    if (item.expiresAt <= now) confirmations.delete(token)
  }
}

export function createDeleteConfirmation(sessionId, slug, now = Date.now()) {
  if (!getViewerSession(sessionId)) throw new Error('Valid session is required')
  purgeConfirmations(now)
  const token = randomBytes(32).toString('hex')
  const expiresAt = now + CONFIRMATION_TTL_MS
  state().confirmations.set(token, { sessionId, slug, expiresAt })
  while (state().confirmations.size > MAX_CONFIRMATIONS) {
    state().confirmations.delete(state().confirmations.keys().next().value)
  }
  return { token, expiresAt }
}

export function validateDeleteConfirmation(token, sessionId, slug, now = Date.now()) {
  purgeConfirmations(now)
  const item = state().confirmations.get(token)
  return Boolean(item && item.sessionId === sessionId && item.slug === slug && item.expiresAt > now)
}

export function consumeDeleteConfirmation(token, sessionId, slug, now = Date.now()) {
  purgeConfirmations(now)
  const confirmations = state().confirmations
  const item = confirmations.get(token)
  if (!item) return false
  confirmations.delete(token)
  return item.sessionId === sessionId && item.slug === slug && item.expiresAt > now
}

export function resetSecurityStateForTests(pairing = 'a'.repeat(64)) {
  globalThis[STATE_KEY] = {
    pairingToken: pairing,
    sessions: new Map(),
    failures: new Map(),
    confirmations: new Map(),
  }
}
