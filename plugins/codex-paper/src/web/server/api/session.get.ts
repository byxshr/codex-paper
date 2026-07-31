export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    authenticated: true,
    csrfToken: event.context.codexPaperSession.csrfToken,
  }
})
