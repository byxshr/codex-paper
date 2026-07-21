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
  requirePaperAccess,
  validateSlug,
  validateTrashId,
  writeFileAtomic,
  writeJsonAtomic,
  writeLibraryIndex,
} from './librarySecurity.mjs'
import { readOverlayState } from '../../../shared/paper-library.mjs'

const TOMBSTONE = 'tombstone.json'
const PAYLOAD = 'payload'

function deriveIndexEntry(descriptor) {
  const metaPath = path.join(descriptor.packageDir, 'meta.json')
  let meta = {}
  if (fs.existsSync(metaPath) && !fs.lstatSync(metaPath).isSymbolicLink()) {
    try { meta = readJsonPath(metaPath, 'meta.json') } catch {}
  }
  const tags = descriptor.mode === 'managed_v1' ? readOverlayState(descriptor).tags : (Array.isArray(meta.tags) ? meta.tags : [])
  return {
    ...meta,
    slug: descriptor.routeSlug,
    title: meta.title || descriptor.routeSlug,
    tags,
    ...(descriptor.mode === 'managed_v1' ? {
      storageKey: descriptor.paperKey,
      paperId: descriptor.paperId,
      paperIdAliases: descriptor.paperIdAliases
    } : {})
  }
}

function createTrashId(slug, now) {
  return `trash-${now}-${randomBytes(8).toString('hex')}-${slug}`
}

export function movePaperToTrash(slug, options = {}) {
  if (!validateSlug(slug)) throw boundaryError(400, 'Valid paper slug is required')
  const now = options.now || Date.now()
  const paths = ensureLibraryLayout(options)
  const descriptor = requirePaperAccess(slug, options)
  const indexState = readLibraryIndex(options)
  const removedEntries = indexState.papers.filter((paper) => descriptor.mode === 'managed_v1'
    ? paper?.storageKey === descriptor.paperKey || descriptor.routeAliases.includes(paper?.slug)
    : paper?.slug === slug)
  const indexEntries = removedEntries.length > 0 ? removedEntries : [deriveIndexEntry(descriptor)]
  const nextPapers = indexState.papers.filter((paper) => !indexEntries.includes(paper))
  const trashId = createTrashId(slug, now)
  const trashDir = path.join(paths.trashRoot, trashId)
  const payloadDir = path.join(trashDir, PAYLOAD)
  const canonicalLibraryRoot = fs.realpathSync(paths.libraryRoot)
  const originalRelativePath = path.relative(canonicalLibraryRoot, descriptor.paperRoot).split(path.sep).join('/')
  if (!originalRelativePath || originalRelativePath.startsWith('../')) throw boundaryError(403, 'Paper storage path is outside the library')
  const tombstone = {
    schemaVersion: '2.0.0',
    trashId,
    slug,
    layout: descriptor.mode,
    paperKey: descriptor.paperKey,
    paperLockKey: descriptor.paperLockKey,
    deletedAt: new Date(now).toISOString(),
    originalRelativePath,
    indexEntries,
  }

  fs.mkdirSync(trashDir, { mode: 0o700 })
  try {
    writeJsonAtomic(path.join(trashDir, TOMBSTONE), tombstone)
    fs.renameSync(descriptor.paperRoot, payloadDir)
    writeLibraryIndex(indexState, nextPapers, options)
  } catch (error) {
    try { if (fs.existsSync(payloadDir)) fs.renameSync(payloadDir, descriptor.paperRoot) } catch {}
    try { fs.unlinkSync(path.join(trashDir, TOMBSTONE)) } catch {}
    try { fs.rmdirSync(trashDir) } catch {}
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
  const tombstonePath = path.join(trashDir, TOMBSTONE)
  const payloadDir = path.join(trashDir, PAYLOAD)
  if (!fs.existsSync(tombstonePath) || fs.lstatSync(tombstonePath).isSymbolicLink()) throw boundaryError(422, 'Trash tombstone is invalid')
  if (!fs.existsSync(payloadDir) || fs.lstatSync(payloadDir).isSymbolicLink() || !fs.lstatSync(payloadDir).isDirectory()) throw boundaryError(422, 'Trash payload is invalid')
  const tombstone = readJsonPath(tombstonePath, 'trash tombstone')
  if (tombstone.schemaVersion !== '2.0.0' || tombstone.trashId !== trashId || !validateSlug(tombstone.slug)
    || !['managed_v1', 'legacy_flat'].includes(tombstone.layout) || !Array.isArray(tombstone.indexEntries)
    || typeof tombstone.originalRelativePath !== 'string' || tombstone.originalRelativePath.includes('..')) {
    throw boundaryError(422, 'Trash tombstone is invalid')
  }
  return { trashDir, tombstonePath, payloadDir, tombstone }
}

export function getTrashLockKey(trashId, options = {}) {
  return requireTrashEntry(trashId, options).tombstone.paperLockKey || `trash:${trashId}`
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
      items.push({ trashId: tombstone.trashId, slug: tombstone.slug, title: tombstone.indexEntries[0]?.title || tombstone.slug, deletedAt: tombstone.deletedAt })
    } catch {}
  }
  return items.sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))
}

export function restoreTrashEntry(trashId, options = {}) {
  const paths = ensureLibraryLayout(options)
  const { trashDir, tombstonePath, payloadDir, tombstone } = requireTrashEntry(trashId, options)
  const target = path.resolve(paths.libraryRoot, ...tombstone.originalRelativePath.split('/'))
  const relative = path.relative(paths.libraryRoot, target)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw boundaryError(403, 'Restore target is outside the library')
  try {
    fs.lstatSync(target)
    throw boundaryError(409, 'The restore target already exists')
  } catch (error) {
    if (error?.statusCode) throw error
    if (error?.code !== 'ENOENT') throw boundaryError(409, 'The restore target is unavailable')
  }
  const indexState = readLibraryIndex(options)
  const aliases = new Set(tombstone.indexEntries.map((entry) => entry?.slug).filter(Boolean))
  if (indexState.papers.some((paper) => aliases.has(paper?.slug) || (tombstone.paperKey && paper?.storageKey === tombstone.paperKey))) {
    throw boundaryError(409, 'The library index already contains this paper')
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const nextPapers = [...indexState.papers, ...tombstone.indexEntries]
  const originalTombstone = readFileNoFollow(tombstonePath, LIMITS.internalJsonBytes)

  fs.renameSync(payloadDir, target)
  try {
    writeLibraryIndex(indexState, nextPapers, options)
  } catch (error) {
    try { fs.renameSync(target, payloadDir) } catch {}
    if (!fs.existsSync(tombstonePath)) writeFileAtomic(tombstonePath, originalTombstone)
    throw error
  }
  try { fs.unlinkSync(tombstonePath) } catch {}
  try { fs.rmdirSync(trashDir) } catch {}
  return { success: true, slug: tombstone.slug, trashId }
}
