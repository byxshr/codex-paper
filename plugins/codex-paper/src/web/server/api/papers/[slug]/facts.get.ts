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
    const factsPath = path.join(paperDir, 'facts.json')
    const paperDataPath = path.join(paperDir, 'paper-data.json')

    if (!fs.existsSync(factsPath)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Facts not found'
      })
    }

    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'))
    const paperData = fs.existsSync(paperDataPath)
      ? JSON.parse(fs.readFileSync(paperDataPath, 'utf-8'))
      : {}

    return {
      ...facts,
      warnings: Array.isArray(paperData.warnings) ? paperData.warnings : [],
      qualityFlags: Array.isArray(paperData.qualityFlags) ? paperData.qualityFlags : []
    }
  } catch (e: any) {
    if (e.statusCode) throw e

    throw createError({
      statusCode: 500,
      statusMessage: e.message || 'Failed to load paper facts'
    })
  }
})
