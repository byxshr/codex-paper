import { LIMITS, readFileNoFollow, resolvePublicFile, validateSlug } from '../../utils/librarySecurity.mjs'
import { renderSafeMarkdown } from '../../utils/activeContentSecurity.mjs'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  const readme = resolvePublicFile(slug!, 'README.md')
  const markdown = readFileNoFollow(readme.path, LIMITS.publicTextBytes).toString('utf8')
  return { slug, markdown, renderedHtml: renderSafeMarkdown(markdown, { slug, sourcePath: 'README.md' }) }
})
