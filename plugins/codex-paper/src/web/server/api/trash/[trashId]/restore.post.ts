import { validateTrashId } from '../../../utils/librarySecurity.mjs'
import { getTrashLockKey, restoreTrashEntry } from '../../../utils/trashManager.mjs'
import { withOperationLocks } from '../../../utils/operationLocks.mjs'

export default defineEventHandler(async (event) => {
  const trashId = getRouterParam(event, 'trashId')
  if (!validateTrashId(trashId)) throw createError({ statusCode: 400, statusMessage: 'Valid trash id is required' })
  const paperLockKey = getTrashLockKey(trashId!)
  return withOperationLocks([paperLockKey, `trash:${trashId}`, 'index'], () => restoreTrashEntry(trashId!))
})
