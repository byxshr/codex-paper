import fs from 'node:fs'
import {
  readJsonPath,
  readLibraryIndex,
  requirePaperDir,
  resolveWritablePaperFile,
  validateSlug,
  writeJsonAtomic,
  writeLibraryIndex,
} from '../../../utils/librarySecurity.mjs'
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

  return withOperationLocks([`paper:${slug}`, 'index'], async () => {
    requirePaperDir(slug!)
    const metaPath = resolveWritablePaperFile(slug!, 'meta.json')
    const hadMeta = fs.existsSync(metaPath)
    const previousMeta = hadMeta ? readJsonPath(metaPath, 'meta.json') : {}
    const indexState = readLibraryIndex()
    const nextPapers = indexState.papers.map((paper) => paper?.slug === slug ? { ...paper, tags } : paper)

    writeJsonAtomic(metaPath, { ...previousMeta, tags })
    try {
      writeLibraryIndex(indexState, nextPapers)
    } catch (error) {
      if (hadMeta) writeJsonAtomic(metaPath, previousMeta)
      else try { fs.unlinkSync(metaPath) } catch {}
      throw error
    }
    return { success: true, tags }
  })
})
