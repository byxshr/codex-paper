import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LIBRARY_LAYOUT_VERSION = '1.0.0'
export const STORE_RELATIVE_PATH = '.codex-paper/store-v1'
export const PAPER_RECORD_FILENAME = 'paper.json'
export const CURRENT_RECORD_FILENAME = 'current.json'
export const OVERLAY_STATE_FILENAME = 'state.json'

const ROUTE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const PAPER_KEY_PATTERN = /^p-[a-f0-9]{64}$/
const SOURCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/
const GENERATION_ID_PATTERN = /^gen:sha256:[a-f0-9]{64}$/

export class LibraryLayoutError extends Error {
  constructor(code, message, statusCode = 422, details = {}) {
    super(message)
    this.name = 'LibraryLayoutError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

export function getLibraryLayout(libraryRoot = process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers')) {
  if (!path.isAbsolute(libraryRoot)) throw new LibraryLayoutError('LIBRARY_ROOT_INVALID', 'Library root must be absolute.', 500)
  const root = path.resolve(libraryRoot)
  const storeRoot = path.join(root, STORE_RELATIVE_PATH)
  return {
    libraryRoot: root,
    legacyPapersRoot: path.join(root, 'papers'),
    indexPath: path.join(root, 'index.json'),
    storeRoot,
    recordsRoot: path.join(storeRoot, 'papers'),
    trashRoot: path.join(root, '.trash')
  }
}

export function derivePaperKey(paperId) {
  if (typeof paperId !== 'string' || !paperId) throw new LibraryLayoutError('PAPER_ID_INVALID', 'Paper ID is required.')
  return `p-${crypto.createHash('sha256').update(paperId).digest('hex')}`
}

function canonicalRank(paperId) {
  if (String(paperId).startsWith('doi:')) return 3
  if (String(paperId).startsWith('arxiv:')) return 2
  return 1
}

export function reconcilePaperRecord(record, incomingPaperId, { sourceRevisionId, generationId, at = new Date().toISOString() } = {}) {
  validatePaperRecord(record, record?.paperKey)
  if (typeof incomingPaperId !== 'string' || !incomingPaperId || !SOURCE_ID_PATTERN.test(String(sourceRevisionId || '')) || !GENERATION_ID_PATTERN.test(String(generationId || ''))) {
    throw new LibraryLayoutError('RECONCILIATION_INPUT_INVALID', 'Identity reconciliation input is invalid.', 400)
  }
  if (record.paperIdAliases.includes(incomingPaperId)) return record
  // Equal-rank identities deliberately keep the first successfully pinned primary.
  const primaryPaperId = canonicalRank(incomingPaperId) > canonicalRank(record.primaryPaperId) ? incomingPaperId : record.primaryPaperId
  return {
    ...record,
    primaryPaperId,
    paperIdAliases: [...record.paperIdAliases, incomingPaperId].sort(),
    reconciliations: [...record.reconciliations, {
      at,
      incomingPaperId,
      previousPrimaryPaperId: record.primaryPaperId,
      primaryPaperId,
      sourceRevisionId,
      generationId
    }]
  }
}

export function sourceDirectoryName(sourceRevisionId) {
  if (!SOURCE_ID_PATTERN.test(String(sourceRevisionId || ''))) throw new LibraryLayoutError('SOURCE_REVISION_INVALID', 'Source revision ID is invalid.')
  return sourceRevisionId.replace(':', '-')
}

export function generationDirectoryName(generationId) {
  if (!GENERATION_ID_PATTERN.test(String(generationId || ''))) throw new LibraryLayoutError('GENERATION_ID_INVALID', 'Generation ID is invalid.')
  return generationId.replaceAll(':', '-')
}

export function buildPackageRelativePath(sourceRevisionId, generationId) {
  return `sources/${sourceDirectoryName(sourceRevisionId)}/generations/${generationDirectoryName(generationId)}/package`
}

export function isContained(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function lstat(pathname, missingCode = 'LIBRARY_PATH_MISSING') {
  try { return fs.lstatSync(pathname) } catch (error) {
    if (error?.code === 'ENOENT') throw new LibraryLayoutError(missingCode, 'Library path does not exist.', 404)
    throw error
  }
}

export function requireSafeDirectory(directoryPath, containmentRoot = null, missingCode = 'LIBRARY_PATH_MISSING') {
  const stats = lstat(directoryPath, missingCode)
  if (stats.isSymbolicLink()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', 'Library directory symlinks are not allowed.', 403)
  if (!stats.isDirectory()) throw new LibraryLayoutError(missingCode, 'Library directory does not exist.', 404)
  const canonical = fs.realpathSync(directoryPath)
  if (containmentRoot && !isContained(fs.realpathSync(containmentRoot), canonical)) {
    throw new LibraryLayoutError('LIBRARY_PATH_ESCAPE', 'Library path escapes its authority boundary.', 403)
  }
  return canonical
}

export function requireNoFollowDirectory(root, target, missingCode = 'LIBRARY_PATH_MISSING') {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  if (!isContained(absoluteRoot, absoluteTarget)) throw new LibraryLayoutError('LIBRARY_PATH_ESCAPE', 'Library path escapes its authority boundary.', 403)
  requireSafeDirectory(absoluteRoot, null, missingCode)
  const relative = path.relative(absoluteRoot, absoluteTarget)
  let current = absoluteRoot
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    const stats = lstat(current, missingCode)
    if (stats.isSymbolicLink()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', 'Library directory symlinks are not allowed.', 403)
    if (!stats.isDirectory()) throw new LibraryLayoutError(missingCode, 'Library directory does not exist.', 404)
  }
  const canonicalRoot = fs.realpathSync(absoluteRoot)
  const canonicalTarget = fs.realpathSync(absoluteTarget)
  if (!isContained(canonicalRoot, canonicalTarget)) throw new LibraryLayoutError('LIBRARY_PATH_ESCAPE', 'Library path escapes its authority boundary.', 403)
  return canonicalTarget
}

export function readJsonNoFollow(filePath, label = path.basename(filePath), maxBytes = 64 * 1024 * 1024) {
  let descriptor
  try {
    const stats = lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', `${label} must be a regular file.`, 403)
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', `${label} must be a regular file.`, 403)
    if (opened.size > maxBytes) throw new LibraryLayoutError('LIBRARY_FILE_TOO_LARGE', `${label} exceeds the allowed size.`, 413)
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'))
  } catch (error) {
    if (error instanceof LibraryLayoutError) throw error
    if (error?.code === 'ELOOP') throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', `${label} must not be a symlink.`, 403)
    throw new LibraryLayoutError('LIBRARY_RECORD_INVALID', `${label} is not valid JSON.`)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function sortedUniqueStrings(value, pattern = null) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item || (pattern && !pattern.test(item)))) return null
  const unique = [...new Set(value)]
  return unique.length === value.length ? unique : null
}

export function validatePaperRecord(record, expectedPaperKey = null) {
  const paperIds = sortedUniqueStrings(record?.paperIdAliases)
  const routes = sortedUniqueStrings(record?.routeAliases, ROUTE_PATTERN)
  if (record?.schemaVersion !== LIBRARY_LAYOUT_VERSION
    || !PAPER_KEY_PATTERN.test(String(record?.paperKey || ''))
    || (expectedPaperKey && record.paperKey !== expectedPaperKey)
    || typeof record?.primaryPaperId !== 'string' || !record.primaryPaperId
    || !paperIds || !paperIds.includes(record.primaryPaperId)
    || !routes || routes.length === 0
    || Number.isNaN(Date.parse(record?.createdAt))
    || !Array.isArray(record?.reconciliations) || record.reconciliations.length > 256) {
    throw new LibraryLayoutError('PAPER_RECORD_INVALID', 'Paper record is invalid.')
  }
  return record
}

export function validateCurrentRecord(current, paperRecord) {
  const expectedRelativePath = buildPackageRelativePath(current?.sourceRevisionId, current?.generationId)
  if (current?.schemaVersion !== LIBRARY_LAYOUT_VERSION
    || current?.paperKey !== paperRecord.paperKey
    || !paperRecord.paperIdAliases.includes(current?.paperId)
    || current?.packageRelativePath !== expectedRelativePath) {
    throw new LibraryLayoutError('CURRENT_RECORD_INVALID', 'Current generation record is invalid.')
  }
  return current
}

export function readPaperRecord(recordDir) {
  const paperKey = path.basename(recordDir)
  if (!PAPER_KEY_PATTERN.test(paperKey)) throw new LibraryLayoutError('PAPER_KEY_INVALID', 'Paper storage key is invalid.')
  requireSafeDirectory(recordDir, path.dirname(recordDir))
  return validatePaperRecord(readJsonNoFollow(path.join(recordDir, PAPER_RECORD_FILENAME), PAPER_RECORD_FILENAME), paperKey)
}

export function readCurrentRecord(recordDir, paperRecord = readPaperRecord(recordDir)) {
  return validateCurrentRecord(readJsonNoFollow(path.join(recordDir, CURRENT_RECORD_FILENAME), CURRENT_RECORD_FILENAME), paperRecord)
}

export function listManagedRecords(options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.recordsRoot)) return []
  requireSafeDirectory(layout.storeRoot, layout.libraryRoot)
  requireSafeDirectory(layout.recordsRoot, layout.storeRoot)
  const records = []
  const identityOwners = new Map()
  const routeOwners = new Map()
  for (const entry of fs.readdirSync(layout.recordsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new LibraryLayoutError('LIBRARY_REGISTRY_CONFLICT', 'Paper registry contains a symlink.', 403)
    if (!entry.isDirectory()) throw new LibraryLayoutError('LIBRARY_REGISTRY_CONFLICT', 'Paper registry contains an unexpected entry.')
    const recordDir = path.join(layout.recordsRoot, entry.name)
    const record = readPaperRecord(recordDir)
    for (const paperId of record.paperIdAliases) {
      if (identityOwners.has(paperId)) throw new LibraryLayoutError('LIBRARY_REGISTRY_CONFLICT', 'A paper identity alias has multiple owners.')
      identityOwners.set(paperId, record.paperKey)
    }
    for (const route of record.routeAliases) {
      if (routeOwners.has(route)) throw new LibraryLayoutError('LIBRARY_REGISTRY_CONFLICT', 'A route alias has multiple owners.')
      routeOwners.set(route, record.paperKey)
    }
    records.push({ recordDir, record })
  }
  return records
}

function resolveManagedRecord(input, records) {
  const matches = records.filter(({ record }) => record.paperKey === input || record.paperIdAliases.includes(input) || record.routeAliases.includes(input))
  if (matches.length > 1) throw new LibraryLayoutError('LIBRARY_ALIAS_AMBIGUOUS', 'Paper alias is ambiguous.')
  return matches[0] || null
}

export function descriptorForRecord(recordDir, record, options = {}) {
  const current = options.current || readCurrentRecord(recordDir, record)
  const layout = getLibraryLayout(options.libraryRoot)
  const canonicalRecordDir = requireNoFollowDirectory(layout.recordsRoot, recordDir)
  const packageDir = path.join(canonicalRecordDir, ...current.packageRelativePath.split('/'))
  const canonicalPackage = requireNoFollowDirectory(canonicalRecordDir, packageDir, 'PAPER_GENERATION_NOT_FOUND')
  const identity = readJsonNoFollow(path.join(canonicalPackage, '.codex-paper/paper-identity.json'), 'paper-identity.json')
  if (identity?.paperId !== current.paperId
    || identity?.sourceRevisionId !== current.sourceRevisionId
    || identity?.generationId !== current.generationId
    || !record.paperIdAliases.includes(identity.paperId)
    || !record.routeAliases.includes(identity.slug)) {
    throw new LibraryLayoutError('CURRENT_IDENTITY_MISMATCH', 'Current record does not match the generation identity.')
  }
  const overlayDir = path.join(canonicalRecordDir, 'overlay')
  const canonicalOverlay = fs.existsSync(overlayDir) ? requireNoFollowDirectory(canonicalRecordDir, overlayDir) : overlayDir
  return {
    mode: 'managed_v1',
    readOnly: false,
    libraryRoot: getLibraryLayout(options.libraryRoot).libraryRoot,
    paperRoot: canonicalRecordDir,
    packageDir: canonicalPackage,
    generationDir: canonicalPackage,
    overlayDir: canonicalOverlay,
    routeSlug: record.routeAliases[0],
    paperKey: record.paperKey,
    paperId: record.primaryPaperId,
    paperIdAliases: [...record.paperIdAliases],
    routeAliases: [...record.routeAliases],
    sourceRevisionId: current.sourceRevisionId,
    generationId: current.generationId,
    paperLockKey: `paper:${record.paperKey}`,
    generationLockKey: `generation:${record.paperKey}:${current.generationId}`,
    record,
    current,
    identity
  }
}

function descriptorForLegacy(input, options = {}) {
  if (!ROUTE_PATTERN.test(input)) return null
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.legacyPapersRoot)) return null
  const papersRoot = requireSafeDirectory(layout.legacyPapersRoot, layout.libraryRoot)
  const candidate = path.join(papersRoot, input)
  if (!fs.existsSync(candidate)) return null
  const packageDir = requireSafeDirectory(candidate, papersRoot, 'PAPER_NOT_FOUND')
  let meta = null
  try { meta = readJsonNoFollow(path.join(packageDir, 'meta.json'), 'meta.json') } catch (error) {
    if (error?.statusCode === 403) throw error
  }
  return {
    mode: 'legacy_flat',
    readOnly: true,
    diagnostics: [{ code: 'LEGACY_FLAT_READ_ONLY', message: 'Legacy flat-layout packages require explicit migration before mutation.' }],
    libraryRoot: layout.libraryRoot,
    paperRoot: packageDir,
    packageDir,
    generationDir: packageDir,
    overlayDir: null,
    routeSlug: input,
    paperKey: null,
    paperId: typeof meta?.paperId === 'string' ? meta.paperId : null,
    sourceRevisionId: typeof meta?.sourceRevisionId === 'string' ? meta.sourceRevisionId : null,
    generationId: typeof meta?.generationId === 'string' ? meta.generationId : null,
    paperLockKey: `legacy:${input}`,
    generationLockKey: `legacy:${input}`
  }
}

export function resolveLibraryPaper(input, options = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new LibraryLayoutError('PAPER_REFERENCE_INVALID', 'Paper reference is invalid.', 400)
  const records = listManagedRecords(options)
  const managed = resolveManagedRecord(input, records)
  if (managed) return descriptorForRecord(managed.recordDir, managed.record, options)
  const legacy = descriptorForLegacy(input, options)
  if (legacy) return legacy
  throw new LibraryLayoutError('PAPER_NOT_FOUND', 'Paper not found.', 404)
}

export function resolveExplicitPackage(input, options = {}) {
  if (path.isAbsolute(input) || input.includes(path.sep)) {
    const candidate = path.resolve(input)
    const stats = lstat(candidate, 'PAPER_NOT_FOUND')
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', 'Paper package path is unsafe.', 403)
    const canonical = fs.realpathSync(candidate)
    const layout = getLibraryLayout(options.libraryRoot)
    if (fs.existsSync(layout.legacyPapersRoot)) {
      const legacyRoot = requireSafeDirectory(layout.legacyPapersRoot, layout.libraryRoot)
      if (isContained(legacyRoot, canonical)) {
        const relative = path.relative(legacyRoot, canonical)
        const routeSlug = relative ? relative.split(path.sep)[0] : path.basename(canonical)
        return {
          mode: 'legacy_flat',
          readOnly: true,
          diagnostics: [{ code: 'LEGACY_FLAT_READ_ONLY', message: 'Legacy flat-layout packages require explicit migration before mutation.' }],
          libraryRoot: layout.libraryRoot,
          paperRoot: canonical,
          packageDir: canonical,
          generationDir: canonical,
          overlayDir: null,
          routeSlug,
          paperKey: null,
          paperId: null,
          sourceRevisionId: null,
          generationId: null,
          paperLockKey: `legacy:${routeSlug}`,
          generationLockKey: `legacy:${routeSlug}`
        }
      }
    }
    return { mode: 'explicit_path', readOnly: false, packageDir: canonical, generationDir: canonical }
  }
  return resolveLibraryPaper(input, options)
}

export function readOverlayState(descriptor) {
  if (descriptor.mode !== 'managed_v1') return { schemaVersion: LIBRARY_LAYOUT_VERSION, tags: [], progress: {}, annotations: [] }
  const statePath = path.join(descriptor.overlayDir, OVERLAY_STATE_FILENAME)
  if (!fs.existsSync(statePath)) return { schemaVersion: LIBRARY_LAYOUT_VERSION, tags: [], progress: {}, annotations: [] }
  const state = readJsonNoFollow(statePath, OVERLAY_STATE_FILENAME)
  if (state?.schemaVersion !== LIBRARY_LAYOUT_VERSION || !Array.isArray(state.tags) || typeof state.progress !== 'object' || !Array.isArray(state.annotations)) {
    throw new LibraryLayoutError('OVERLAY_STATE_INVALID', 'Overlay state is invalid.')
  }
  return state
}

export function assertWritableDescriptor(descriptor) {
  if (descriptor.readOnly || descriptor.mode !== 'managed_v1') {
    throw new LibraryLayoutError('LEGACY_PACKAGE_READ_ONLY', 'Legacy flat-layout packages are read-only until explicitly migrated.', 409)
  }
  return descriptor
}

export function ensureManagedStore(options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  for (const directory of [layout.libraryRoot, path.join(layout.libraryRoot, '.codex-paper'), layout.storeRoot, layout.recordsRoot]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', 'Managed store paths must not be symlinks.', 403)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  return layout
}

export function writeFileAtomicNoFollow(filePath, content, mode = 0o600) {
  const parent = requireSafeDirectory(path.dirname(filePath))
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new LibraryLayoutError('LIBRARY_PATH_UNSAFE', 'Writable record must not be a symlink.', 403)
    fs.renameSync(temporary, filePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
}

export function writeJsonAtomicNoFollow(filePath, value) {
  writeFileAtomicNoFollow(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
