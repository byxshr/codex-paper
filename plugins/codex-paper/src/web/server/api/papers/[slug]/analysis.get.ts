import { readJsonPath, resolveInternalFile, validateSlug } from '../../../utils/librarySecurity.mjs'
import { classifyStoredPackageCompatibility } from '../../../utils/storedPackageCompatibility.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const analysis = readJsonPath(resolveInternalFile(slug!, 'analysis.json').path, 'analysis.json')
  return { ...analysis, compatibility: classifyStoredPackageCompatibility(slug!) }
})
