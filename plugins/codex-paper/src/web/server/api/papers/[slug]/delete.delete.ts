import { CONFIRMATION_HEADER_NAME, consumeDeleteConfirmation } from '../../../utils/sessionSecurity.mjs'
import { validateSlug } from '../../../utils/librarySecurity.mjs'
import { withOperationLocks } from '../../../utils/operationLocks.mjs'
import { movePaperToTrash } from '../../../utils/trashManager.mjs'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const confirmation = getHeader(event, CONFIRMATION_HEADER_NAME) || ''
  if (!consumeDeleteConfirmation(confirmation, event.context.codexPaperSession.id, slug!)) {
    throw createError({ statusCode: 409, statusMessage: 'Delete confirmation is invalid or expired' })
  }
  return withOperationLocks([`paper:${slug}`, 'index'], () => movePaperToTrash(slug!))
})
