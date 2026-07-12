import { LIMITS, readFileNoFollow, resolvePublicFile, validateSlug } from '../../utils/librarySecurity.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const readme = resolvePublicFile(slug!, 'README.md')
  return { slug, markdown: readFileNoFollow(readme.path, LIMITS.publicTextBytes).toString('utf8') }
})
