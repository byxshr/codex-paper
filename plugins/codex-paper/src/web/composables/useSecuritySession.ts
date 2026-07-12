interface SessionResponse {
  authenticated: boolean
  csrfToken: string
}

export const useSecuritySession = () => {
  const authenticated = useState('security-authenticated', () => false)
  const csrfToken = useState<string | null>('security-csrf-token', () => null)
  const checking = useState('security-checking', () => true)

  const mutationHeaders = () => {
    if (!csrfToken.value) {
      throw new Error('The Viewer session is not paired.')
    }
    return { 'X-Codex-Paper-CSRF': csrfToken.value }
  }

  const loadSession = async () => {
    checking.value = true
    try {
      const response = await $fetch<SessionResponse>('/api/session')
      authenticated.value = response.authenticated
      csrfToken.value = response.csrfToken
      return true
    } catch {
      authenticated.value = false
      csrfToken.value = null
      return false
    } finally {
      checking.value = false
    }
  }

  const pair = async (token: string) => {
    const response = await $fetch<SessionResponse>('/api/session/pair', {
      method: 'POST',
      body: { token }
    })
    authenticated.value = response.authenticated
    csrfToken.value = response.csrfToken
  }

  return { authenticated, csrfToken, checking, loadSession, pair, mutationHeaders }
}
