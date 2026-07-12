import { readJsonPath, resolveInternalFile, validateSlug } from '../../../utils/librarySecurity.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  return readJsonPath(resolveInternalFile(slug!, 'analysis.json').path, 'analysis.json')
})
