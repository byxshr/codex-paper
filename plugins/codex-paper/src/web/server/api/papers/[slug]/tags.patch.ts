import {
  readLibraryIndex,
  requireWritablePaperAccess,
  validateSlug,
  writePaperOverlayState,
  writeLibraryIndex,
} from '../../../utils/librarySecurity.mjs'
import { readOverlayState } from '../../../../../shared/paper-library.mjs'
import { withOperationLocks } from '../../../utils/operationLocks.mjs'

function normalizeTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 32 || value.some((tag) => typeof tag !== 'string')) {
    throw createError({ statusCode: 400, statusMessage: 'Tags must be an array of at most 32 strings' })
  }
  const tags = [...new Set(value.map((tag) => tag.trim()).filter(Boolean))]
  if (tags.some((tag) => tag.length > 64 || /[\u0000-\u001f\u007f]/.test(tag))) {
    throw createError({ statusCode: 400, statusMessage: 'Each tag must be at most 64 characters without control characters' })
  }
  return tags
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const body = await readBody<{ tags?: unknown }>(event)
  const tags = normalizeTags(body?.tags)

  const descriptor = requireWritablePaperAccess(slug!)
  return withOperationLocks([descriptor.paperLockKey, 'index'], async () => {
    const previousState = readOverlayState(descriptor)
    const indexState = readLibraryIndex()
    const nextPapers = indexState.papers.map((paper) => paper?.storageKey === descriptor.paperKey || descriptor.routeAliases.includes(paper?.slug) ? { ...paper, tags } : paper)

    writePaperOverlayState(descriptor, { ...previousState, tags })
    try {
      writeLibraryIndex(indexState, nextPapers)
    } catch (error) {
      writePaperOverlayState(descriptor, previousState)
      throw error
    }
    return { success: true, tags }
  })
})
