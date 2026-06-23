import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

const PAPERS_ROOT = path.join(homedir(), 'codex-papers/papers')

export function validateSlug(slug: string | undefined) {
  return Boolean(slug && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug))
}

export function validateEvidenceId(evidenceId: string | undefined) {
  return Boolean(evidenceId && /^(?:ev-p\d{3,}-[a-z]+-[a-f0-9]{10}|ext-[a-z0-9][a-z0-9-]*-[a-f0-9]{10})$/.test(evidenceId))
}

export function resolvePaperDir(slug: string) {
  const paperDir = path.resolve(PAPERS_ROOT, slug)
  const relativePath = path.relative(PAPERS_ROOT, paperDir)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Access denied'
    })
  }

  return paperDir
}

export function requirePaperDir(slug: string) {
  const paperDir = resolvePaperDir(slug)
  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Paper directory not found'
    })
  }
  return paperDir
}

export function readJsonFile(filePath: string, label: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    throw createError({
      statusCode: 422,
      statusMessage: `${label} is not valid JSON`
    })
  }
}

export function readOptionalJson(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    return null
  }
  return readJsonFile(filePath, label)
}

export function truncateText(value: unknown, maxLength = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 3)}...`
}
