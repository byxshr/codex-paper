import { createDeleteConfirmation } from '../../../../utils/sessionSecurity.mjs'
import { requirePaperAccess, validateSlug } from '../../../../utils/librarySecurity.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  requirePaperAccess(slug!)
  const confirmation = createDeleteConfirmation(event.context.codexPaperSession.id, slug!)
  return {
    confirmationToken: confirmation.token,
    expiresAt: new Date(confirmation.expiresAt).toISOString(),
  }
})
