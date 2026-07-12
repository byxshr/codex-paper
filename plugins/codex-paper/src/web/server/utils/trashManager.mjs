import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  boundaryError,
  ensureLibraryLayout,
  getLibraryPaths,
  LIMITS,
  readFileNoFollow,
  readJsonPath,
  readLibraryIndex,
  requirePaperDir,
  validateSlug,
  validateTrashId,
  writeJsonAtomic,
  writeFileAtomic,
  writeLibraryIndex,
} from './librarySecurity.mjs'

const TOMBSTONE = '.codex-paper-trash.json'

function deriveIndexEntry(slug, paperDir) {
  const metaPath = path.join(paperDir, 'meta.json')
  let meta = {}
  if (fs.existsSync(metaPath) && !fs.lstatSync(metaPath).isSymbolicLink()) {
    try { meta = readJsonPath(metaPath, 'meta.json') } catch {}
  }
  return { ...meta, slug, title: meta.title || slug, tags: Array.isArray(meta.tags) ? meta.tags : [] }
}

function createTrashId(slug, now) {
  return `trash-${now}-${randomBytes(8).toString('hex')}-${slug}`
}

export function movePaperToTrash(slug, options = {}) {
  if (!validateSlug(slug)) throw boundaryError(400, 'Valid paper slug is required')
  const now = options.now || Date.now()
  const paths = ensureLibraryLayout(options)
  const paperDir = requirePaperDir(slug, options)
  const indexState = readLibraryIndex(options)
  const indexEntry = indexState.papers.find((paper) => paper?.slug === slug) || deriveIndexEntry(slug, paperDir)
  const nextPapers = indexState.papers.filter((paper) => paper?.slug !== slug)
  const trashId = createTrashId(slug, now)
  const trashDir = path.join(paths.trashRoot, trashId)
  const tombstone = {
    schemaVersion: '1.0.0',
    trashId,
    slug,
    deletedAt: new Date(now).toISOString(),
    originalRelativePath: `papers/${slug}`,
    indexEntry,
  }

  fs.renameSync(paperDir, trashDir)
  try {
    writeJsonAtomic(path.join(trashDir, TOMBSTONE), tombstone)
    writeLibraryIndex(indexState, nextPapers, options)
  } catch (error) {
    try { fs.unlinkSync(path.join(trashDir, TOMBSTONE)) } catch {}
    try { fs.renameSync(trashDir, paperDir) } catch {}
    throw error
  }
  return { success: true, slug, trashId, recoverable: true }
}

function requireTrashEntry(trashId, options = {}) {
  if (!validateTrashId(trashId)) throw boundaryError(400, 'Valid trash id is required')
  const paths = getLibraryPaths(options.libraryRoot)
  if (!fs.existsSync(paths.trashRoot)) throw boundaryError(404, 'Trash entry not found')
  if (fs.lstatSync(paths.trashRoot).isSymbolicLink()) throw boundaryError(403, 'Trash root symlinks are not allowed')
  const trashDir = path.join(paths.trashRoot, trashId)
  let stats
  try { stats = fs.lstatSync(trashDir) } catch { throw boundaryError(404, 'Trash entry not found') }
  if (stats.isSymbolicLink()) throw boundaryError(403, 'Trash entry symlinks are not allowed')
  if (!stats.isDirectory()) throw boundaryError(404, 'Trash entry not found')
  const canonicalTrashRoot = fs.realpathSync(paths.trashRoot)
  const canonicalTrashDir = fs.realpathSync(trashDir)
  const relative = path.relative(canonicalTrashRoot, canonicalTrashDir)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw boundaryError(403, 'Trash entry is outside the library')
  const tombstonePath = path.join(trashDir, TOMBSTONE)
  if (!fs.existsSync(tombstonePath) || fs.lstatSync(tombstonePath).isSymbolicLink()) throw boundaryError(422, 'Trash tombstone is invalid')
  const tombstone = readJsonPath(tombstonePath, 'trash tombstone')
  if (tombstone.schemaVersion !== '1.0.0' || tombstone.trashId !== trashId || !validateSlug(tombstone.slug)) {
    throw boundaryError(422, 'Trash tombstone is invalid')
  }
  return { trashDir, tombstonePath, tombstone }
}

export function listTrash(options = {}) {
  const paths = getLibraryPaths(options.libraryRoot)
  if (!fs.existsSync(paths.trashRoot)) return []
  if (fs.lstatSync(paths.trashRoot).isSymbolicLink()) throw boundaryError(403, 'Trash root symlinks are not allowed')
  const items = []
  for (const item of fs.readdirSync(paths.trashRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink() || !validateTrashId(item.name)) continue
    try {
      const { tombstone } = requireTrashEntry(item.name, options)
      items.push({ trashId: tombstone.trashId, slug: tombstone.slug, title: tombstone.indexEntry?.title || tombstone.slug, deletedAt: tombstone.deletedAt })
    } catch {}
  }
  return items.sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))
}

export function restoreTrashEntry(trashId, options = {}) {
  const paths = ensureLibraryLayout(options)
  const { trashDir, tombstonePath, tombstone } = requireTrashEntry(trashId, options)
  const target = path.join(paths.papersRoot, tombstone.slug)
  try {
    fs.lstatSync(target)
    throw boundaryError(409, 'A paper with this slug already exists')
  } catch (error) {
    if (error?.statusCode) throw error
    if (error?.code !== 'ENOENT') throw boundaryError(409, 'The restore target is unavailable')
  }
  const indexState = readLibraryIndex(options)
  if (indexState.papers.some((paper) => paper?.slug === tombstone.slug)) throw boundaryError(409, 'The library index already contains this slug')
  const nextPapers = [...indexState.papers, tombstone.indexEntry || { slug: tombstone.slug, title: tombstone.slug }]
  const originalTombstone = readFileNoFollow(tombstonePath, LIMITS.internalJsonBytes)

  fs.renameSync(trashDir, target)
  try {
    fs.unlinkSync(path.join(target, TOMBSTONE))
    writeLibraryIndex(indexState, nextPapers, options)
  } catch (error) {
    const restoredTombstone = path.join(target, TOMBSTONE)
    try {
      if (!fs.existsSync(restoredTombstone)) writeFileAtomic(restoredTombstone, originalTombstone)
    } catch {}
    try { fs.renameSync(target, trashDir) } catch {}
    throw error
  }
  return { success: true, slug: tombstone.slug, trashId }
}
