import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  StorageTransactionError,
  atomicWriteFile,
  atomicWriteJson,
  fileWritePrecondition,
  readFileNoFollowBounded,
  withStorageLocksSync,
  withStorageLocks,
} from './storage-transaction.mjs'
import {
  buildPackageRelativePath,
  GENERATION_WORKSPACE_STATES,
  GENERATION_WORKSPACE_VERSION as SHARED_WORKSPACE_VERSION,
  getLibraryLayout,
  generationStorageLockKey,
  paperStorageLockKey,
  requireNoFollowDirectory,
  sourceStorageLockKey,
  validateGenerationWorkspaceRecord,
  WORKSPACES_RELATIVE_PATH as SHARED_WORKSPACES_RELATIVE_PATH,
  WORKSPACE_ID_PATTERN,
  workspaceStorageLockKey,
} from './paper-library.mjs'

export const GENERATION_WORKSPACE_VERSION = SHARED_WORKSPACE_VERSION
export const WORKSPACES_RELATIVE_PATH = SHARED_WORKSPACES_RELATIVE_PATH
export const WORKSPACE_STATES = GENERATION_WORKSPACE_STATES
const WORKSPACE_TRANSITIONS = Object.freeze({
  authoring: new Set(['authoring', 'validating', 'failed', 'abandoned']),
  validating: new Set(['validating', 'validated', 'failed', 'authoring', 'abandoned']),
  validated: new Set(['validated', 'validating', 'failed', 'authoring', 'abandoned']),
  failed: new Set(['failed', 'authoring', 'validating', 'abandoned']),
  abandoned: new Set(['abandoned']),
})

const PAPER_KEY_PATTERN = /^p-[a-f0-9]{64}$/
const SOURCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/
const GENERATION_ID_PATTERN = /^gen:sha256:[a-f0-9]{64}$/
const ROUTE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const AUTHORING_ROOT_FILES = new Set([
  'README.md', 'quick-summary.md', 'visual-assets.md', 'summary.md', 'insights.md', 'method.md',
  'mental-model.md', 'reflection.md', 'qa.md', 'index.html', 'reasoning-analysis.json',
])
const AUTHORING_CODEX_FILES = new Set(['.codex-paper/reasoning-review.md', '.codex-paper/answering-pack.md'])
const PUBLICATION_STATES = new Set(['prepared', 'generation_committed', 'current_committed', 'index_committed', 'failed'])

export class GenerationWorkspaceError extends StorageTransactionError {
  constructor(code, message, statusCode = 422, details = {}) {
    super(code, message, statusCode, details)
    this.name = 'GenerationWorkspaceError'
  }
}

export function getWorkspaceLayout(libraryRoot = process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers')) {
  const library = getLibraryLayout(libraryRoot)
  return { ...library, workspacesRoot: path.join(library.libraryRoot, WORKSPACES_RELATIVE_PATH) }
}

function ensureWorkspaceRoot(libraryRoot) {
  const layout = getWorkspaceLayout(libraryRoot)
  for (const directory of [layout.libraryRoot, path.join(layout.libraryRoot, '.codex-paper'), layout.workspacesRoot]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stats = fs.lstatSync(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new GenerationWorkspaceError('WORKSPACE_PATH_UNSAFE', 'Workspace root must be a non-symlink directory.', 403)
  }
  const libraryDevice = fs.statSync(layout.libraryRoot).dev
  const workspaceDevice = fs.statSync(layout.workspacesRoot).dev
  if (libraryDevice !== workspaceDevice) throw new GenerationWorkspaceError('WORKSPACE_FILESYSTEM_MISMATCH', 'Workspace and library store must use the same filesystem.', 409)
  return layout
}

function boundedText(value, max = 600, redactions = []) {
  let text = String(value || '')
  for (const item of [...redactions].filter(Boolean).sort((left, right) => right.length - left.length)) text = text.replaceAll(item, '<local-path>')
  text = text.replace(/(?:\/[^/\s:]+){2,}/g, '<local-path>').replace(/[\r\n]+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

export function createWorkspaceDiagnostic(error, options = {}) {
  const code = String(error?.code || options.fallbackCode || 'WORKSPACE_OPERATION_FAILED')
    .toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64)
  return {
    code,
    message: boundedText(error?.message || error, options.maxMessageLength ?? 600, options.redactions || [])
  }
}

export function validateWorkspaceRecord(record, expectedId = null) {
  try { return validateGenerationWorkspaceRecord(record, expectedId) } catch (error) {
    throw new GenerationWorkspaceError('WORKSPACE_RECORD_INVALID', 'Generation workspace record is invalid.', 422)
  }
}

export function assertWorkspaceTransition(currentState, nextState) {
  if (!WORKSPACE_TRANSITIONS[currentState]?.has(nextState)) {
    throw new GenerationWorkspaceError('WORKSPACE_STATE_TRANSITION_INVALID', 'Generation workspace state transition is not allowed.', 409)
  }
}

function readWorkspaceRecord(workspaceDir, workspaceId = null) {
  const recordPath = path.join(workspaceDir, 'workspace.json')
  let bytes
  try { bytes = readFileNoFollowBounded(recordPath, 1024 * 1024) } catch (error) {
    throw new GenerationWorkspaceError(error?.code === 'ENOENT' ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_RECORD_INVALID', 'Generation workspace record is unavailable.', error?.statusCode || 422)
  }
  let record
  try { record = JSON.parse(bytes.toString('utf8')) } catch {
    throw new GenerationWorkspaceError('WORKSPACE_RECORD_INVALID', 'Generation workspace record is invalid.', 422)
  }
  return validateWorkspaceRecord(record, workspaceId)
}

export function isActiveWorkspaceState(state) {
  return state === 'authoring' || state === 'validating' || state === 'validated'
}

export function isActiveGenerationWorkspace(item) {
  if (item?.initializationResidue) return false
  if (item?.publicationResidue) return item.publicationState !== 'index_committed'
  return isActiveWorkspaceState(item?.workspace?.state)
}

function isInitializationDirectory(name) {
  return name.startsWith('.init-')
}

function initializationWorkspaceById(layout, workspaceId) {
  const matches = []
  for (const entry of fs.readdirSync(layout.workspacesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith(`.init-${workspaceId}-`)) continue
    const candidate = path.join(layout.workspacesRoot, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains an unsafe initialization entry.', 403)
    if (!fs.existsSync(path.join(candidate, 'workspace.json'))) continue
    const workspaceDir = requireNoFollowDirectory(layout.workspacesRoot, candidate, 'WORKSPACE_NOT_FOUND')
    const record = readWorkspaceRecord(workspaceDir)
    if (record.workspaceId !== workspaceId) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace initialization directory does not match its record identity.', 422)
    matches.push({ workspaceDir, record })
  }
  if (matches.length > 1) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains duplicate workspace identities.', 422)
  return matches[0] || null
}

function descriptor(workspaceDir, record, libraryRoot) {
  const packageCandidate = path.join(workspaceDir, 'package')
  const publicationJournal = path.join(workspaceDir, 'publication.json')
  let journalStats = null
  try { journalStats = fs.lstatSync(publicationJournal) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const publicationResidue = journalStats !== null
  const publicationDetached = publicationResidue && !fs.existsSync(packageCandidate)
  let publicationState = null
  let publicationInvalid = false
  let publicationDiagnostic = null
  const packageDir = publicationDetached ? null : requireNoFollowDirectory(workspaceDir, packageCandidate, 'WORKSPACE_PACKAGE_MISSING')
  if (publicationResidue) {
    try {
      if (journalStats.isSymbolicLink() || !journalStats.isFile()) throw new GenerationWorkspaceError('WORKSPACE_PATH_UNSAFE', 'Publication journal must be a regular non-symlink file.', 403)
      const parsed = JSON.parse(readFileNoFollowBounded(publicationJournal, 1024 * 1024).toString('utf8'))
      if (!PUBLICATION_STATES.has(parsed?.state)) throw new GenerationWorkspaceError('PUBLICATION_JOURNAL_INVALID', 'Publication journal state is invalid.', 422)
      publicationState = parsed.state
    } catch (error) {
      publicationState = 'invalid'
      publicationInvalid = true
      publicationDiagnostic = createWorkspaceDiagnostic(error, {
        fallbackCode: 'PUBLICATION_JOURNAL_INVALID',
        redactions: [getWorkspaceLayout(libraryRoot).libraryRoot, workspaceDir, publicationJournal],
      })
    }
  }
  const initializationResidue = isInitializationDirectory(path.basename(workspaceDir))
  return {
    mode: 'generation_workspace_v1',
    readOnly: record.state === 'abandoned' || initializationResidue || publicationResidue,
    initializationResidue,
    publicationResidue,
    publicationDetached,
    publicationState,
    publicationInvalid,
    publicationDiagnostic,
    libraryRoot: getWorkspaceLayout(libraryRoot).libraryRoot,
    workspaceId: record.workspaceId,
    workspaceDir,
    packageDir,
    generationDir: packageDir,
    paperRoot: workspaceDir,
    overlayDir: null,
    routeSlug: record.routeSlug,
    paperKey: record.paperKey,
    paperId: record.paperId,
    sourceRevisionId: record.sourceRevisionId,
    generationId: record.generationId,
    paperLockKey: paperStorageLockKey(record.paperKey),
    sourceLockKey: sourceStorageLockKey(record.paperKey, record.sourceRevisionId),
    generationLockKey: generationStorageLockKey(record.paperKey, record.generationId),
    workspaceLockKey: workspaceStorageLockKey(record.workspaceId),
    workspace: record,
  }
}

export function listGenerationWorkspaces(options = {}) {
  const layout = getWorkspaceLayout(options.libraryRoot)
  if (!fs.existsSync(layout.workspacesRoot)) return []
  requireNoFollowDirectory(path.join(layout.libraryRoot, '.codex-paper'), layout.workspacesRoot)
  const output = []
  const workspaceIds = new Set()
  for (const entry of fs.readdirSync(layout.workspacesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isInitializationDirectory(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains an unsafe initialization entry.', 403)
      const workspaceDir = path.join(layout.workspacesRoot, entry.name)
      if (!fs.existsSync(path.join(workspaceDir, 'workspace.json'))) continue
      const canonicalWorkspace = requireNoFollowDirectory(layout.workspacesRoot, workspaceDir, 'WORKSPACE_NOT_FOUND')
      const item = descriptor(canonicalWorkspace, readWorkspaceRecord(canonicalWorkspace), layout.libraryRoot)
      if (workspaceIds.has(item.workspaceId)) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains duplicate workspace identities.', 422)
      workspaceIds.add(item.workspaceId)
      output.push(item)
      continue
    }
    if (entry.isFile() && !entry.isSymbolicLink() && (
      ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'].includes(entry.name) || entry.name.startsWith('._')
    )) continue
    if (entry.isSymbolicLink() || !entry.isDirectory() || !WORKSPACE_ID_PATTERN.test(entry.name)) {
      throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains an unsafe entry.', 403)
    }
    const workspaceDir = requireNoFollowDirectory(layout.workspacesRoot, path.join(layout.workspacesRoot, entry.name), 'WORKSPACE_NOT_FOUND')
    const item = descriptor(workspaceDir, readWorkspaceRecord(workspaceDir, entry.name), layout.libraryRoot)
    if (workspaceIds.has(item.workspaceId)) throw new GenerationWorkspaceError('WORKSPACE_REGISTRY_INVALID', 'Workspace registry contains duplicate workspace identities.', 422)
    workspaceIds.add(item.workspaceId)
    output.push(item)
  }
  return output
}

export function resolveGenerationWorkspace(input, options = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new GenerationWorkspaceError('WORKSPACE_REFERENCE_INVALID', 'Workspace ID or path is required.', 400)
  const layout = getWorkspaceLayout(options.libraryRoot)
  let workspaceDir
  const isId = WORKSPACE_ID_PATTERN.test(input)
  if (isId) workspaceDir = path.join(layout.workspacesRoot, input)
  else {
    const candidate = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()))
    const packageSuffix = `${path.sep}package`
    workspaceDir = candidate.endsWith(packageSuffix) ? path.dirname(candidate) : candidate
  }
  if (!fs.existsSync(layout.workspacesRoot)) throw new GenerationWorkspaceError('WORKSPACE_NOT_FOUND', 'Generation workspace was not found.', 404)
  const canonicalRoot = requireNoFollowDirectory(path.join(layout.libraryRoot, '.codex-paper'), layout.workspacesRoot, 'WORKSPACE_NOT_FOUND')
  if (isId) {
    workspaceDir = path.join(canonicalRoot, input)
    if (!fs.existsSync(workspaceDir)) {
      const residue = initializationWorkspaceById({ ...layout, workspacesRoot: canonicalRoot }, input)
      if (!residue) throw new GenerationWorkspaceError('WORKSPACE_NOT_FOUND', 'Generation workspace was not found.', 404)
      workspaceDir = residue.workspaceDir
    }
  }
  else if (fs.existsSync(workspaceDir)) workspaceDir = fs.realpathSync(workspaceDir)
  else throw new GenerationWorkspaceError('WORKSPACE_REFERENCE_INVALID', 'Workspace path must identify an existing exact workspace.', 400)
  const canonicalWorkspace = requireNoFollowDirectory(canonicalRoot, workspaceDir, 'WORKSPACE_NOT_FOUND')
  const directoryName = path.basename(canonicalWorkspace)
  if (!WORKSPACE_ID_PATTERN.test(directoryName) && !isInitializationDirectory(directoryName)) throw new GenerationWorkspaceError('WORKSPACE_REFERENCE_INVALID', 'Workspace reference is invalid.', 400)
  const record = readWorkspaceRecord(canonicalWorkspace, WORKSPACE_ID_PATTERN.test(directoryName) ? directoryName : null)
  if (isId && record.workspaceId !== input) throw new GenerationWorkspaceError('WORKSPACE_REFERENCE_INVALID', 'Workspace reference does not match its record.', 400)
  return descriptor(canonicalWorkspace, record, layout.libraryRoot)
}

function cleanupInitDirectories(layout, now = Date.now()) {
  if (!fs.existsSync(layout.workspacesRoot)) return
  let inspected = 0
  for (const entry of fs.readdirSync(layout.workspacesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith('.init-') || inspected >= 32) continue
    inspected += 1
    const candidate = path.join(layout.workspacesRoot, entry.name)
    const stats = fs.lstatSync(candidate)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new GenerationWorkspaceError('WORKSPACE_PATH_UNSAFE', 'Workspace initialization residue is unsafe.', 403)
    if (fs.existsSync(path.join(candidate, 'workspace.json'))) continue
    if (now - stats.mtimeMs > 60 * 60 * 1000) fs.rmSync(candidate, { recursive: true, force: true })
  }
}

export function workspaceIdFor(identity) {
  const paper = String(identity.paperKey).replace(/^p-/, '').slice(0, 12)
  const generation = String(identity.generationId).replace(/^gen:sha256:/, '').slice(0, 12)
  return `ws-${paper}-${generation}-${crypto.randomBytes(16).toString('hex')}`
}

export async function createGenerationWorkspace({ identity, routeSlug, paperRecord, reconciliation = null, tags = [], populate, libraryRoot, lockTimeoutMs = 10_000 }) {
  const layout = ensureWorkspaceRoot(libraryRoot)
  const paperKey = paperRecord?.paperKey
  if (!PAPER_KEY_PATTERN.test(String(paperKey || '')) || !ROUTE_PATTERN.test(String(routeSlug || ''))) {
    throw new GenerationWorkspaceError('WORKSPACE_IDENTITY_INVALID', 'Workspace identity proposal is invalid.', 400)
  }
  const generationLock = generationStorageLockKey(paperKey, identity.generationId)
  const keys = ['registry', paperStorageLockKey(paperKey), sourceStorageLockKey(paperKey, identity.sourceRevisionId), generationLock]
  return withStorageLocks(keys, async (lockHandle) => {
    cleanupInitDirectories(layout)
    const activeWorkspaces = listGenerationWorkspaces({ libraryRoot: layout.libraryRoot }).filter(isActiveGenerationWorkspace)
    const existing = activeWorkspaces.find((item) => item.generationId === identity.generationId)
    if (existing) throw new GenerationWorkspaceError('WORKSPACE_EXISTS', `Active workspace ${existing.workspaceId} already exists for this generation; resume that exact ID or abandon it before retrying.`, 409, { workspaceId: existing.workspaceId })
    if (activeWorkspaces.some((item) => item.routeSlug === routeSlug && item.paperKey !== paperKey)) {
      throw new GenerationWorkspaceError('WORKSPACE_ROUTE_CONFLICT', 'An active workspace already reserves this route alias.', 409)
    }
    const workspaceId = workspaceIdFor({ paperKey, generationId: identity.generationId })
    const initDir = path.join(layout.workspacesRoot, `.init-${workspaceId}-${crypto.randomBytes(8).toString('hex')}`)
    const finalDir = path.join(layout.workspacesRoot, workspaceId)
    fs.mkdirSync(initDir, { mode: 0o700 })
    fs.mkdirSync(path.join(initDir, 'package'), { mode: 0o700 })
    const createdAt = new Date().toISOString()
    const record = {
      schemaVersion: GENERATION_WORKSPACE_VERSION,
      workspaceId,
      state: 'authoring',
      paperKey,
      paperId: identity.paperId,
      sourceRevisionId: identity.sourceRevisionId,
      generationId: identity.generationId,
      targetPackageRelativePath: buildPackageRelativePath(identity.sourceRevisionId, identity.generationId),
      routeSlug,
      createdAt,
      updatedAt: createdAt,
      lastSuccessfulStep: 'prepared',
      diagnostics: [],
      publishIntent: { paperRecord, reconciliation, tags },
    }
    try {
      await populate({ packageDir: path.join(initDir, 'package'), lockHandle, requiredLock: generationLock, workspaceId })
      atomicWriteJson({ root: initDir, relativePath: 'workspace.json', value: record, lockHandle, requiredLock: generationLock, expectAbsent: true })
      fs.renameSync(initDir, finalDir)
      const directoryDescriptor = fs.openSync(layout.workspacesRoot, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
      return resolveGenerationWorkspace(workspaceId, { libraryRoot: layout.libraryRoot })
    } catch (error) {
      let preservationError = null
      let preserved = false
      try {
        const failed = { ...record, state: 'failed', updatedAt: new Date().toISOString(), lastSuccessfulStep: 'initialization_failed', diagnostics: [createWorkspaceDiagnostic(error, { fallbackCode: 'WORKSPACE_INITIALIZATION_FAILED', redactions: [layout.libraryRoot, initDir, finalDir] })] }
        const preservationDir = fs.existsSync(finalDir) ? finalDir : initDir
        const recordPath = path.join(preservationDir, 'workspace.json')
        const precondition = fileWritePrecondition(recordPath, 1024 * 1024)
        atomicWriteJson({ root: preservationDir, relativePath: 'workspace.json', value: failed, lockHandle, requiredLock: generationLock, maxBytes: 1024 * 1024, ...precondition })
        if (preservationDir === initDir && !fs.existsSync(finalDir)) fs.renameSync(initDir, finalDir)
        const directoryDescriptor = fs.openSync(layout.workspacesRoot, fs.constants.O_RDONLY)
        try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
        preserved = true
      } catch (caught) {
        preservationError = caught
      }
      const originalMessage = boundedText(error?.message || error, 300, [layout.libraryRoot, initDir, finalDir])
      const failure = new GenerationWorkspaceError(
        'WORKSPACE_INITIALIZATION_FAILED',
        `Workspace ${workspaceId} initialization failed: ${originalMessage}. Inspect it by exact workspace ID; failed workspaces do not block a fresh retry.`,
        409,
        { workspaceId, preserved: preserved || fs.existsSync(path.join(initDir, 'workspace.json')) || fs.existsSync(path.join(finalDir, 'workspace.json')) }
      )
      failure.cause = error
      if (preservationError) failure.preservationError = preservationError
      throw failure
    }
  }, { libraryRoot: layout.libraryRoot, timeoutMs: lockTimeoutMs })
}

export function updateWorkspaceRecordLocked(current, update, lockHandle, options = {}) {
  const resolveOptions = { ...options, libraryRoot: current.libraryRoot }
  const refreshed = resolveGenerationWorkspace(current.workspaceId, resolveOptions)
  if (refreshed.workspace.state === 'abandoned') throw new GenerationWorkspaceError('WORKSPACE_ABANDONED', 'Abandoned workspaces are read-only.', 409)
  if (refreshed.publicationResidue) throw new GenerationWorkspaceError('WORKSPACE_PUBLICATION_IN_PROGRESS', 'A sealed publication transaction is read-only and must be recovered.', 409)
  const previousBytes = readFileNoFollowBounded(path.join(refreshed.workspaceDir, 'workspace.json'), 1024 * 1024)
  const previousHash = crypto.createHash('sha256').update(previousBytes).digest('hex')
  const patch = typeof update === 'function' ? update(refreshed.workspace) : update
  if (refreshed.initializationResidue && patch.state !== 'abandoned') {
    throw new GenerationWorkspaceError('WORKSPACE_INITIALIZATION_INCOMPLETE', 'Initialization residues are read-only; inspect or abandon this workspace and run prepare again.', 409)
  }
  assertWorkspaceTransition(refreshed.workspace.state, patch.state ?? refreshed.workspace.state)
  const next = validateWorkspaceRecord({ ...refreshed.workspace, ...patch, updatedAt: new Date().toISOString() }, refreshed.workspaceId)
  atomicWriteJson({ root: refreshed.workspaceDir, relativePath: 'workspace.json', value: next, lockHandle, requiredLock: refreshed.workspaceLockKey, expectedSha256: previousHash, maxBytes: 1024 * 1024 })
  return resolveGenerationWorkspace(refreshed.workspaceId, resolveOptions)
}

export function transitionWorkspaceToAuthoringLocked(current, lockHandle, options = {}) {
  const refreshed = resolveGenerationWorkspace(current.workspaceId, { ...options, libraryRoot: current.libraryRoot })
  if (refreshed.initializationResidue) throw new GenerationWorkspaceError('WORKSPACE_INITIALIZATION_INCOMPLETE', 'Initialization residues are read-only; inspect or abandon this workspace and run prepare again.', 409)
  if (refreshed.publicationResidue) throw new GenerationWorkspaceError('WORKSPACE_PUBLICATION_IN_PROGRESS', 'A sealed publication transaction is read-only and must be recovered.', 409)
  if (refreshed.workspace.state === 'authoring') return refreshed
  return updateWorkspaceRecordLocked(refreshed, { state: 'authoring', lastSuccessfulStep: 'authoring_started' }, lockHandle, options)
}

export async function updateWorkspaceRecord(input, update, options = {}) {
  const current = resolveGenerationWorkspace(input, options)
  return withStorageLocks([current.paperLockKey, current.generationLockKey, current.workspaceLockKey], async (lockHandle) => {
    return updateWorkspaceRecordLocked(current, update, lockHandle, options)
  }, { libraryRoot: current.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export function updateWorkspaceRecordSync(input, update, options = {}) {
  const current = resolveGenerationWorkspace(input, options)
  return withStorageLocksSync([current.paperLockKey, current.generationLockKey, current.workspaceLockKey], (lockHandle) => {
    return updateWorkspaceRecordLocked(current, update, lockHandle, options)
  }, { libraryRoot: current.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export function isAuthoringPath(relativePath) {
  if (AUTHORING_ROOT_FILES.has(relativePath) || AUTHORING_CODEX_FILES.has(relativePath)) return true
  return /^(?:code|images)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relativePath)
    && !relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
}

export async function writeWorkspaceAuthoring(input, relativePath, data, precondition, options = {}) {
  if (!isAuthoringPath(relativePath)) throw new GenerationWorkspaceError('WORKSPACE_WRITE_PATH_FORBIDDEN', 'The requested path is not an approved authoring artifact.', 403)
  const current = resolveGenerationWorkspace(input, options)
  if (current.initializationResidue) throw new GenerationWorkspaceError('WORKSPACE_INITIALIZATION_INCOMPLETE', 'Initialization residues are read-only; inspect or abandon this workspace and run prepare again.', 409)
  if (current.publicationResidue) throw new GenerationWorkspaceError('WORKSPACE_PUBLICATION_IN_PROGRESS', 'A sealed publication transaction is read-only and must be recovered.', 409)
  if (current.workspace.state === 'abandoned') throw new GenerationWorkspaceError('WORKSPACE_ABANDONED', 'Abandoned workspaces are read-only.', 409)
  return withStorageLocks([current.paperLockKey, current.generationLockKey, current.workspaceLockKey], async (lockHandle) => {
    let refreshed = transitionWorkspaceToAuthoringLocked(current, lockHandle, options)
    const maxBytes = relativePath.startsWith('code/') ? 1024 * 1024 : 16 * 1024 * 1024
    const result = atomicWriteFile({ root: refreshed.packageDir, relativePath, data, lockHandle, requiredLock: refreshed.workspaceLockKey, maxBytes, ...precondition })
    refreshed = updateWorkspaceRecordLocked(refreshed, { state: 'authoring', lastSuccessfulStep: 'authoring' }, lockHandle, options)
    return result
  }, { libraryRoot: current.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export async function setWorkspaceTags(input, tags, options = {}) {
  if (!Array.isArray(tags) || tags.length > 32 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64 || /[\u0000-\u001f\u007f]/.test(tag))) {
    throw new GenerationWorkspaceError('WORKSPACE_TAGS_INVALID', 'Workspace tags are invalid.', 400)
  }
  const normalized = [...new Set(tags.map((tag) => tag.trim()))]
  const workspace = resolveGenerationWorkspace(input, options)
  return updateWorkspaceRecord(workspace.workspaceId, (record) => ({ publishIntent: { ...record.publishIntent, tags: normalized } }), options)
}

export async function abandonGenerationWorkspace(input, options = {}) {
  const workspace = resolveGenerationWorkspace(input, options)
  if (workspace.workspace.state === 'abandoned') return workspace
  return updateWorkspaceRecord(workspace.workspaceId, { state: 'abandoned', lastSuccessfulStep: 'abandoned' }, options)
}
