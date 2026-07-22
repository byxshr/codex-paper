import { CONFIRMATION_HEADER_NAME, consumeDeleteConfirmation, validateDeleteConfirmation } from '../../../utils/sessionSecurity.mjs'
import { requirePaperAccess, validateSlug } from '../../../utils/librarySecurity.mjs'
import { withOperationLocks } from '../../../utils/operationLocks.mjs'
import { movePaperToTrash } from '../../../utils/trashManager.mjs'
import { hasActivePaperAsk } from '../../../utils/askLeases.mjs'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const confirmation = getHeader(event, CONFIRMATION_HEADER_NAME) || ''
  const sessionId = event.context.codexPaperSession.id
  if (!validateDeleteConfirmation(confirmation, sessionId, slug!)) {
    throw createError({ statusCode: 409, statusMessage: 'Delete confirmation is invalid or expired' })
  }
  const descriptor = requirePaperAccess(slug!)
  if (hasActivePaperAsk(descriptor.paperLockKey)) throw createError({ statusCode: 409, statusMessage: 'Paper has an active Ask request; retry deletion after it finishes' })
  return withOperationLocks([descriptor.paperLockKey, 'index'], () => {
    if (hasActivePaperAsk(descriptor.paperLockKey)) throw createError({ statusCode: 409, statusMessage: 'Paper has an active Ask request; retry deletion after it finishes' })
    if (!consumeDeleteConfirmation(confirmation, sessionId, slug!)) {
      throw createError({ statusCode: 409, statusMessage: 'Delete confirmation is invalid or expired' })
    }
    return movePaperToTrash(slug!)
  })
})
