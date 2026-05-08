import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Slug is required'
    })
  }

  try {
    const paperDir = path.join(homedir(), 'codex-papers/papers', slug)
    const analysisPath = path.join(paperDir, 'analysis.json')

    if (!fs.existsSync(analysisPath)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Analysis not found'
      })
    }

    return JSON.parse(fs.readFileSync(analysisPath, 'utf-8'))
  } catch (e: any) {
    if (e.statusCode) throw e

    throw createError({
      statusCode: 500,
      statusMessage: e.message || 'Failed to load paper analysis'
    })
  }
})
