import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CURRENT_RECORD_FILENAME,
  OVERLAY_STATE_FILENAME,
  PAPER_RECORD_FILENAME,
  buildPackageRelativePath,
  ensureManagedStore,
  getLibraryLayout,
  listManagedRecords,
  readCurrentRecord,
  readJsonNoFollow,
  readOverlayState,
  readPaperRecord,
  requireNoFollowDirectory,
  validatePaperRecord,
} from './paper-library.mjs'
import {
  GENERATION_MANIFEST_RELATIVE_PATH,
  buildGenerationManifest,
  deriveManifestId,
  readManifestBoundFile,
  stableJson,
  verifyGenerationManifest,
  verifyGenerationManifestBinding,
} from './generation-manifest.mjs'
import {
  MANIFEST_VERSION,
  assertContentRuntime,
  collectRuntimeAttestation,
  recoverPendingAuthoringEvents,
  runtimeGenerationContract,
  stableJson as provenanceStableJson,
  verifyReadmeProjection,
} from './generation-provenance.mjs'
import {
  createWorkspaceDiagnostic,
  listGenerationWorkspaces,
  resolveGenerationWorkspace,
} from './generation-workspace.mjs'
import {
  atomicWriteJson,
  fileWritePrecondition,
  readFileNoFollowBounded,
  withStorageLocks,
} from './storage-transaction.mjs'
import { validateValidationReportForPublication } from '../../skills/study/scripts/validation-report.js'

export const PUBLICATION_TRANSACTION_VERSION = '1.0.0'
export const PUBLICATION_JOURNAL = 'publication.json'
const TRANSACTION_STATES = new Set(['prepared', 'generation_committed', 'current_committed', 'index_committed', 'failed'])
const HASH_PATTERN = /^[a-f0-9]{64}$/

export class GenerationPublicationError extends Error {
  constructor(code, message, statusCode = 422, details = {}) {
    super(message)
    this.name = 'GenerationPublicationError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function transactionId() {
  return `pub-${crypto.randomBytes(16).toString('hex')}`
}

function validateTransaction(record, workspace) {
  if (record?.schemaVersion !== PUBLICATION_TRANSACTION_VERSION
    || !/^pub-[a-f0-9]{32}$/.test(String(record?.transactionId || ''))
    || record?.workspaceId !== workspace.workspaceId
    || !TRANSACTION_STATES.has(record?.state)
    || record?.paperKey !== workspace.paperKey
    || record?.paperId !== workspace.paperId
    || record?.sourceRevisionId !== workspace.sourceRevisionId
    || record?.generationId !== workspace.generationId
    || record?.targetPackageRelativePath !== workspace.workspace.targetPackageRelativePath
    || !/^gm-sha256-[a-f0-9]{64}$/.test(String(record?.manifestId || ''))
    || !HASH_PATTERN.test(String(record?.manifestHash || ''))
    || !HASH_PATTERN.test(String(record?.manifestFileSha256 || ''))
    || !HASH_PATTERN.test(String(record?.validationReportHash || ''))
    || Number.isNaN(Date.parse(record?.createdAt)) || Number.isNaN(Date.parse(record?.updatedAt))
    || !Array.isArray(record?.diagnostics) || record.diagnostics.length > 32
    || record.diagnostics.some((item) => !/^[A-Z0-9_]+$/.test(String(item?.code || '')) || typeof item?.message !== 'string' || item.message.length > 600)) {
    throw new GenerationPublicationError('PUBLICATION_JOURNAL_INVALID', 'Publication journal is invalid.', 422)
  }
  return record
}

function readJournal(workspace) {
  const journalPath = path.join(workspace.workspaceDir, PUBLICATION_JOURNAL)
  if (!fs.existsSync(journalPath)) return null
  let value
  try { value = JSON.parse(readFileNoFollowBounded(journalPath, 1024 * 1024).toString('utf8')) } catch (error) {
    if (error?.code) throw error
    throw new GenerationPublicationError('PUBLICATION_JOURNAL_INVALID', 'Publication journal is invalid JSON.', 422)
  }
  return validateTransaction(value, workspace)
}

function writeJournal(workspace, journal, lockHandle) {
  const value = validateTransaction({ ...journal, updatedAt: new Date().toISOString() }, workspace)
  const journalPath = path.join(workspace.workspaceDir, PUBLICATION_JOURNAL)
  atomicWriteJson({
    root: workspace.workspaceDir,
    relativePath: PUBLICATION_JOURNAL,
    value,
    lockHandle,
    requiredLock: workspace.workspaceLockKey,
    maxBytes: 1024 * 1024,
    ...fileWritePrecondition(journalPath, 1024 * 1024),
  })
  return value
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function ensureDirectoryChain(root, relativePath) {
  let current = requireNoFollowDirectory(path.dirname(root), root)
  const canonicalRoot = current
  for (const segment of relativePath.split('/').filter(Boolean)) {
    const next = path.join(current, segment)
    try { fs.mkdirSync(next, { mode: 0o700 }) } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    current = requireNoFollowDirectory(canonicalRoot, next)
  }
  return current
}

function atomicJson(root, relativePath, value, lockHandle, requiredLock, maxBytes = 8 * 1024 * 1024) {
  const target = path.join(root, ...relativePath.split('/'))
  return atomicWriteJson({ root, relativePath, value, lockHandle, requiredLock, maxBytes, ...fileWritePrecondition(target, maxBytes) })
}

function readValidationReport(packageDir) {
  const report = readJsonNoFollow(path.join(packageDir, '.codex-paper/validation-report.json'), 'validation-report.json', 8 * 1024 * 1024)
  try { return validateValidationReportForPublication(report) } catch (error) {
    throw new GenerationPublicationError(error?.code || 'PUBLICATION_GATE_BLOCKED', error?.message || 'Publication gate blocked.', error?.statusCode || 409)
  }
}

function readIdentity(packageDir, workspace) {
  const identity = readJsonNoFollow(path.join(packageDir, '.codex-paper/paper-identity.json'), 'paper-identity.json', 8 * 1024 * 1024)
  if (identity?.paperId !== workspace.paperId || identity?.sourceRevisionId !== workspace.sourceRevisionId
    || identity?.generationId !== workspace.generationId || identity?.source?.sha256 !== workspace.sourceRevisionId.replace(/^sha256:/, '')
    || identity?.generation?.fingerprint?.value !== workspace.generationId.replace(/^gen:sha256:/, '')) {
    throw new GenerationPublicationError('PUBLICATION_IDENTITY_MISMATCH', 'Workspace identity does not match its publication target.', 409)
  }
  return identity
}

function verifyManifestProjection(packageDir, manifestId) {
  const metaPath = path.join(packageDir, 'meta.json')
  const meta = readJsonNoFollow(metaPath, 'meta.json', 8 * 1024 * 1024)
  if (meta?.generationManifest?.schemaVersion !== MANIFEST_VERSION || meta.generationManifest.manifestId !== manifestId) {
    throw new GenerationPublicationError('PUBLICATION_PROVENANCE_MISMATCH', 'meta.json manifest projection does not match the workspace identity.', 409)
  }
  return meta
}

function sealWorkspacePackage(workspace, lockHandle, options = {}) {
  const packageDir = workspace.packageDir
  if (!packageDir) throw new GenerationPublicationError('PUBLICATION_WORKSPACE_DETACHED', 'Detached publication residues must be recovered from their committed generation.', 409)
  const report = readValidationReport(packageDir)
  const identity = readIdentity(packageDir, workspace)
  if (identity.schemaVersion !== '2.0.0') throw new GenerationPublicationError('PUBLICATION_PROVENANCE_REQUIRED', 'Generation Manifest 2.0 publication requires Paper Identity 2.0.', 409)
  const currentRuntime = assertContentRuntime(options.runtimeAttestation || collectRuntimeAttestation(options.env || process.env))
  if (provenanceStableJson(runtimeGenerationContract(currentRuntime)) !== provenanceStableJson(identity.generation.inputs.runtimeContract)) {
    throw new GenerationPublicationError('PUBLICATION_RUNTIME_MISMATCH', 'Current content runtime does not match the generation identity.', 409)
  }
  const draft = recoverPendingAuthoringEvents(workspace, lockHandle)
  const id = deriveManifestId({
    paperKey: workspace.paperKey,
    sourceRevisionId: workspace.sourceRevisionId,
    generationId: workspace.generationId,
  })
  if (draft.manifestId !== id) throw new GenerationPublicationError('PUBLICATION_PROVENANCE_MISMATCH', 'Workspace provenance does not match the publication identity.', 409)
  verifyManifestProjection(packageDir, id)
  verifyReadmeProjection(packageDir, id)
  const txId = options.transactionId || transactionId()
  const manifest = buildGenerationManifest({
    packageDir,
    transactionId: txId,
    paperKey: workspace.paperKey,
    identity,
    validationReport: report,
    provenanceDraft: draft,
  })
  const manifestPath = path.join(packageDir, ...GENERATION_MANIFEST_RELATIVE_PATH.split('/'))
  atomicWriteJson({
    root: packageDir,
    relativePath: GENERATION_MANIFEST_RELATIVE_PATH,
    value: manifest,
    lockHandle,
    requiredLock: workspace.workspaceLockKey,
    maxBytes: 8 * 1024 * 1024,
    ...fileWritePrecondition(manifestPath, 8 * 1024 * 1024),
  })
  const verified = verifyGenerationManifest(packageDir, manifestBinding(manifest))
  const now = new Date().toISOString()
  const journal = {
    schemaVersion: PUBLICATION_TRANSACTION_VERSION,
    transactionId: txId,
    workspaceId: workspace.workspaceId,
    state: 'prepared',
    paperKey: workspace.paperKey,
    paperId: workspace.paperId,
    sourceRevisionId: workspace.sourceRevisionId,
    generationId: workspace.generationId,
    targetPackageRelativePath: workspace.workspace.targetPackageRelativePath,
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    manifestFileSha256: verified.manifestFileSha256,
    validationReportHash: report.reportHash.value,
    createdAt: now,
    updatedAt: now,
    diagnostics: [],
  }
  return { journal: writeJournal(workspace, journal, lockHandle), manifest, report }
}

function publicationLockKeys(workspace) {
  return ['registry', workspace.paperLockKey, workspace.sourceLockKey, workspace.generationLockKey, workspace.workspaceLockKey, 'index']
}

function mergePaperRecord(existing, intended, routeSlug) {
  const merged = {
    ...existing,
    primaryPaperId: intended.primaryPaperId || existing.primaryPaperId,
    paperIdAliases: [...new Set([...existing.paperIdAliases, ...intended.paperIdAliases])].sort(),
    routeAliases: [...new Set([...existing.routeAliases, ...intended.routeAliases, routeSlug])].sort(),
    reconciliations: [...new Map([...existing.reconciliations, ...intended.reconciliations].map((item) => [stableJson(item), item])).values()],
  }
  return validatePaperRecord(merged, existing.paperKey)
}

function currentRecord(workspace, journal, publishedAt = new Date().toISOString()) {
  return {
    schemaVersion: '1.0.0',
    paperKey: workspace.paperKey,
    paperId: workspace.paperId,
    sourceRevisionId: workspace.sourceRevisionId,
    generationId: workspace.generationId,
    packageRelativePath: buildPackageRelativePath(workspace.sourceRevisionId, workspace.generationId),
    manifestId: journal.manifestId,
    manifestHash: journal.manifestHash,
    manifestFileSha256: journal.manifestFileSha256,
    validationReportHash: journal.validationReportHash,
    publishedAt,
  }
}

function overlayState(recordDir, pendingTags = []) {
  const statePath = path.join(recordDir, 'overlay', OVERLAY_STATE_FILENAME)
  if (!fs.existsSync(statePath)) return { schemaVersion: '1.0.0', tags: pendingTags, progress: {}, annotations: [] }
  const current = readJsonNoFollow(statePath, OVERLAY_STATE_FILENAME)
  if (current?.schemaVersion !== '1.0.0' || !Array.isArray(current.tags) || typeof current.progress !== 'object' || !Array.isArray(current.annotations)) {
    throw new GenerationPublicationError('OVERLAY_STATE_INVALID', 'Paper overlay state is invalid.', 422)
  }
  return pendingTags.length > 0 ? { ...current, tags: [...new Set(pendingTags)] } : current
}

function writeOverlay(recordDir, state, lockHandle, paperLockKey) {
  ensureDirectoryChain(recordDir, 'overlay')
  atomicJson(path.join(recordDir, 'overlay'), OVERLAY_STATE_FILENAME, state, lockHandle, paperLockKey)
}

function assertRouteAvailable(workspace, existingRecord = null) {
  const layout = getLibraryLayout(workspace.libraryRoot)
  const legacyRoute = path.join(layout.legacyPapersRoot, workspace.routeSlug)
  if (fs.existsSync(legacyRoute)) {
    const stats = fs.lstatSync(legacyRoute)
    if (stats.isSymbolicLink()) throw new GenerationPublicationError('PUBLICATION_PATH_UNSAFE', 'Legacy route authority is unsafe.', 403)
    if (stats.isDirectory()) throw new GenerationPublicationError('PUBLICATION_ROUTE_CONFLICT', 'Publication route is owned by a legacy paper.', 409)
    throw new GenerationPublicationError('LEGACY_INDEX_SOURCE_INVALID', 'Legacy route authority contains an unexpected entry.', 422)
  }
  for (const { record } of listManagedRecords({ libraryRoot: workspace.libraryRoot })) {
    if (record.paperKey !== workspace.paperKey && record.routeAliases.includes(workspace.routeSlug)) {
      throw new GenerationPublicationError('PUBLICATION_ROUTE_CONFLICT', 'Publication route is already owned by another paper.', 409)
    }
    if (record.paperIdAliases.includes(workspace.paperId) && record.paperKey !== workspace.paperKey) {
      throw new GenerationPublicationError('PUBLICATION_IDENTITY_CONFLICT', 'Publication identity is already owned by another paper.', 409)
    }
  }
  for (const pending of listGenerationWorkspaces({ libraryRoot: workspace.libraryRoot })) {
    if (pending.workspaceId === workspace.workspaceId || !fs.existsSync(path.join(pending.workspaceDir, PUBLICATION_JOURNAL))) continue
    if (pending.paperKey !== workspace.paperKey && pending.routeSlug === workspace.routeSlug) {
      throw new GenerationPublicationError('PUBLICATION_ROUTE_CONFLICT', 'Publication route is reserved by another recoverable transaction.', 409)
    }
    if (pending.paperKey !== workspace.paperKey && pending.paperId === workspace.paperId) {
      throw new GenerationPublicationError('PUBLICATION_IDENTITY_CONFLICT', 'Publication identity is reserved by another recoverable transaction.', 409)
    }
  }
  return existingRecord
}

function sealPermissions(root) {
  function walk(current) {
    const stats = fs.lstatSync(current)
    if (stats.isSymbolicLink()) throw new GenerationPublicationError('PUBLICATION_PATH_UNSAFE', 'Published generations cannot contain symlinks.', 403)
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry))
      fs.chmodSync(current, 0o500)
    } else if (stats.isFile()) fs.chmodSync(current, 0o400)
    else throw new GenerationPublicationError('PUBLICATION_PATH_UNSAFE', 'Published generations cannot contain special files.', 403)
  }
  walk(root)
}

function manifestBinding(current) {
  return {
    manifestId: current.manifestId,
    manifestHash: current.manifestHash,
    manifestFileSha256: current.manifestFileSha256,
    paperKey: current.paperKey,
    generationId: current.generationId,
  }
}

export function buildManagedIndexEntries(libraryRoot, options = {}) {
  const strict = options.managedStrict ?? options.strict ?? false
  const entries = []
  for (const { recordDir, record } of listManagedRecords({ libraryRoot })) {
    try {
      const current = readCurrentRecord(recordDir, record)
      const packageDir = requireNoFollowDirectory(recordDir, path.join(recordDir, ...current.packageRelativePath.split('/')), 'PAPER_GENERATION_NOT_FOUND')
      let manifest = null
      if (current.manifestId) manifest = verifyGenerationManifestBinding(packageDir, manifestBinding(current)).manifest
      let meta
      if (manifest) {
        try { meta = JSON.parse(readManifestBoundFile(packageDir, manifest, 'meta.json', 8 * 1024 * 1024).toString('utf8')) } catch (error) {
          if (error?.code) throw error
          throw new GenerationPublicationError('INDEX_MANAGED_RECORD_INVALID', 'Managed paper metadata is invalid.', 422)
        }
      } else meta = readJsonNoFollow(path.join(packageDir, 'meta.json'), 'meta.json')
      const overlayDir = path.join(recordDir, 'overlay')
      const descriptor = { mode: 'managed_v1', overlayDir }
      const tags = readOverlayState(descriptor).tags
      entries.push({
        ...meta,
        slug: record.routeAliases[0],
        title: meta.title || record.routeAliases[0],
        tags,
        storageKey: record.paperKey,
        paperId: current.paperId,
        paperIdAliases: record.paperIdAliases,
        sourceRevisionId: current.sourceRevisionId,
        generationId: current.generationId,
        ...(manifest ? {
          generationManifest: {
            schemaVersion: manifest.schemaVersion,
            manifestId: manifest.manifestId,
            manifestHash: manifest.manifestHash,
            manifestFileSha256: current.manifestFileSha256,
          },
          validationReportHash: current.validationReportHash,
        } : {}),
      })
    } catch (error) {
      if (strict) throw error
      options.diagnostics?.push({
        paperKey: record.paperKey,
        ...createWorkspaceDiagnostic(error, {
          fallbackCode: 'INDEX_MANAGED_RECORD_SKIPPED',
          redactions: [libraryRoot, recordDir],
        }),
      })
    }
  }
  return entries.sort((left, right) => String(left.slug).localeCompare(String(right.slug)))
}

export function buildLegacyIndexEntries(libraryRoot, options = {}) {
  const strict = options.legacyStrict ?? options.strict ?? false
  const layout = getLibraryLayout(libraryRoot)
  if (!fs.existsSync(layout.legacyPapersRoot)) return []
  const root = requireNoFollowDirectory(layout.libraryRoot, layout.legacyPapersRoot)
  const entries = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && !entry.isSymbolicLink() && (['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'].includes(entry.name) || entry.name.startsWith('._'))) continue
    try {
      if (entry.isSymbolicLink() || !entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) {
        throw new GenerationPublicationError('LEGACY_INDEX_SOURCE_INVALID', 'Legacy paper registry contains an unsafe entry.', 403)
      }
      const packageDir = requireNoFollowDirectory(root, path.join(root, entry.name))
      const meta = readJsonNoFollow(path.join(packageDir, 'meta.json'), 'meta.json')
      entries.push({ ...meta, slug: entry.name, title: meta.title || entry.name })
    } catch (error) {
      if (strict) throw error
      options.diagnostics?.push({
        path: `papers/${entry.name}`,
        ...createWorkspaceDiagnostic(error, {
          fallbackCode: 'LEGACY_INDEX_SOURCE_INVALID',
          redactions: [libraryRoot, root],
        }),
      })
    }
  }
  return entries
}

export function buildLibraryIndexEntries(libraryRoot, options = {}) {
  const entries = [...buildLegacyIndexEntries(libraryRoot, options), ...buildManagedIndexEntries(libraryRoot, options)]
    .sort((left, right) => String(left.slug).localeCompare(String(right.slug)))
  const slugs = entries.map((entry) => entry.slug)
  if (new Set(slugs).size !== slugs.length) throw new GenerationPublicationError('PUBLICATION_ROUTE_CONFLICT', 'Library index sources contain duplicate route aliases.', 409)
  return entries
}

function writeRebuiltIndexLocked(libraryRoot, lockHandle) {
  const layout = getLibraryLayout(libraryRoot)
  const diagnostics = []
  const entries = buildLibraryIndexEntries(libraryRoot, {
    diagnostics,
    managedStrict: false,
    legacyStrict: true,
  })
  let value = entries
  if (fs.existsSync(layout.indexPath)) {
    const existing = readJsonNoFollow(layout.indexPath, 'index.json')
    if (Array.isArray(existing)) value = entries
    else if (existing && typeof existing === 'object' && Array.isArray(existing.papers)) value = { ...existing, papers: entries }
    else throw new GenerationPublicationError('LIBRARY_INDEX_INVALID', 'Library index has an unsupported shape.', 422)
  }
  atomicWriteJson({ root: layout.libraryRoot, relativePath: 'index.json', value, lockHandle, requiredLock: 'index', maxBytes: 64 * 1024 * 1024, ...fileWritePrecondition(layout.indexPath, 64 * 1024 * 1024) })
  return { entries, diagnostics }
}

function maybeFault(options, point) {
  if (options.faultAt === point) throw new GenerationPublicationError('PUBLICATION_FAULT_INJECTED', `Synthetic publication failure at ${point}.`, 409)
}

function existingPublicationState(workspace, journal, layout) {
  const recordDir = path.join(layout.recordsRoot, workspace.paperKey)
  const target = path.join(recordDir, ...journal.targetPackageRelativePath.split('/'))
  const stagingDir = path.join(layout.recordsRoot, `.publish-${journal.transactionId}-${workspace.paperKey}`)
  return { recordDir, target, stagingDir }
}

function commitPublicationLocked(workspace, journal, lockHandle, options = {}) {
  const layout = ensureManagedStore({ libraryRoot: workspace.libraryRoot })
  const intended = validatePaperRecord(workspace.workspace.publishIntent.paperRecord, workspace.paperKey)
  assertRouteAvailable(workspace)
  const { recordDir, target, stagingDir } = existingPublicationState(workspace, journal, layout)
  const recordExists = fs.existsSync(path.join(recordDir, PAPER_RECORD_FILENAME))
  const pendingTags = workspace.workspace.publishIntent.tags || []
  let current = currentRecord(workspace, journal)

  if (recordExists) {
    const existing = readPaperRecord(recordDir)
    const merged = mergePaperRecord(existing, intended, workspace.routeSlug)
    if (stableJson(existing) !== stableJson(merged)) atomicJson(recordDir, PAPER_RECORD_FILENAME, merged, lockHandle, workspace.paperLockKey)
    ensureDirectoryChain(recordDir, path.posix.dirname(journal.targetPackageRelativePath))
    if (!fs.existsSync(target)) {
      if (!workspace.packageDir) throw new GenerationPublicationError('PUBLICATION_GENERATION_MISSING', 'Neither workspace nor committed generation contains the publication payload.', 409)
      fs.renameSync(workspace.packageDir, target)
      fsyncDirectory(path.dirname(target))
      fsyncDirectory(workspace.workspaceDir)
      maybeFault(options, 'after_existing_payload_rename')
    }
    sealPermissions(target)
    const verified = verifyGenerationManifest(target, manifestBinding(journal))
    if (verified.manifest.validation.reportHash !== journal.validationReportHash) throw new GenerationPublicationError('PUBLICATION_MANIFEST_MISMATCH', 'Committed generation validation binding is invalid.', 422)
    journal = writeJournal(workspace, { ...journal, state: 'generation_committed' }, lockHandle)
    maybeFault(options, 'after_generation_commit')
    const currentPath = path.join(recordDir, CURRENT_RECORD_FILENAME)
    if (fs.existsSync(currentPath)) {
      const existingCurrent = readCurrentRecord(recordDir, existing)
      if (existingCurrent.generationId === workspace.generationId && existingCurrent.manifestId === journal.manifestId) current = existingCurrent
      else atomicJson(recordDir, CURRENT_RECORD_FILENAME, current, lockHandle, workspace.paperLockKey)
    } else atomicJson(recordDir, CURRENT_RECORD_FILENAME, current, lockHandle, workspace.paperLockKey)
    writeOverlay(recordDir, overlayState(recordDir, pendingTags), lockHandle, workspace.paperLockKey)
  } else {
    if (fs.existsSync(recordDir) && !fs.existsSync(stagingDir)) {
      const entries = fs.readdirSync(recordDir)
      if (entries.length > 0) throw new GenerationPublicationError('PUBLICATION_RECORD_CONFLICT', 'Paper record destination contains an incomplete or foreign transaction.', 409)
      fs.rmdirSync(recordDir)
    }
    if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { mode: 0o700 })
    const stagingTarget = ensureDirectoryChain(stagingDir, path.posix.dirname(journal.targetPackageRelativePath))
    const targetInStaging = path.join(stagingTarget, 'package')
    let stagedNewPayload = false
    if (!fs.existsSync(targetInStaging)) {
      if (!workspace.packageDir) throw new GenerationPublicationError('PUBLICATION_GENERATION_MISSING', 'Workspace publication payload is missing.', 409)
      fs.renameSync(workspace.packageDir, targetInStaging)
      fsyncDirectory(stagingTarget)
      fsyncDirectory(workspace.workspaceDir)
      maybeFault(options, 'after_new_payload_rename')
      stagedNewPayload = true
    } else if (workspace.packageDir) {
      throw new GenerationPublicationError('PUBLICATION_RECORD_CONFLICT', 'Both workspace and staging contain a publication payload.', 409)
    }
    sealPermissions(targetInStaging)
    if (stagedNewPayload) maybeFault(options, 'after_new_payload_staged')
    verifyGenerationManifest(targetInStaging, manifestBinding(journal))
    const stagedPaperRecordPath = path.join(stagingDir, PAPER_RECORD_FILENAME)
    if (!fs.existsSync(stagedPaperRecordPath)) atomicJson(stagingDir, PAPER_RECORD_FILENAME, intended, lockHandle, workspace.paperLockKey)
    else {
      const stagedRecord = validatePaperRecord(readJsonNoFollow(stagedPaperRecordPath, PAPER_RECORD_FILENAME), workspace.paperKey)
      if (stableJson(stagedRecord) !== stableJson(intended)) throw new GenerationPublicationError('PUBLICATION_RECORD_CONFLICT', 'Publication staging record does not match its workspace intent.', 409)
    }
    writeOverlay(stagingDir, overlayState(stagingDir, pendingTags), lockHandle, workspace.paperLockKey)
    const stagedCurrentPath = path.join(stagingDir, CURRENT_RECORD_FILENAME)
    if (!fs.existsSync(stagedCurrentPath)) atomicJson(stagingDir, CURRENT_RECORD_FILENAME, current, lockHandle, workspace.paperLockKey)
    else {
      const stagedCurrent = readCurrentRecord(stagingDir, intended)
      if (stagedCurrent.paperKey !== current.paperKey || stagedCurrent.paperId !== current.paperId
        || stagedCurrent.sourceRevisionId !== current.sourceRevisionId || stagedCurrent.generationId !== current.generationId
        || stagedCurrent.packageRelativePath !== current.packageRelativePath || stagedCurrent.manifestId !== current.manifestId
        || stagedCurrent.manifestHash !== current.manifestHash || stagedCurrent.manifestFileSha256 !== current.manifestFileSha256
        || stagedCurrent.validationReportHash !== current.validationReportHash) {
        throw new GenerationPublicationError('PUBLICATION_RECORD_CONFLICT', 'Publication staging current record does not match its journal.', 409)
      }
      current = stagedCurrent
    }
    fsyncDirectory(stagingDir)
    journal = writeJournal(workspace, { ...journal, state: 'generation_committed' }, lockHandle)
    maybeFault(options, 'after_generation_commit')
    if (!fs.existsSync(recordDir)) fs.renameSync(stagingDir, recordDir)
    else if (fs.existsSync(stagingDir)) throw new GenerationPublicationError('PUBLICATION_RECORD_CONFLICT', 'Paper record was concurrently created.', 409)
    fsyncDirectory(layout.recordsRoot)
    current = readCurrentRecord(recordDir, readPaperRecord(recordDir))
    verifyGenerationManifest(path.join(recordDir, ...current.packageRelativePath.split('/')), manifestBinding(current))
  }

  journal = writeJournal(workspace, { ...journal, state: 'current_committed' }, lockHandle)
  maybeFault(options, 'after_current_commit')
  maybeFault(options, 'before_index_commit')
  const index = writeRebuiltIndexLocked(layout.libraryRoot, lockHandle)
  journal = writeJournal(workspace, { ...journal, state: 'index_committed' }, lockHandle)
  return {
    workspaceId: workspace.workspaceId,
    paperKey: workspace.paperKey,
    routeSlug: workspace.routeSlug,
    current,
    manifestId: journal.manifestId,
    manifestHash: journal.manifestHash,
    indexEntries: index.entries.length,
    indexDiagnostics: index.diagnostics,
    published: true,
  }
}

export async function publishGenerationWorkspace(input, options = {}) {
  const initial = resolveGenerationWorkspace(input, options)
  if (initial.initializationResidue) throw new GenerationPublicationError('WORKSPACE_INITIALIZATION_INCOMPLETE', 'Initialization residues cannot be published.', 409)
  if (initial.workspace.state !== 'validated') throw new GenerationPublicationError('PUBLICATION_WORKSPACE_NOT_VALIDATED', 'Only a validated workspace may be published.', 409)
  return withStorageLocks(publicationLockKeys(initial), async (lockHandle) => {
    const workspace = resolveGenerationWorkspace(initial.workspaceId, { libraryRoot: initial.libraryRoot })
    let journal = readJournal(workspace)
    try {
      if (!journal) {
        const sealed = sealWorkspacePackage(workspace, lockHandle, options)
        journal = sealed.journal
        maybeFault(options, 'after_manifest')
      } else if (workspace.packageDir) {
        verifyGenerationManifest(workspace.packageDir, manifestBinding(journal))
      }
      return commitPublicationLocked(workspace, journal, lockHandle, options)
    } catch (error) {
      if (journal) {
        try {
          const persistedJournal = readJournal(workspace) || journal
          const diagnostic = createWorkspaceDiagnostic(error, { fallbackCode: 'PUBLICATION_FAILED', redactions: [workspace.libraryRoot, workspace.workspaceDir, workspace.packageDir] })
          writeJournal(workspace, { ...persistedJournal, diagnostics: [...persistedJournal.diagnostics, diagnostic].slice(-32) }, lockHandle)
        } catch (preservationError) { error.preservationError = preservationError }
      }
      throw error
    }
  }, { libraryRoot: initial.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export async function recoverPublications(options = {}) {
  const results = []
  const workspaces = []
  for (const item of listGenerationWorkspaces(options)) {
    if (!item.publicationResidue && !fs.existsSync(path.join(item.workspaceDir, PUBLICATION_JOURNAL))) continue
    try {
      if (readJournal(item)?.state !== 'index_committed') workspaces.push(item)
    } catch (error) {
      const diagnostic = createWorkspaceDiagnostic(error, {
        fallbackCode: 'PUBLICATION_RECOVERY_FAILED',
        redactions: [item.libraryRoot, item.workspaceDir, item.packageDir],
      })
      results.push({ workspaceId: item.workspaceId, success: false, ...diagnostic })
    }
  }
  for (const workspace of workspaces) {
    try { results.push({ workspaceId: workspace.workspaceId, success: true, result: await publishGenerationWorkspace(workspace.workspaceId, options) }) }
    catch (error) {
      const diagnostic = createWorkspaceDiagnostic(error, {
        fallbackCode: 'PUBLICATION_RECOVERY_FAILED',
        redactions: [workspace.libraryRoot, workspace.workspaceDir, workspace.packageDir],
      })
      results.push({ workspaceId: workspace.workspaceId, success: false, ...diagnostic })
    }
  }
  return results
}

export async function rebuildLibraryIndex(options = {}) {
  const layout = ensureManagedStore(options)
  const paperKeys = fs.existsSync(layout.recordsRoot)
    ? fs.readdirSync(layout.recordsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^p-[a-f0-9]{64}$/.test(entry.name)).map((entry) => `paper:${entry.name}`)
    : []
  return withStorageLocks(['registry', ...paperKeys, 'index'], async (lockHandle) => writeRebuiltIndexLocked(layout.libraryRoot, lockHandle), {
    libraryRoot: layout.libraryRoot,
    timeoutMs: options.lockTimeoutMs ?? 10_000,
  })
}
