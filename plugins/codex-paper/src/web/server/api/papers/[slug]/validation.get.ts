import { validateSlug } from '../../../utils/librarySecurity.mjs'
import { readStoredValidationReport } from '../../../utils/validationReport.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  }
  return readStoredValidationReport(slug!)
})
