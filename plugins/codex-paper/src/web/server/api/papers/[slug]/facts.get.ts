import { readJsonPath, readOptionalInternalJson, resolveInternalFile, validateSlug } from '../../../utils/librarySecurity.mjs'
import { classifyStoredPackageCompatibility } from '../../../utils/storedPackageCompatibility.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const facts = readJsonPath(resolveInternalFile(slug!, 'facts.json').path, 'facts.json')
  const paperData = readOptionalInternalJson(slug!, 'paper-data.json', 'paper-data.json') || {}
  return {
    ...facts,
    compatibility: classifyStoredPackageCompatibility(slug!),
    warnings: Array.isArray(paperData.warnings) ? paperData.warnings : [],
    qualityFlags: Array.isArray(paperData.qualityFlags) ? paperData.qualityFlags : [],
  }
})
