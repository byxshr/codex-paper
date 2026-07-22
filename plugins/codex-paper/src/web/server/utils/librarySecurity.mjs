import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertWritableDescriptor,
  getLibraryLayout,
  readOverlayState,
  resolveLibraryPaper,
} from '../../../shared/paper-library.mjs'
import { atomicWriteFile as sharedAtomicWriteFile, fileWritePrecondition } from '../../../shared/storage-transaction.mjs'
import { currentOperationLockHandle } from './operationLocks.mjs'

export const LIMITS = Object.freeze({
  publicTextBytes: 16 * 1024 * 1024,
  internalJsonBytes: 64 * 1024 * 1024,
  rawBytes: 128 * 1024 * 1024,
  treeDepth: 12,
  treeNodes: 5000,
})

export const HIDDEN_MACHINE_FILES = new Set([
  '.study-validation.json',
  // Keep the pre-trash-envelope name hidden when browsing older packages.
  '.codex-paper-trash.json',
  'analysis.json',
  'evidence-ledger.json',
  'external-evidence.json',
  'facts.json',
  'meta.json',
  'paper-data.json',
  'reasoning-analysis.json',
])

export function boundaryError(statusCode, statusMessage) {
  const error = new Error(statusMessage)
  error.statusCode = statusCode
  error.statusMessage = statusMessage
  return error
}

export function validateSlug(slug) {
  return typeof slug === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)
}

export function validateEvidenceId(evidenceId) {
  return typeof evidenceId === 'string' && /^(?:ev-p\d{3,}-[a-z]+-[a-f0-9]{10}|ext-[a-z0-9][a-z0-9-]*-[a-f0-9]{10})$/.test(evidenceId)
}

export function validateTrashId(trashId) {
  return typeof trashId === 'string' && /^trash-\d{13}-[a-f0-9]{16}-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trashId)
}

export function truncateText(value, maxLength = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

export function getLibraryPaths(libraryRoot = process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers')) {
  if (!path.isAbsolute(libraryRoot)) throw boundaryError(500, 'Library root must be absolute')
  const managed = getLibraryLayout(libraryRoot)
  return {
    libraryRoot: path.resolve(libraryRoot),
    papersRoot: path.resolve(libraryRoot, 'papers'),
    trashRoot: path.resolve(libraryRoot, '.trash'),
    indexPath: path.resolve(libraryRoot, 'index.json'),
    storeRoot: managed.storeRoot,
    recordsRoot: managed.recordsRoot,
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function requireDirectory(directoryPath, label) {
  let stats
  try {
    stats = fs.lstatSync(directoryPath)
  } catch {
    throw boundaryError(404, `${label} not found`)
  }
  if (!stats.isDirectory() && !stats.isSymbolicLink()) throw boundaryError(404, `${label} not found`)
  const canonical = fs.realpathSync(directoryPath)
  if (!fs.statSync(canonical).isDirectory()) throw boundaryError(404, `${label} not found`)
  return canonical
}

export function requirePapersRoot(options = {}) {
  const papersRoot = getLibraryPaths(options.libraryRoot).papersRoot
  try {
    if (fs.lstatSync(papersRoot).isSymbolicLink()) throw boundaryError(403, 'Paper library symlinks are not allowed')
  } catch (error) {
    if (error?.statusCode) throw error
  }
  return requireDirectory(papersRoot, 'Paper library')
}

export function requirePaperDir(slug, options = {}) {
  return requirePaperAccess(slug, options).packageDir
}

export function requirePaperAccess(slug, options = {}) {
  if (!validateSlug(slug)) throw boundaryError(400, 'Valid paper slug is required')
  try {
    return resolveLibraryPaper(slug, { libraryRoot: options.libraryRoot })
  } catch (error) {
    if (error?.statusCode) throw boundaryError(error.statusCode, error.message)
    throw error
  }
}

export function requireWritablePaperAccess(slug, options = {}) {
  const descriptor = requirePaperAccess(slug, options)
  try { return assertWritableDescriptor(descriptor) } catch (error) {
    throw boundaryError(error?.statusCode || 409, error?.message || 'Paper is read-only')
  }
}

export function normalizeRelativePath(input) {
  if (typeof input !== 'string' || !input || input.length > 2048 || input.includes('\0') || input.includes('\\')) {
    throw boundaryError(400, 'Valid relative path is required')
  }
  let decoded = input
  for (let index = 0; index < 2; index += 1) {
    let next
    try {
      next = decodeURIComponent(decoded)
    } catch {
      throw boundaryError(400, 'Path encoding is invalid')
    }
    if (next === decoded) break
    decoded = next
  }
  if (path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded)) throw boundaryError(403, 'Access denied')
  const segments = decoded.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw boundaryError(403, 'Access denied')
  return segments.join('/')
}

export function isPublicRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  const segments = normalized.split('/')
  return !segments.some((segment) => segment.startsWith('.')) && !HIDDEN_MACHINE_FILES.has(path.posix.basename(normalized))
}

function requireNoSymlinkPath(root, relativePath, expectedType = 'file') {
  const normalized = normalizeRelativePath(relativePath)
  const segments = normalized.split('/')
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let stats
    try {
      stats = fs.lstatSync(current)
    } catch {
      throw boundaryError(404, 'File not found')
    }
    if (stats.isSymbolicLink()) throw boundaryError(403, 'Symlinks are not allowed')
    if (index < segments.length - 1 && !stats.isDirectory()) throw boundaryError(404, 'File not found')
  }
  const canonical = fs.realpathSync(current)
  if (!isContained(root, canonical)) throw boundaryError(403, 'Access denied')
  const finalStats = fs.statSync(canonical)
  if (expectedType === 'file' && !finalStats.isFile()) throw boundaryError(404, 'File not found')
  if (expectedType === 'directory' && !finalStats.isDirectory()) throw boundaryError(404, 'Directory not found')
  return { path: canonical, relativePath: normalized, stats: finalStats }
}

export function resolvePublicFile(slug, relativePath, options = {}) {
  const descriptor = requirePaperAccess(slug, options)
  const paperDir = descriptor.packageDir
  const normalized = normalizeRelativePath(relativePath)
  if (!isPublicRelativePath(normalized)) throw boundaryError(404, 'File not found')
  if (descriptor.mode === 'managed_v1' && normalized === 'chat-notes.md') {
    return { paperDir, descriptor, ...requireNoSymlinkPath(descriptor.overlayDir, normalized, 'file') }
  }
  if (descriptor.mode === 'managed_v1' && normalized.startsWith('user/')) {
    const overlayRelative = `files/${normalized.slice('user/'.length)}`
    const resolved = requireNoSymlinkPath(descriptor.overlayDir, overlayRelative, 'file')
    return { paperDir, descriptor, ...resolved, relativePath: normalized }
  }
  return { paperDir, descriptor, ...requireNoSymlinkPath(paperDir, normalized, 'file') }
}

export function resolveInternalFile(slug, relativePath, options = {}) {
  const descriptor = requirePaperAccess(slug, options)
  const paperDir = descriptor.packageDir
  return { paperDir, descriptor, ...requireNoSymlinkPath(paperDir, relativePath, 'file') }
}

export function readFileNoFollow(filePath, maxBytes) {
  const noFollow = fs.constants.O_NOFOLLOW || 0
  let descriptor
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile()) throw boundaryError(404, 'File not found')
    if (stats.size > maxBytes) throw boundaryError(413, 'File exceeds the allowed size')
    return fs.readFileSync(descriptor)
  } catch (error) {
    if (error?.statusCode) throw error
    if (error?.code === 'ELOOP') throw boundaryError(403, 'Symlinks are not allowed')
    throw boundaryError(404, 'File not found')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function readJsonPath(filePath, label, maxBytes = LIMITS.internalJsonBytes) {
  const raw = readFileNoFollow(filePath, maxBytes).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw boundaryError(422, `${label} is not valid JSON`)
  }
}

export function readOptionalInternalJson(slug, relativePath, label, options = {}) {
  try {
    const resolved = resolveInternalFile(slug, relativePath, options)
    return readJsonPath(resolved.path, label)
  } catch (error) {
    if (error?.statusCode === 404) return null
    throw error
  }
}

export function ensureLibraryLayout(options = {}) {
  const paths = getLibraryPaths(options.libraryRoot)
  fs.mkdirSync(paths.libraryRoot, { recursive: true, mode: 0o700 })
  for (const directoryPath of [paths.papersRoot, paths.trashRoot]) {
    if (fs.existsSync(directoryPath) && fs.lstatSync(directoryPath).isSymbolicLink()) throw boundaryError(403, 'Library symlinks are not allowed for writable roots')
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
  }
  return paths
}

export function readLibraryIndex(options = {}) {
  const { indexPath } = getLibraryPaths(options.libraryRoot)
  if (!fs.existsSync(indexPath)) return { raw: [], papers: [], isArray: true }
  if (fs.lstatSync(indexPath).isSymbolicLink()) throw boundaryError(403, 'Index symlinks are not allowed')
  const raw = readJsonPath(indexPath, 'index.json')
  const isArray = Array.isArray(raw)
  const papers = isArray ? raw : (Array.isArray(raw?.papers) ? raw.papers : null)
  if (!papers) throw boundaryError(422, 'index.json has an unsupported shape')
  return { raw, papers, isArray }
}

export function writeFileAtomic(filePath, content, mode = 0o600, requiredLock) {
  if (!requiredLock) throw boundaryError(409, 'A required storage lock key must be specified')
  const parent = path.dirname(filePath)
  const precondition = fileWritePrecondition(filePath, LIMITS.rawBytes)
  return sharedAtomicWriteFile({ root: parent, relativePath: path.basename(filePath), data: content, mode,
    lockHandle: currentOperationLockHandle(), requiredLock, maxBytes: LIMITS.rawBytes, ...precondition })
}

export function writeJsonAtomic(filePath, value, requiredLock) {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600, requiredLock)
}

export function writeLibraryIndex(indexState, papers, options = {}) {
  const { indexPath } = ensureLibraryLayout(options)
  const next = indexState.isArray ? papers : { ...indexState.raw, papers }
  writeJsonAtomic(indexPath, next, 'index')
}

export function buildPublicFileTree(slug, options = {}) {
  const descriptor = requirePaperAccess(slug, options)
  const paperDir = descriptor.packageDir
  let nodeCount = 0
  function walk(directoryPath, relativeDirectory = '', depth = 0) {
    if (depth > LIMITS.treeDepth) throw boundaryError(413, 'File tree exceeds the allowed depth')
    const nodes = []
    for (const item of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name
      if (!isPublicRelativePath(relativePath) || item.isSymbolicLink() || item.name === 'node_modules') continue
      nodeCount += 1
      if (nodeCount > LIMITS.treeNodes) throw boundaryError(413, 'File tree exceeds the allowed node count')
      if (item.isDirectory()) {
        nodes.push({ name: item.name, path: relativePath, type: 'directory', children: walk(path.join(directoryPath, item.name), relativePath, depth + 1) })
      } else if (item.isFile()) {
        nodes.push({ name: item.name, path: relativePath, type: 'file' })
      }
    }
    return nodes
  }
  const tree = walk(paperDir)
  if (descriptor.mode === 'managed_v1') {
    const chatPath = path.join(descriptor.overlayDir, 'chat-notes.md')
    if (fs.existsSync(chatPath) && !fs.lstatSync(chatPath).isSymbolicLink()) tree.push({ name: 'chat-notes.md', path: 'chat-notes.md', type: 'file' })
    const filesRoot = path.join(descriptor.overlayDir, 'files')
    if (fs.existsSync(filesRoot)) {
      const children = walk(filesRoot, 'user', 1)
      if (children.length > 0) tree.push({ name: 'user', path: 'user', type: 'directory', children })
    }
  }
  return tree
}

export function readPaperTags(slug, options = {}) {
  const descriptor = requirePaperAccess(slug, options)
  if (descriptor.mode === 'managed_v1') return readOverlayState(descriptor).tags
  const meta = readOptionalInternalJson(slug, 'meta.json', 'meta.json', options)
  return Array.isArray(meta?.tags) ? meta.tags : []
}

export function writePaperOverlayState(descriptor, state) {
  try { writeJsonAtomic(path.join(assertWritableDescriptor(descriptor).overlayDir, 'state.json'), state, descriptor.paperLockKey) } catch (error) {
    throw boundaryError(error?.statusCode || 500, error?.message || 'Failed to write paper overlay')
  }
}
