import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'

import {
  BACKUPS_RELATIVE_PATH,
  descriptorForRecord,
  RESTORE_STAGING_RELATIVE_PATH,
  RESTORE_TRANSACTIONS_RELATIVE_PATH,
  STORE_RELATIVE_PATH,
  WORKSPACES_RELATIVE_PATH,
  getLibraryLayout,
  readPaperRecord,
  readJsonNoFollow,
  resolveLibraryPaper,
} from './paper-library.mjs'
import {
  atomicWriteJson,
  fileWritePrecondition,
  readFileNoFollowBounded,
  withStorageLocks,
} from './storage-transaction.mjs'
import {
  classifyInvalidPackageArtifacts,
  classifyPackageCompatibility,
} from './package-compatibility.mjs'
import { verifyGenerationManifest } from './generation-manifest.mjs'
import { sanitizeText } from './cli-error-format.mjs'
import { readPaperIdentity } from '../../skills/study/scripts/paper-identity.js'
import { buildLibraryIndexEntries } from './generation-publication.mjs'

export const DOCTOR_REPORT_VERSION = '1.1.0'
export const BACKUP_MANIFEST_VERSION = '1.0.0'
export const RESTORE_TRANSACTION_VERSION = '1.0.0'
export const MIGRATION_PLAN_VERSION = '1.1.0'
export const MIGRATION_POLICY = Object.freeze({
  version: '1.0.0',
  authoringProvider: 'codex-paper-migration',
  authoringModel: 'p1-2b-1.0.0',
})

const BACKUP_ID_PATTERN = /^bk-sha256-[a-f0-9]{64}$/
const RESTORE_ID_PATTERN = /^restore-[a-f0-9]{32}$/
const PAPER_KEY_PATTERN = /^p-[a-f0-9]{64}$/
const ROUTE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_FILES = 20_000
const MAX_DEPTH = 20
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
const BUFFER_BYTES = 1024 * 1024
const MIGRATION_TRANSACTIONS_RELATIVE_PATH = '.codex-paper/migration-transactions-v1'
const MIGRATION_ARCHIVES_RELATIVE_PATH = '.codex-paper/migration-archives-v1'
const SCHEMA_DIRECTORY = new URL('../../skills/study/schemas/', import.meta.url)
const schemaCompiler = new Ajv2020({ allErrors: true, strict: true })
const schemaValidators = Object.fromEntries([
  ['backup', 'paper-backup-manifest-1.0.schema.json'],
  ['doctorLegacy', 'library-doctor-report-1.0.schema.json'],
  ['doctor', 'library-doctor-report-1.1.schema.json'],
  ['restore', 'backup-restore-transaction-1.0.schema.json'],
  ['migrationLegacy', 'migration-plan-1.0.schema.json'],
  ['migration', 'migration-plan-1.1.schema.json'],
  ['migrationTransaction', 'migration-transaction-1.0.schema.json'],
].map(([name, filename]) => [
  name,
  schemaCompiler.compile(JSON.parse(fs.readFileSync(new URL(filename, SCHEMA_DIRECTORY), 'utf8'))),
]))

export class LibraryMaintenanceError extends Error {
  constructor(code, message, statusCode = 422, details = {}) {
    super(message)
    this.name = 'LibraryMaintenanceError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function assertSchema(name, value, code) {
  const validate = schemaValidators[name]
  if (validate(value)) return value
  const details = validate.errors?.slice(0, 20).map((item) => ({
    path: item.instancePath || '/',
    keyword: item.keyword,
  })) || []
  throw new LibraryMaintenanceError(code, `${name} document does not match its 1.0 schema.`, 422, { errors: details })
}

export function validateMigrationPlanDocument(value) {
  const version = value?.schemaVersion
  if (version === '1.0.0') return {
    plan: assertSchema('migrationLegacy', value, 'MIGRATION_PLAN_INVALID'),
    compatibilityMode: 'compatible_1_0',
    readOnly: true,
  }
  if (version === MIGRATION_PLAN_VERSION) return {
    plan: assertSchema('migration', value, 'MIGRATION_PLAN_INVALID'),
    compatibilityMode: 'native_1_1',
    readOnly: false,
  }
  throw new LibraryMaintenanceError('MIGRATION_PLAN_VERSION_UNSUPPORTED', 'Migration Plan version is unsupported.', 422)
}

export function validateDoctorReportDocument(value) {
  if (value?.schemaVersion === '1.0.0') return {
    report: assertSchema('doctorLegacy', value, 'DOCTOR_REPORT_INVALID'),
    compatibilityMode: 'compatible_1_0',
    readOnly: true,
  }
  if (value?.schemaVersion === DOCTOR_REPORT_VERSION) return {
    report: assertSchema('doctor', value, 'DOCTOR_REPORT_INVALID'),
    compatibilityMode: 'native_1_1',
    readOnly: false,
  }
  throw new LibraryMaintenanceError('DOCTOR_REPORT_UNSUPPORTED', 'Doctor report version is unsupported.', 422)
}

function relativePosix(root, target) {
  const authority = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root)
  const candidate = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target)
  const relative = path.relative(authority, candidate)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new LibraryMaintenanceError('LIBRARY_PATH_ESCAPE', 'The maintenance target escapes the paper library.', 403)
  }
  return relative.split(path.sep).join('/')
}

function safeSegments(relativePath) {
  return typeof relativePath === 'string' && relativePath
    && !path.posix.isAbsolute(relativePath)
    && !relativePath.includes('\\')
    && !relativePath.includes('\0')
    && relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

function requireDirectory(directory, parent = null, missingCode = 'LIBRARY_PATH_MISSING') {
  let stats
  try { stats = fs.lstatSync(directory) } catch (error) {
    if (error?.code === 'ENOENT') throw new LibraryMaintenanceError(missingCode, 'Required library directory is missing.', 404)
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new LibraryMaintenanceError('LIBRARY_PATH_UNSAFE', 'Library maintenance directories must be real directories.', 403)
  }
  const canonical = fs.realpathSync(directory)
  if (parent) {
    const canonicalParent = fs.realpathSync(parent)
    const relative = path.relative(canonicalParent, canonical)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new LibraryMaintenanceError('LIBRARY_PATH_ESCAPE', 'Library maintenance path escapes its authority boundary.', 403)
    }
  }
  return canonical
}

function ensurePrivateDirectory(directory, parent = null) {
  if (parent) requireDirectory(parent)
  try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const canonical = requireDirectory(directory, parent)
  fs.chmodSync(canonical, 0o700)
  return canonical
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function maybeFault(options, point) {
  if (options.faultAt !== point) return
  throw new LibraryMaintenanceError(
    'BACKUP_FAULT_INJECTED',
    `Synthetic backup failure at ${point}.`,
    409,
  )
}

function removeTreeForcingWritable(root) {
  if (!fs.existsSync(root)) return
  const stats = fs.lstatSync(root)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    if (stats.isFile()) fs.chmodSync(root, 0o600)
    fs.rmSync(root, { force: true })
    return
  }
  // Callers only pass random .init-* children of the private 0700 backup registry
  // while holding the target/backup lock set, so untrusted writers cannot replace
  // a traversed directory between this lstat and the recursive read.
  fs.chmodSync(root, 0o700)
  for (const entry of fs.readdirSync(root)) removeTreeForcingWritable(path.join(root, entry))
  fs.rmdirSync(root)
}

function fileHash(filePath, expectedBytes = MAX_FILE_BYTES) {
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new LibraryMaintenanceError('BACKUP_PATH_UNSAFE', 'Backup sources must contain only regular files and directories.', 403)
  }
  if (stats.size > expectedBytes) throw new LibraryMaintenanceError('BACKUP_LIMIT_EXCEEDED', 'A backup file exceeds the size budget.', 413)
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES)
  let offset = 0
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      offset += count
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const after = fs.lstatSync(filePath)
  if (after.isSymbolicLink() || !after.isFile() || after.size !== stats.size
    || after.mtimeMs !== stats.mtimeMs || after.ino !== stats.ino) {
    throw new LibraryMaintenanceError('BACKUP_SOURCE_CHANGED', 'Backup source changed while it was being read.', 409)
  }
  return { sha256: hash.digest('hex'), bytes: offset, mode: stats.mode & 0o777 }
}

export function inventoryTree(root) {
  const canonicalRoot = requireDirectory(root)
  const rootMode = fs.lstatSync(canonicalRoot).mode & 0o777
  const directories = []
  const files = []
  let totalBytes = 0
  function walk(directory, relative = '', depth = 0) {
    if (depth > MAX_DEPTH) throw new LibraryMaintenanceError('BACKUP_LIMIT_EXCEEDED', 'Backup tree exceeds the depth budget.', 413)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name
      if (!safeSegments(relativePath)) throw new LibraryMaintenanceError('BACKUP_PATH_UNSAFE', 'Backup tree contains an unsafe path.', 403)
      const target = path.join(directory, entry.name)
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink()) throw new LibraryMaintenanceError('BACKUP_PATH_UNSAFE', 'Backup tree cannot contain symlinks.', 403)
      if (stats.isDirectory()) {
        directories.push({ path: relativePath, mode: stats.mode & 0o777 })
        walk(target, relativePath, depth + 1)
        continue
      }
      if (!stats.isFile()) throw new LibraryMaintenanceError('BACKUP_PATH_UNSAFE', 'Backup tree cannot contain special files.', 403)
      const item = fileHash(target)
      totalBytes += item.bytes
      if (totalBytes > MAX_TOTAL_BYTES) throw new LibraryMaintenanceError('BACKUP_LIMIT_EXCEEDED', 'Backup tree exceeds the total byte budget.', 413)
      files.push({ path: relativePath, ...item })
      if (files.length > MAX_FILES) throw new LibraryMaintenanceError('BACKUP_LIMIT_EXCEEDED', 'Backup tree exceeds the file-count budget.', 413)
    }
  }
  walk(canonicalRoot)
  directories.sort((left, right) => left.path < right.path ? -1 : (left.path > right.path ? 1 : 0))
  files.sort((left, right) => left.path < right.path ? -1 : (left.path > right.path ? 1 : 0))
  if (files.length + directories.length > MAX_FILES) {
    throw new LibraryMaintenanceError('BACKUP_LIMIT_EXCEEDED', 'Backup tree exceeds the entry-count budget.', 413)
  }
  return {
    rootMode,
    directories,
    files,
    totalBytes,
    snapshotHash: sha256(stableJson({ rootMode, directories, files })),
  }
}

export function migrationSourceSnapshot(root, kind) {
  const inventory = inventoryTree(root)
  if (kind !== 'managed_paper') return inventory
  const keep = (item) => item.path !== 'overlay' && !item.path.startsWith('overlay/')
  const directories = inventory.directories.filter(keep)
  const files = inventory.files.filter(keep)
  const totalBytes = files.reduce((total, item) => total + item.bytes, 0)
  return {
    rootMode: inventory.rootMode,
    directories,
    files,
    totalBytes,
    snapshotHash: sha256(stableJson({ rootMode: inventory.rootMode, directories, files })),
  }
}

function copyFileVerified(source, target, expected) {
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const targetDescriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  )
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES)
  let offset = 0
  try {
    while (true) {
      const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, offset)
      if (count === 0) break
      fs.writeSync(targetDescriptor, buffer, 0, count)
      hash.update(buffer.subarray(0, count))
      offset += count
    }
    fs.fchmodSync(targetDescriptor, expected.mode)
    fs.fsyncSync(targetDescriptor)
  } finally {
    fs.closeSync(sourceDescriptor)
    fs.closeSync(targetDescriptor)
  }
  if (offset !== expected.bytes || hash.digest('hex') !== expected.sha256) {
    throw new LibraryMaintenanceError('BACKUP_SOURCE_CHANGED', 'Backup source changed while it was copied.', 409)
  }
}

function copyInventory(sourceRoot, targetRoot, inventory) {
  ensurePrivateDirectory(targetRoot, path.dirname(targetRoot))
  for (const item of inventory.directories || []) {
    const target = path.join(targetRoot, ...item.path.split('/'))
    let parent = targetRoot
    for (const segment of item.path.split('/')) {
      const next = path.join(parent, segment)
      if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
      parent = requireDirectory(next, targetRoot)
    }
  }
  for (const item of inventory.files) {
    const target = path.join(targetRoot, ...item.path.split('/'))
    let parent = targetRoot
    for (const segment of item.path.split('/').slice(0, -1)) {
      const next = path.join(parent, segment)
      if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
      parent = requireDirectory(next, targetRoot)
    }
    copyFileVerified(path.join(sourceRoot, ...item.path.split('/')), target, item)
  }
  const directories = [...(inventory.directories || [])]
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length
      || right.path.localeCompare(left.path))
  for (const item of directories) {
    const target = path.join(targetRoot, ...item.path.split('/'))
    fs.chmodSync(target, item.mode)
    fsyncDirectory(target)
  }
  fs.chmodSync(targetRoot, inventory.rootMode ?? 0o700)
  fsyncDirectory(targetRoot)
}

function inventoryMatches(left, right) {
  return left.rootMode === right.rootMode
    && stableJson(left.directories) === stableJson(right.directories)
    && stableJson(left.files) === stableJson(right.files)
    && left.totalBytes === right.totalBytes
    && left.snapshotHash === right.snapshotHash
}

function inventoryMatchesManifest(inventory, manifest) {
  return inventoryMatches(inventory, {
    rootMode: manifest.rootMode,
    directories: manifest.directories,
    files: manifest.files,
    totalBytes: manifest.totalBytes,
    snapshotHash: manifest.snapshotHash,
  })
}

function readOptionalJson(filePath, label) {
  if (!fs.existsSync(filePath)) return { value: null, error: null }
  try { return { value: readJsonNoFollow(filePath, label), error: null } } catch (error) {
    return { value: null, error }
  }
}

function compatibilityForPackage(packageDir) {
  const inputs = {}
  const invalid = []
  for (const [key, filename] of [['meta', 'meta.json'], ['reasoning', 'reasoning-analysis.json'], ['ledger', 'evidence-ledger.json']]) {
    const result = readOptionalJson(path.join(packageDir, filename), filename)
    if (result.error) invalid.push(filename)
    else inputs[key] = result.value
  }
  return invalid.length > 0 ? classifyInvalidPackageArtifacts(invalid) : classifyPackageCompatibility(inputs)
}

function readIndex(layout) {
  if (!fs.existsSync(layout.indexPath)) return { shape: 'missing', value: null, entries: [], bytes: null }
  const bytes = readFileNoFollowBounded(layout.indexPath, 64 * 1024 * 1024)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new LibraryMaintenanceError('LIBRARY_INDEX_INVALID', 'Library index is invalid JSON.', 422)
  }
  if (Array.isArray(value)) return { shape: 'array', value, entries: value, bytes }
  if (value && typeof value === 'object' && Array.isArray(value.papers)) {
    return { shape: 'object', value, entries: value.papers, bytes }
  }
  throw new LibraryMaintenanceError('LIBRARY_INDEX_INVALID', 'Library index has an unsupported shape.', 422)
}

function entriesForTarget(index, target) {
  if (target.kind === 'managed_paper') {
    return index.entries.filter((entry) => entry?.storageKey === target.paperKey)
  }
  return index.entries.filter((entry) => entry?.slug === target.routeSlug)
}

export function structuralTarget(input, libraryRoot) {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('/') || input.includes('\\')) {
    throw new LibraryMaintenanceError('BACKUP_TARGET_INVALID', 'Backup targets must be a library paper reference, not a path.', 400)
  }
  const layout = getLibraryLayout(libraryRoot)
  try {
    const descriptor = resolveLibraryPaper(input, { libraryRoot: layout.libraryRoot })
    if (descriptor.mode === 'legacy_flat') {
      return {
        kind: 'legacy_flat',
        targetDir: descriptor.paperRoot,
        targetRelativePath: relativePosix(layout.libraryRoot, descriptor.paperRoot),
        routeSlug: descriptor.routeSlug,
        paperKey: null,
        lockKeys: [descriptor.paperLockKey, 'index'],
      }
    }
    if (descriptor.mode === 'managed_v1') {
      return {
        kind: 'managed_paper',
        targetDir: descriptor.paperRoot,
        targetRelativePath: relativePosix(layout.libraryRoot, descriptor.paperRoot),
        routeSlug: descriptor.routeSlug,
        paperKey: descriptor.paperKey,
        lockKeys: ['registry', descriptor.paperLockKey, 'index'],
      }
    }
  } catch (error) {
    const isDirectPaperKey = PAPER_KEY_PATTERN.test(input)
    const managed = isDirectPaperKey ? path.join(layout.recordsRoot, input) : null
    if (managed && fs.existsSync(managed)) {
      requireDirectory(managed, layout.recordsRoot)
      return {
        kind: 'managed_paper',
        targetDir: managed,
        targetRelativePath: relativePosix(layout.libraryRoot, managed),
        routeSlug: null,
        paperKey: input,
        lockKeys: ['registry', `paper:${input}`, 'index'],
      }
    }
    const legacy = ROUTE_PATTERN.test(input) ? path.join(layout.legacyPapersRoot, input) : null
    if (legacy && fs.existsSync(legacy)) {
      requireDirectory(legacy, layout.legacyPapersRoot)
      return {
        kind: 'legacy_flat',
        targetDir: legacy,
        targetRelativePath: relativePosix(layout.libraryRoot, legacy),
        routeSlug: input,
        paperKey: null,
        lockKeys: [`legacy:${input}`, 'index'],
      }
    }
    throw error
  }
  throw new LibraryMaintenanceError('BACKUP_TARGET_UNSUPPORTED', 'Only legacy flat or managed paper records can be backed up.', 400)
}

export function descriptorForMigrationTarget(target, libraryRoot) {
  const layout = getLibraryLayout(libraryRoot)
  if (target?.kind === 'legacy_flat') {
    return {
      mode: 'legacy_flat',
      readOnly: true,
      libraryRoot: layout.libraryRoot,
      paperRoot: target.targetDir,
      packageDir: target.targetDir,
      generationDir: target.targetDir,
      overlayDir: null,
      routeSlug: target.routeSlug,
      routeAliases: [target.routeSlug],
      paperKey: null,
      paperLockKey: `legacy:${target.routeSlug}`,
      generationLockKey: `legacy:${target.routeSlug}`,
      record: null,
      current: null,
    }
  }
  if (target?.kind === 'managed_paper') {
    const recordDir = path.join(layout.recordsRoot, target.paperKey)
    const record = readPaperRecord(recordDir)
    return descriptorForRecord(recordDir, record, { libraryRoot: layout.libraryRoot })
  }
  throw new LibraryMaintenanceError('BACKUP_TARGET_UNSUPPORTED', 'Migration target layout is unsupported.', 400)
}

function backupIntrinsic(manifest) {
  const { integrity, ...intrinsic } = manifest
  return intrinsic
}

function validateBackupManifest(manifest) {
  if (manifest?.schemaVersion !== BACKUP_MANIFEST_VERSION
    || !BACKUP_ID_PATTERN.test(String(manifest?.backupId || ''))
    || !['legacy_flat', 'managed_paper'].includes(manifest?.target?.kind)
    || !safeSegments(manifest?.target?.relativePath)
    || (manifest.target.kind === 'managed_paper' && !PAPER_KEY_PATTERN.test(String(manifest.target.paperKey || '')))
    || (manifest.target.kind === 'legacy_flat' && !ROUTE_PATTERN.test(String(manifest.target.routeSlug || '')))
    || !['missing', 'array', 'object'].includes(manifest?.index?.shape)
    || !Array.isArray(manifest?.index?.entries)
    || !Number.isInteger(manifest?.rootMode) || manifest.rootMode < 0 || manifest.rootMode > 0o777
    || !Array.isArray(manifest?.directories) || manifest.directories.length > MAX_FILES
    || manifest.directories.some((item) => !safeSegments(item?.path)
      || !Number.isInteger(item?.mode) || item.mode < 0 || item.mode > 0o777)
    || new Set(manifest.directories.map((item) => item.path)).size !== manifest.directories.length
    || stableJson(manifest.directories.map((item) => item.path)) !== stableJson(manifest.directories.map((item) => item.path).sort())
    || !Array.isArray(manifest?.files) || manifest.files.length > MAX_FILES
    || manifest.files.some((item) => !safeSegments(item?.path) || !HASH_PATTERN.test(String(item?.sha256 || ''))
      || !Number.isInteger(item?.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES
      || !Number.isInteger(item?.mode) || item.mode < 0 || item.mode > 0o777)
    || new Set(manifest.files.map((item) => item.path)).size !== manifest.files.length
    || stableJson(manifest.files.map((item) => item.path)) !== stableJson(manifest.files.map((item) => item.path).sort())
    || manifest.files.length + manifest.directories.length > MAX_FILES
    || !Number.isInteger(manifest?.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_TOTAL_BYTES
    || !HASH_PATTERN.test(String(manifest?.snapshotHash || ''))
    || manifest.snapshotHash !== sha256(stableJson({
      rootMode: manifest.rootMode,
      directories: manifest.directories,
      files: manifest.files,
    }))
    || Number.isNaN(Date.parse(manifest?.createdAt))
    || manifest?.integrity?.algorithm !== 'sha256'
    || !HASH_PATTERN.test(String(manifest?.integrity?.value || ''))
    || manifest.integrity.value !== sha256(stableJson(backupIntrinsic(manifest)))) {
    throw new LibraryMaintenanceError('BACKUP_MANIFEST_INVALID', 'Backup manifest is invalid.', 422)
  }
  const expectedId = `bk-sha256-${sha256(stableJson({
    target: manifest.target,
    index: manifest.index,
    snapshotHash: manifest.snapshotHash,
  }))}`
  if (manifest.backupId !== expectedId) throw new LibraryMaintenanceError('BACKUP_MANIFEST_INVALID', 'Backup ID does not match its snapshot.', 422)
  const targetName = manifest.target.relativePath.split('/').at(-1)
  if ((manifest.target.kind === 'managed_paper' && targetName !== manifest.target.paperKey)
    || (manifest.target.kind === 'legacy_flat' && targetName !== manifest.target.routeSlug)) {
    throw new LibraryMaintenanceError('BACKUP_BINDING_INVALID', 'Backup target path does not match its declared identity.', 422)
  }
  return assertSchema('backup', manifest, 'BACKUP_MANIFEST_INVALID')
}

function backupDirectory(layout, backupId) {
  if (!BACKUP_ID_PATTERN.test(String(backupId || ''))) throw new LibraryMaintenanceError('BACKUP_ID_INVALID', 'Backup ID is invalid.', 400)
  return path.join(layout.backupsRoot, backupId)
}

export function inspectBackup(backupId, options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  const directory = backupDirectory(layout, backupId)
  requireDirectory(directory, layout.backupsRoot, 'BACKUP_NOT_FOUND')
  const manifest = validateBackupManifest(readJsonNoFollow(path.join(directory, 'backup.json'), 'backup.json', 8 * 1024 * 1024))
  if (manifest.backupId !== backupId) throw new LibraryMaintenanceError('BACKUP_BINDING_INVALID', 'Backup directory and manifest do not match.', 422)
  return { directory, payloadDir: requireDirectory(path.join(directory, 'payload'), directory), manifest }
}

export function verifyBackup(backupId, options = {}) {
  const inspected = inspectBackup(backupId, options)
  const actual = inventoryTree(inspected.payloadDir)
  if (!inventoryMatchesManifest(actual, inspected.manifest)) {
    throw new LibraryMaintenanceError('BACKUP_INTEGRITY_FAILED', 'Backup payload differs from its manifest.', 409)
  }
  return {
    backupId,
    verified: true,
    target: inspected.manifest.target,
    snapshotHash: inspected.manifest.snapshotHash,
    files: inspected.manifest.files.length,
    bytes: inspected.manifest.totalBytes,
  }
}

export function listBackups(options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.backupsRoot)) return []
  requireDirectory(layout.backupsRoot, path.join(layout.libraryRoot, '.codex-paper'))
  const output = []
  for (const entry of fs.readdirSync(layout.backupsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.init-')) {
      output.push({ backupId: null, state: 'initialization_residue', relativePath: `${BACKUPS_RELATIVE_PATH}/${entry.name}` })
      continue
    }
    if (entry.name.startsWith('.invalid-')) {
      output.push({ backupId: null, state: 'quarantined', relativePath: `${BACKUPS_RELATIVE_PATH}/${entry.name}` })
      continue
    }
    if (entry.isSymbolicLink() || !entry.isDirectory() || !BACKUP_ID_PATTERN.test(entry.name)) {
      output.push({ backupId: null, state: 'invalid', relativePath: `${BACKUPS_RELATIVE_PATH}/${entry.name}` })
      continue
    }
    try {
      const { manifest } = inspectBackup(entry.name, options)
      if (options.verifyPayloads !== false) verifyBackup(entry.name, options)
      output.push({
        backupId: entry.name,
        state: 'complete',
        target: manifest.target,
        snapshotHash: manifest.snapshotHash,
        createdAt: manifest.createdAt,
      })
    } catch (error) {
      output.push({
        backupId: entry.name,
        state: 'invalid',
        relativePath: `${BACKUPS_RELATIVE_PATH}/${entry.name}`,
        diagnostic: { code: error.code || 'BACKUP_INVALID', message: String(error.message).slice(0, 600) },
      })
    }
  }
  return output
}

export async function createPaperBackup(input, options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.libraryRoot)) throw new LibraryMaintenanceError('LIBRARY_NOT_FOUND', 'Paper library does not exist.', 404)
  const initial = structuralTarget(input, layout.libraryRoot)
  return withStorageLocks(initial.lockKeys, async (lockHandle) => {
    const target = structuralTarget(input, layout.libraryRoot)
    for (const key of target.lockKeys) lockHandle.assertOwns(key)
    const index = readIndex(layout)
    const inventory = inventoryTree(target.targetDir)
    const targetRecord = {
      kind: target.kind,
      relativePath: target.targetRelativePath,
      paperKey: target.paperKey,
      routeSlug: target.routeSlug,
    }
    const indexRecord = {
      shape: index.shape,
      entries: entriesForTarget(index, target),
    }
    const backupId = `bk-sha256-${sha256(stableJson({
      target: targetRecord,
      index: indexRecord,
      snapshotHash: inventory.snapshotHash,
    }))}`
    ensurePrivateDirectory(path.join(layout.libraryRoot, '.codex-paper'), layout.libraryRoot)
    ensurePrivateDirectory(layout.backupsRoot, path.join(layout.libraryRoot, '.codex-paper'))
    const finalDirectory = path.join(layout.backupsRoot, backupId)
    if (fs.existsSync(finalDirectory)) {
      try {
        const verified = verifyBackup(backupId, { libraryRoot: layout.libraryRoot })
        return { ...verified, reused: true }
      } catch {
        const quarantine = path.join(
          layout.backupsRoot,
          `.invalid-${backupId}-${crypto.randomBytes(8).toString('hex')}`,
        )
        fs.renameSync(finalDirectory, quarantine)
        fsyncDirectory(layout.backupsRoot)
      }
    }
    const initDirectory = path.join(layout.backupsRoot, `.init-${crypto.randomBytes(16).toString('hex')}`)
    fs.mkdirSync(initDirectory, { mode: 0o700 })
    try {
      const payloadDir = path.join(initDirectory, 'payload')
      fs.mkdirSync(payloadDir, { mode: 0o700 })
      copyInventory(target.targetDir, payloadDir, inventory)
      maybeFault(options, 'after_payload_copy')
      const afterCopy = inventoryTree(target.targetDir)
      if (!inventoryMatches(afterCopy, inventory)) {
        throw new LibraryMaintenanceError('BACKUP_SOURCE_CHANGED', 'Backup source changed while the snapshot was copied.', 409)
      }
      const manifestWithoutIntegrity = {
        schemaVersion: BACKUP_MANIFEST_VERSION,
        backupId,
        target: targetRecord,
        index: indexRecord,
        rootMode: inventory.rootMode,
        directories: inventory.directories,
        files: inventory.files,
        totalBytes: inventory.totalBytes,
        snapshotHash: inventory.snapshotHash,
        createdAt: options.now || new Date().toISOString(),
      }
      const manifest = {
        ...manifestWithoutIntegrity,
        integrity: { algorithm: 'sha256', value: sha256(stableJson(manifestWithoutIntegrity)) },
      }
      validateBackupManifest(manifest)
      const descriptor = fs.openSync(
        path.join(initDirectory, 'backup.json'),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      )
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fsyncDirectory(initDirectory)
      let reused = false
      try {
        fs.renameSync(initDirectory, finalDirectory)
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
        removeTreeForcingWritable(initDirectory)
        reused = true
      }
      fsyncDirectory(layout.backupsRoot)
      const verified = verifyBackup(backupId, { libraryRoot: layout.libraryRoot })
      return { ...verified, reused }
    } catch (error) {
      try { removeTreeForcingWritable(initDirectory) } catch {}
      throw error
    }
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

function indexWithRestoredEntry(index, manifest) {
  const saved = manifest.index.entries
  const retained = index.entries.filter((entry) => {
    if (manifest.target.kind === 'managed_paper') return entry?.storageKey !== manifest.target.paperKey
    return entry?.slug !== manifest.target.routeSlug
  })
  const savedSlugs = new Set(saved.map((entry) => entry?.slug).filter(Boolean))
  if (retained.some((entry) => savedSlugs.has(entry?.slug))) {
    throw new LibraryMaintenanceError('BACKUP_RESTORE_CONFLICT', 'The backup index route conflicts with another paper.', 409)
  }
  const entries = [...retained, ...saved].sort((a, b) => String(a?.slug || '').localeCompare(String(b?.slug || '')))
  if (index.shape === 'object' || (index.shape === 'missing' && manifest.index.shape === 'object')) {
    const base = index.shape === 'object' ? index.value : {}
    return { ...base, papers: entries }
  }
  return entries
}

function targetLockKeys(manifest) {
  return manifest.target.kind === 'managed_paper'
    ? ['registry', `paper:${manifest.target.paperKey}`, `backup:${manifest.backupId}`, 'index']
    : [`legacy:${manifest.target.routeSlug}`, `backup:${manifest.backupId}`, 'index']
}

function restoreJournalPath(layout, restoreId) {
  if (!RESTORE_ID_PATTERN.test(restoreId)) throw new LibraryMaintenanceError('RESTORE_ID_INVALID', 'Restore transaction ID is invalid.', 400)
  return path.join(layout.restoreTransactionsRoot, `${restoreId}.json`)
}

function writeRestoreJournal(layout, journal, lockHandle) {
  const filePath = restoreJournalPath(layout, journal.restoreId)
  atomicWriteJson({
    root: layout.restoreTransactionsRoot,
    relativePath: `${journal.restoreId}.json`,
    value: journal,
    lockHandle,
    requiredLock: `restore:${journal.restoreId}`,
    maxBytes: 1024 * 1024,
    ...fileWritePrecondition(filePath, 1024 * 1024),
  })
}

function validateRestoreJournal(journal) {
  if (journal?.schemaVersion !== RESTORE_TRANSACTION_VERSION
    || !RESTORE_ID_PATTERN.test(String(journal?.restoreId || ''))
    || !BACKUP_ID_PATTERN.test(String(journal?.backupId || ''))
    || !['prepared', 'target_restored', 'index_committed', 'failed'].includes(journal?.state)
    || !safeSegments(journal?.targetRelativePath)
    || !HASH_PATTERN.test(String(journal?.snapshotHash || ''))
    || Number.isNaN(Date.parse(journal?.createdAt)) || Number.isNaN(Date.parse(journal?.updatedAt))) {
    throw new LibraryMaintenanceError('RESTORE_TRANSACTION_INVALID', 'Restore transaction is invalid.', 422)
  }
  return assertSchema('restore', journal, 'RESTORE_TRANSACTION_INVALID')
}

function readRestoreJournal(filePath, label) {
  try {
    return validateRestoreJournal(readJsonNoFollow(filePath, label, 1024 * 1024))
  } catch (error) {
    if (error?.code === 'RESTORE_TRANSACTION_INVALID') throw error
    throw new LibraryMaintenanceError('RESTORE_TRANSACTION_INVALID', 'Restore transaction is unreadable or invalid.', 422)
  }
}

function existingRestoreJournal(layout, backupId) {
  if (!fs.existsSync(layout.restoreTransactionsRoot)) return null
  requireDirectory(layout.restoreTransactionsRoot, path.join(layout.libraryRoot, '.codex-paper'))
  const restoreId = `restore-${sha256(backupId).slice(0, 32)}`
  const journalPath = restoreJournalPath(layout, restoreId)
  if (!fs.existsSync(journalPath)) return null
  const journal = readRestoreJournal(journalPath, `${restoreId}.json`)
  if (journal.backupId !== backupId) {
    throw new LibraryMaintenanceError('RESTORE_TRANSACTION_INVALID', 'Restore transaction is bound to a different backup.', 422)
  }
  return journal.state === 'failed' ? null : journal
}

export async function restorePaperBackup(backupId, options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  const inspected = inspectBackup(backupId, { libraryRoot: layout.libraryRoot })
  verifyBackup(backupId, { libraryRoot: layout.libraryRoot })
  const manifest = inspected.manifest
  const restoreId = `restore-${sha256(backupId).slice(0, 32)}`
  const lockKeys = [...targetLockKeys(manifest), `restore:${restoreId}`]
  return withStorageLocks(lockKeys, async (lockHandle) => {
    const existing = existingRestoreJournal(layout, backupId)
    ensurePrivateDirectory(path.join(layout.libraryRoot, '.codex-paper'), layout.libraryRoot)
    ensurePrivateDirectory(layout.restoreTransactionsRoot, path.join(layout.libraryRoot, '.codex-paper'))
    ensurePrivateDirectory(layout.restoreStagingRoot, path.join(layout.libraryRoot, '.codex-paper'))
    const expectedParent = manifest.target.kind === 'managed_paper' ? layout.recordsRoot : layout.legacyPapersRoot
    const canonicalParent = requireDirectory(expectedParent, layout.libraryRoot)
    const targetName = manifest.target.relativePath.split('/').at(-1)
    const target = path.join(canonicalParent, targetName)
    if (path.posix.dirname(manifest.target.relativePath) !== relativePosix(layout.libraryRoot, canonicalParent)) {
      throw new LibraryMaintenanceError('BACKUP_BINDING_INVALID', 'Backup target is not a direct paper authority child.', 403)
    }
    const initiallyPresent = fs.existsSync(target)
    if (initiallyPresent) {
      const actual = inventoryTree(target)
      if (!inventoryMatchesManifest(actual, manifest)) {
        throw new LibraryMaintenanceError(
          'BACKUP_RESTORE_CONFLICT',
          'Restore target exists with different bytes or filesystem modes.',
          409,
        )
      }
    }
    let journal = existing || {
      schemaVersion: RESTORE_TRANSACTION_VERSION,
      restoreId,
      backupId,
      state: 'prepared',
      targetRelativePath: manifest.target.relativePath,
      snapshotHash: manifest.snapshotHash,
      createdAt: options.now || new Date().toISOString(),
      updatedAt: options.now || new Date().toISOString(),
    }
    if (!existing) writeRestoreJournal(layout, journal, lockHandle)
    let targetPresent = initiallyPresent
    let renamedThisAttempt = false
    if (!targetPresent) {
      const staging = path.join(layout.restoreStagingRoot, restoreId)
      if (fs.existsSync(staging)) {
        const staged = inventoryTree(staging)
        if (!inventoryMatchesManifest(staged, manifest)) {
          throw new LibraryMaintenanceError('RESTORE_TRANSACTION_INVALID', 'Restore staging content is invalid.', 422)
        }
      } else {
        fs.mkdirSync(staging, { mode: 0o700 })
        copyInventory(inspected.payloadDir, staging, {
          rootMode: manifest.rootMode,
          directories: manifest.directories,
          files: manifest.files,
        })
      }
      fs.renameSync(staging, target)
      fsyncDirectory(expectedParent)
      fsyncDirectory(layout.restoreStagingRoot)
      targetPresent = true
      renamedThisAttempt = true
      journal = { ...journal, state: 'target_restored', updatedAt: new Date().toISOString() }
      writeRestoreJournal(layout, journal, lockHandle)
    }
    try {
      const index = readIndex(layout)
      const targetEntries = entriesForTarget(index, {
        kind: manifest.target.kind,
        paperKey: manifest.target.paperKey,
        routeSlug: manifest.target.routeSlug,
      })
      const needsIndexWrite = renamedThisAttempt
        || existing?.state === 'target_restored'
        || targetEntries.length === 0
      if (needsIndexWrite) {
        const value = indexWithRestoredEntry(index, manifest)
        atomicWriteJson({
          root: layout.libraryRoot,
          relativePath: 'index.json',
          value,
          lockHandle,
          requiredLock: 'index',
          maxBytes: 64 * 1024 * 1024,
          ...fileWritePrecondition(layout.indexPath, 64 * 1024 * 1024),
        })
      }
    } catch (error) {
      if (renamedThisAttempt && targetPresent) {
        const rollback = path.join(layout.restoreStagingRoot, restoreId)
        try {
          fs.renameSync(target, rollback)
          fsyncDirectory(expectedParent)
          fsyncDirectory(layout.restoreStagingRoot)
        } catch (rollbackError) {
          error.rollbackError = rollbackError
        }
      }
      throw error
    }
    journal = { ...journal, state: 'index_committed', updatedAt: new Date().toISOString() }
    writeRestoreJournal(layout, journal, lockHandle)
    return {
      restored: true,
      alreadyPresent: initiallyPresent,
      backupId,
      restoreId,
      target: manifest.target,
    }
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export async function recoverBackupRestores(options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.restoreTransactionsRoot)) return { recovered: 0, failed: 0, transactions: [] }
  const transactions = []
  for (const entry of fs.readdirSync(layout.restoreTransactionsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const journal = readRestoreJournal(path.join(layout.restoreTransactionsRoot, entry.name), entry.name)
      if (journal.state === 'index_committed') continue
      const result = await restorePaperBackup(journal.backupId, options)
      transactions.push({ restoreId: journal.restoreId, success: true, result })
    } catch (error) {
      transactions.push({
        restoreId: entry.name.replace(/\.json$/, ''),
        success: false,
        code: error.code || 'BACKUP_RESTORE_FAILED',
        message: String(error.message).slice(0, 600),
      })
    }
  }
  return {
    recovered: transactions.filter((item) => item.success).length,
    failed: transactions.filter((item) => !item.success).length,
    transactions,
  }
}

function diagnostic(code, severity, message, relativePath = null) {
  return {
    code,
    severity,
    message: sanitizeText(message, 600),
    ...(relativePath ? { path: reportPath(relativePath) } : {}),
  }
}

function reportSegment(value) {
  const segment = String(value)
  if (segment !== '.' && segment !== '..' && segment.length <= 80
    && !/[\\/\u0000-\u001f\u007f]/.test(segment)) return segment
  const readable = segment
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 32)
  return `${readable || 'segment'}-encoded-${sha256(segment).slice(0, 32)}`
}

function reportPath(value) {
  const segments = String(value || 'unknown').replaceAll('\\', '/').split('/').filter(Boolean)
  return (segments.length > 0 ? segments : ['unknown']).map(reportSegment).join('/')
}

function reportId(value) {
  const normalized = sanitizeText(value, 900).replace(/[\\\u0000-\u001f\u007f]/g, '_')
  return normalized || `item-${sha256(String(value)).slice(0, 32)}`
}

function normalizeReportItem(item) {
  return {
    ...item,
    id: reportId(item.id),
    path: reportPath(item.path),
    diagnostics: item.diagnostics.map((entry) => diagnostic(
      entry.code,
      entry.severity,
      entry.message,
      entry.path,
    )),
  }
}

function indexEntryAuthority(entry) {
  if (PAPER_KEY_PATTERN.test(String(entry?.storageKey || ''))) {
    return {
      key: `managed:${entry.storageKey}`,
      path: `${STORE_RELATIVE_PATH}/papers/${entry.storageKey}`,
    }
  }
  if (typeof entry?.slug === 'string' && ROUTE_PATTERN.test(entry.slug)) {
    return { key: `legacy:${entry.slug}`, path: `papers/${entry.slug}` }
  }
  return {
    key: `invalid:${sha256(stableJson(entry))}`,
    path: 'index.json',
  }
}

function sourceDiagnosticAuthority(source) {
  if (PAPER_KEY_PATTERN.test(String(source?.paperKey || ''))) {
    return {
      key: `managed:${source.paperKey}`,
      path: `${STORE_RELATIVE_PATH}/papers/${source.paperKey}`,
    }
  }
  const rawPath = String(source?.path || '')
  const prefix = 'papers/'
  const slug = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : null
  if (slug && ROUTE_PATTERN.test(slug)) return { key: `legacy:${slug}`, path: rawPath }
  return { key: null, path: rawPath || 'papers' }
}

function groupedIndexEntries(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const authority = indexEntryAuthority(entry)
    const group = groups.get(authority.key) || { path: authority.path, entries: [] }
    group.entries.push(entry)
    groups.set(authority.key, group)
  }
  for (const group of groups.values()) {
    group.entries.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  }
  return groups
}

function scanSignature(layout) {
  const roots = [
    layout.indexPath,
    layout.legacyPapersRoot,
    layout.recordsRoot,
    layout.workspacesRoot,
    layout.backupsRoot,
    layout.restoreTransactionsRoot,
    layout.restoreStagingRoot,
    path.join(layout.libraryRoot, MIGRATION_TRANSACTIONS_RELATIVE_PATH),
    path.join(layout.libraryRoot, MIGRATION_ARCHIVES_RELATIVE_PATH),
  ]
  const values = []
  function walk(target, depth = 0) {
    if (depth > 8 || !fs.existsSync(target)) return
    let stats
    try { stats = fs.lstatSync(target) } catch {
      values.push(['scan-race', 0, 0, 0])
      return
    }
    const relativePath = path.relative(layout.libraryRoot, target).split(path.sep).join('/')
    values.push([relativePath || '.', stats.mode & 0o170000, stats.size, stats.mtimeMs])
    if (!stats.isDirectory() || stats.isSymbolicLink()) return
    for (const entry of fs.readdirSync(target).sort()) {
      if (target === layout.backupsRoot && BACKUP_ID_PATTERN.test(entry)) {
        walk(path.join(target, entry, 'backup.json'), depth + 1)
      } else {
        walk(path.join(target, entry), depth + 1)
      }
    }
  }
  for (const root of roots) walk(root)
  return sha256(stableJson(values.sort((a, b) => a[0].localeCompare(b[0]))))
}

export function packageVersions(packageDir) {
  const compatibility = compatibilityForPackage(packageDir)
  const identityPath = path.join(packageDir, '.codex-paper/paper-identity.json')
  const manifestPath = path.join(packageDir, '.codex-paper/generation-manifest.json')
  let identityVersion = null
  let manifestVersion = null
  if (fs.existsSync(identityPath)) {
    try { identityVersion = readPaperIdentity(identityPath).schemaVersion } catch { identityVersion = 'invalid' }
  }
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileNoFollowBounded(manifestPath, 8 * 1024 * 1024))
      manifestVersion = manifest?.schemaVersion || 'invalid'
    } catch { manifestVersion = 'invalid' }
  }
  return { compatibility, identityVersion, manifestVersion }
}

function managedGenerationPackages(recordDir) {
  const sourcesRoot = path.join(recordDir, 'sources')
  if (!fs.existsSync(sourcesRoot)) return []
  requireDirectory(sourcesRoot, recordDir)
  const packages = []
  for (const source of fs.readdirSync(sourcesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(sourcesRoot, source.name)
    if (source.isSymbolicLink() || !source.isDirectory() || !/^sha256-[a-f0-9]{64}$/.test(source.name)) {
      throw new LibraryMaintenanceError('SOURCE_RECORD_INVALID', 'Managed source registry contains an unsafe entry.', 403)
    }
    const generationsRoot = path.join(sourcePath, 'generations')
    if (!fs.existsSync(generationsRoot)) continue
    requireDirectory(generationsRoot, sourcePath)
    for (const generation of fs.readdirSync(generationsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (generation.name.startsWith('.publish-')) continue
      if (generation.isSymbolicLink() || !generation.isDirectory() || !/^gen-sha256-[a-f0-9]{64}$/.test(generation.name)) {
        throw new LibraryMaintenanceError('MANAGED_GENERATION_INVALID', 'Managed generation registry contains an unsafe entry.', 403)
      }
      const generationDir = path.join(generationsRoot, generation.name)
      const packageDir = path.join(generationDir, 'package')
      requireDirectory(packageDir, generationDir, 'MANAGED_GENERATION_INVALID')
      packages.push({
        id: generation.name.replace(/^gen-sha256-/, 'gen:sha256:'),
        packageDir,
      })
    }
  }
  return packages
}

export function inspectLibrary(options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  if (!fs.existsSync(layout.libraryRoot)) throw new LibraryMaintenanceError('LIBRARY_NOT_FOUND', 'Paper library does not exist.', 404)
  requireDirectory(layout.libraryRoot)
  const before = scanSignature(layout)
  const items = []
  const diagnostics = []
  let migrationArchiveBytes = 0

  if (fs.existsSync(layout.legacyPapersRoot)) {
    try {
      requireDirectory(layout.legacyPapersRoot, layout.libraryRoot)
      for (const entry of fs.readdirSync(layout.legacyPapersRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `papers/${entry.name}`
        if (entry.isFile() && !entry.isSymbolicLink()
          && (['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'].includes(entry.name)
            || entry.name.startsWith('._'))) continue
        if (entry.isSymbolicLink() || !entry.isDirectory() || !ROUTE_PATTERN.test(entry.name)) {
          diagnostics.push(diagnostic('LEGACY_PACKAGE_INVALID', 'error', 'Legacy registry contains an unsafe entry.', itemPath))
          continue
        }
        try {
          const versions = packageVersions(path.join(layout.legacyPapersRoot, entry.name))
          const itemDiagnostics = versions.compatibility.diagnostics.map((item) => diagnostic(item.code, 'warning', item.message, itemPath))
          items.push({
            kind: 'legacy_package',
            id: entry.name,
            path: itemPath,
            state: versions.compatibility.mode === 'unknown_read_only' ? 'read_only_with_warnings' : 'read_only',
            compatibility: {
              mode: versions.compatibility.mode,
              packageVersion: versions.compatibility.packageVersion,
              identityVersion: versions.identityVersion,
              manifestVersion: versions.manifestVersion,
            },
            diagnostics: itemDiagnostics,
          })
          diagnostics.push(...itemDiagnostics)
        } catch (error) {
          const itemDiagnostic = diagnostic(error.code || 'LEGACY_PACKAGE_INVALID', 'error', error.message, itemPath)
          items.push({ kind: 'legacy_package', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'LEGACY_REGISTRY_INVALID', 'error', error.message, 'papers'))
    }
  }

  if (fs.existsSync(layout.recordsRoot)) {
    try {
      requireDirectory(layout.recordsRoot, layout.storeRoot)
      for (const entry of fs.readdirSync(layout.recordsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.publish-')) {
          const itemDiagnostic = diagnostic('PUBLICATION_RECOVERY_PENDING', 'warning', 'Publication staging residue requires recovery.', `${relativePosix(layout.libraryRoot, layout.recordsRoot)}/${entry.name}`)
          items.push({ kind: 'managed_paper', id: entry.name, path: itemDiagnostic.path, state: 'recoverable', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
          continue
        }
        const itemPath = `${relativePosix(layout.libraryRoot, layout.recordsRoot)}/${entry.name}`
        if (entry.isSymbolicLink() || !entry.isDirectory() || !PAPER_KEY_PATTERN.test(entry.name)) {
          diagnostics.push(diagnostic('PAPER_RECORD_INVALID', 'error', 'Managed registry contains an unsafe entry.', itemPath))
          continue
        }
        let paperItem = null
        try {
          const descriptor = resolveLibraryPaper(entry.name, { libraryRoot: layout.libraryRoot })
          paperItem = {
            kind: 'managed_paper',
            id: entry.name,
            path: itemPath,
            state: 'current',
            diagnostics: [],
          }
          items.push(paperItem)
          const generationPackages = managedGenerationPackages(descriptor.paperRoot)
          for (const generation of generationPackages) {
            const generationPath = relativePosix(layout.libraryRoot, generation.packageDir)
            const itemDiagnostics = []
            let versions
            try {
              versions = packageVersions(generation.packageDir)
              verifyGenerationManifest(generation.packageDir)
            } catch (error) {
              itemDiagnostics.push(diagnostic(
                error.code || 'GENERATION_MANIFEST_INVALID',
                'error',
                error.message,
                generationPath,
              ))
            }
            items.push({
              kind: 'managed_generation',
              id: generation.id,
              path: generationPath,
              state: generation.packageDir === descriptor.packageDir ? 'current' : 'archived',
              ...(versions ? {
                compatibility: {
                  mode: versions.compatibility.mode,
                  packageVersion: versions.compatibility.packageVersion,
                  identityVersion: versions.identityVersion,
                  manifestVersion: versions.manifestVersion,
                },
              } : {}),
              diagnostics: itemDiagnostics,
            })
            diagnostics.push(...itemDiagnostics)
          }
          if (!generationPackages.some((generation) => generation.packageDir === descriptor.packageDir)) {
            const itemDiagnostic = diagnostic(
              'CURRENT_GENERATION_UNINVENTORIED',
              'error',
              'Current generation is not present in the managed generation registry.',
              itemPath,
            )
            paperItem.diagnostics.push(itemDiagnostic)
            diagnostics.push(itemDiagnostic)
          }
          if (fs.existsSync(descriptor.overlayDir)) {
            try {
              const statePath = path.join(descriptor.overlayDir, 'state.json')
              const state = fs.existsSync(statePath) ? readJsonNoFollow(statePath, 'state.json') : {
                schemaVersion: '1.0.0', tags: [], progress: {}, annotations: [],
              }
              if (state?.schemaVersion !== '1.0.0' || !Array.isArray(state.tags)
                || !state.progress || typeof state.progress !== 'object' || !Array.isArray(state.annotations)) {
                throw new LibraryMaintenanceError('OVERLAY_STATE_INVALID', 'Paper overlay state is invalid.', 422)
              }
              items.push({
                kind: 'overlay',
                id: entry.name,
                path: relativePosix(layout.libraryRoot, descriptor.overlayDir),
                state: 'mutable',
                diagnostics: [],
              })
            } catch (error) {
              const overlayPath = relativePosix(layout.libraryRoot, descriptor.overlayDir)
              const itemDiagnostic = diagnostic(error.code || 'OVERLAY_STATE_INVALID', 'error', error.message, overlayPath)
              items.push({ kind: 'overlay', id: entry.name, path: overlayPath, state: 'invalid', diagnostics: [itemDiagnostic] })
              diagnostics.push(itemDiagnostic)
            }
          }
        } catch (error) {
          const itemDiagnostic = diagnostic(error.code || 'PAPER_RECORD_INVALID', 'error', error.message, itemPath)
          if (paperItem) {
            paperItem.state = 'invalid'
            paperItem.diagnostics.push(itemDiagnostic)
          } else {
            items.push({ kind: 'managed_paper', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          }
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'PAPER_REGISTRY_INVALID', 'error', error.message, `${STORE_RELATIVE_PATH}/papers`))
    }
  }

  if (fs.existsSync(layout.workspacesRoot)) {
    try {
      requireDirectory(layout.workspacesRoot, path.join(layout.libraryRoot, '.codex-paper'))
      for (const entry of fs.readdirSync(layout.workspacesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `${relativePosix(layout.libraryRoot, layout.workspacesRoot)}/${entry.name}`
        if (entry.name.startsWith('.init-')) {
          const itemDiagnostic = diagnostic('WORKSPACE_INITIALIZATION_RESIDUE', 'warning', 'Workspace initialization residue is present.', itemPath)
          items.push({ kind: 'workspace', id: entry.name, path: itemPath, state: 'initialization_residue', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
          continue
        }
        try {
          const workspace = readJsonNoFollow(path.join(layout.workspacesRoot, entry.name, 'workspace.json'), 'workspace.json', 1024 * 1024)
          items.push({ kind: 'workspace', id: workspace.workspaceId || entry.name, path: itemPath, state: workspace.state || 'invalid', diagnostics: [] })
        } catch (error) {
          const itemDiagnostic = diagnostic(error.code || 'WORKSPACE_RECORD_INVALID', 'error', error.message, itemPath)
          items.push({ kind: 'workspace', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'WORKSPACE_REGISTRY_INVALID', 'error', error.message, WORKSPACES_RELATIVE_PATH))
    }
  }

  try {
    for (const backup of listBackups({
      libraryRoot: layout.libraryRoot,
      verifyPayloads: options.verifyBackupPayloads !== false,
    })) {
      const itemDiagnostics = backup.state === 'complete' ? [] : [
        diagnostic(
          backup.state === 'initialization_residue'
            ? 'BACKUP_INITIALIZATION_RESIDUE'
            : backup.state === 'quarantined'
              ? 'BACKUP_QUARANTINED'
              : (backup.diagnostic?.code || 'BACKUP_INVALID'),
          ['initialization_residue', 'quarantined'].includes(backup.state) ? 'warning' : 'error',
          backup.diagnostic?.message || (backup.state === 'quarantined'
            ? 'A corrupt backup snapshot was retained in quarantine.'
            : 'Backup registry contains an incomplete or invalid entry.'),
          backup.relativePath,
        ),
      ]
      items.push({
        kind: 'backup',
        id: backup.backupId || backup.relativePath,
        path: backup.relativePath || `${BACKUPS_RELATIVE_PATH}/${backup.backupId}`,
        state: backup.state,
        diagnostics: itemDiagnostics,
      })
      diagnostics.push(...itemDiagnostics)
    }
  } catch (error) {
    diagnostics.push(diagnostic(error.code || 'BACKUP_REGISTRY_INVALID', 'error', error.message, BACKUPS_RELATIVE_PATH))
  }

  if (fs.existsSync(layout.restoreTransactionsRoot)) {
    try {
      requireDirectory(layout.restoreTransactionsRoot, path.join(layout.libraryRoot, '.codex-paper'))
      for (const entry of fs.readdirSync(layout.restoreTransactionsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `${RESTORE_TRANSACTIONS_RELATIVE_PATH}/${entry.name}`
        try {
          if (entry.isSymbolicLink() || !entry.isFile()) throw new LibraryMaintenanceError('RESTORE_TRANSACTION_INVALID', 'Restore transaction registry contains an unsafe entry.', 403)
          const journal = readRestoreJournal(path.join(layout.restoreTransactionsRoot, entry.name), entry.name)
          const pending = journal.state !== 'index_committed'
          const itemDiagnostics = pending ? [diagnostic('RESTORE_RECOVERY_PENDING', 'warning', 'Restore transaction requires recovery.', itemPath)] : []
          items.push({ kind: 'restore_transaction', id: journal.restoreId, path: itemPath, state: journal.state, diagnostics: itemDiagnostics })
          diagnostics.push(...itemDiagnostics)
        } catch (error) {
          const itemDiagnostic = diagnostic(error.code || 'RESTORE_TRANSACTION_INVALID', 'error', error.message, itemPath)
          items.push({ kind: 'restore_transaction', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'RESTORE_REGISTRY_INVALID', 'error', error.message, RESTORE_TRANSACTIONS_RELATIVE_PATH))
    }
  }

  if (fs.existsSync(layout.restoreStagingRoot)) {
    try {
      requireDirectory(layout.restoreStagingRoot, path.join(layout.libraryRoot, '.codex-paper'))
      for (const entry of fs.readdirSync(layout.restoreStagingRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `${RESTORE_STAGING_RELATIVE_PATH}/${entry.name}`
        const valid = !entry.isSymbolicLink() && entry.isDirectory() && RESTORE_ID_PATTERN.test(entry.name)
        const itemDiagnostic = diagnostic(
          valid ? 'RESTORE_RECOVERY_PENDING' : 'RESTORE_STAGING_INVALID',
          valid ? 'warning' : 'error',
          valid ? 'Private restore staging requires recovery.' : 'Restore staging contains an unsafe entry.',
          itemPath,
        )
        items.push({ kind: 'restore_transaction', id: entry.name, path: itemPath, state: valid ? 'staged' : 'invalid', diagnostics: [itemDiagnostic] })
        diagnostics.push(itemDiagnostic)
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'RESTORE_STAGING_INVALID', 'error', error.message, RESTORE_STAGING_RELATIVE_PATH))
    }
  }

  const migrationTransactionsRoot = path.join(layout.libraryRoot, MIGRATION_TRANSACTIONS_RELATIVE_PATH)
  if (fs.existsSync(migrationTransactionsRoot)) {
    try {
      requireDirectory(migrationTransactionsRoot, path.join(layout.libraryRoot, '.codex-paper'))
      for (const entry of fs.readdirSync(migrationTransactionsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `${MIGRATION_TRANSACTIONS_RELATIVE_PATH}/${entry.name}`
        try {
          if (entry.isSymbolicLink() || !entry.isFile() || !/^mig-sha256-[a-f0-9]{64}\.json$/.test(entry.name)) {
            throw new LibraryMaintenanceError('MIGRATION_TRANSACTION_INVALID', 'Migration transaction registry contains an unsafe entry.', 403)
          }
          const transactionValue = readJsonNoFollow(path.join(migrationTransactionsRoot, entry.name), 'migration transaction', 4 * 1024 * 1024)
          if (transactionValue?.schemaVersion !== '1.0.0') {
            const itemDiagnostic = diagnostic(
              'MIGRATION_TRANSACTION_UNSUPPORTED',
              'warning',
              'Migration transaction version is newer or unsupported; use a compatible plugin to inspect it.',
              itemPath,
            )
            items.push({ kind: 'migration_transaction', id: entry.name.slice(0, -5), path: itemPath, state: 'unsupported', diagnostics: [itemDiagnostic] })
            diagnostics.push(itemDiagnostic)
            continue
          }
          const transaction = assertSchema('migrationTransaction', transactionValue, 'MIGRATION_TRANSACTION_INVALID')
          const terminal = ['committed', 'rolled_back'].includes(transaction.state)
          const itemDiagnostics = terminal ? [] : [diagnostic(
            'MIGRATION_RECOVERY_PENDING',
            'warning',
            'Migration transaction requires recovery.',
            itemPath,
          )]
          items.push({ kind: 'migration_transaction', id: transaction.migrationId, path: itemPath, state: transaction.state, diagnostics: itemDiagnostics })
          diagnostics.push(...itemDiagnostics)
        } catch (error) {
          const itemDiagnostic = diagnostic(
            error.code === 'LIBRARY_RECORD_INVALID' ? 'MIGRATION_TRANSACTION_INVALID' : (error.code || 'MIGRATION_TRANSACTION_INVALID'),
            'error',
            error.message,
            itemPath,
          )
          items.push({ kind: 'migration_transaction', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'MIGRATION_TRANSACTION_REGISTRY_INVALID', 'error', error.message, MIGRATION_TRANSACTIONS_RELATIVE_PATH))
    }
  }

  const migrationArchivesRoot = path.join(layout.libraryRoot, MIGRATION_ARCHIVES_RELATIVE_PATH)
  if (fs.existsSync(migrationArchivesRoot)) {
    try {
      requireDirectory(migrationArchivesRoot, path.join(layout.libraryRoot, '.codex-paper'))
      for (const entry of fs.readdirSync(migrationArchivesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const itemPath = `${MIGRATION_ARCHIVES_RELATIVE_PATH}/${entry.name}`
        try {
          if (entry.isSymbolicLink() || !entry.isDirectory() || !/^mig-sha256-[a-f0-9]{64}$/.test(entry.name)) {
            throw new LibraryMaintenanceError('MIGRATION_ARCHIVE_INVALID', 'Migration archive registry contains an unsafe entry.', 403)
          }
          const inventory = inventoryTree(path.join(migrationArchivesRoot, entry.name))
          migrationArchiveBytes += inventory.totalBytes
          items.push({ kind: 'migration_archive', id: entry.name, path: itemPath, state: 'retained', diagnostics: [] })
        } catch (error) {
          const itemDiagnostic = diagnostic(error.code || 'MIGRATION_ARCHIVE_INVALID', 'error', error.message, itemPath)
          items.push({ kind: 'migration_archive', id: entry.name, path: itemPath, state: 'invalid', diagnostics: [itemDiagnostic] })
          diagnostics.push(itemDiagnostic)
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(error.code || 'MIGRATION_ARCHIVE_REGISTRY_INVALID', 'error', error.message, MIGRATION_ARCHIVES_RELATIVE_PATH))
    }
  }

  try {
    const actual = readIndex(layout)
    const sourceDiagnostics = []
    const expectedEntries = buildLibraryIndexEntries(layout.libraryRoot, {
      strict: false,
      diagnostics: sourceDiagnostics,
    })
    const unprojectedKeys = new Set()
    for (const source of sourceDiagnostics) {
      const authority = sourceDiagnosticAuthority(source)
      if (authority.key) unprojectedKeys.add(authority.key)
      diagnostics.push(diagnostic(
        source.code || 'LIBRARY_INDEX_SOURCE_INVALID',
        'error',
        source.message || 'A library record could not be projected into the index.',
        authority.path,
      ))
      if (authority.key) {
        diagnostics.push(diagnostic(
          'LIBRARY_INDEX_DRIFT_UNDETERMINED',
          'error',
          'Index drift cannot be determined for a source that failed authoritative projection.',
          authority.path,
        ))
      }
    }
    const expectedGroups = groupedIndexEntries(expectedEntries)
    const actualGroups = groupedIndexEntries(actual.entries)
    const keys = new Set([...expectedGroups.keys(), ...actualGroups.keys()])
    for (const key of [...keys].sort()) {
      if (unprojectedKeys.has(key)) continue
      const expected = expectedGroups.get(key)
      const observed = actualGroups.get(key)
      if (stableJson(expected?.entries || []) !== stableJson(observed?.entries || [])) {
        diagnostics.push(diagnostic(
          'LIBRARY_INDEX_DRIFT',
          'error',
          'Library index differs from the authoritative paper record.',
          expected?.path || observed?.path || 'index.json',
        ))
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(error.code || 'LIBRARY_INDEX_INVALID', 'error', error.message, 'index.json'))
  }

  const after = scanSignature(layout)
  if (before !== after) diagnostics.push(diagnostic('LIBRARY_SCAN_UNSTABLE', 'warning', 'Library changed during the read-only scan; retry for a stable result.'))
  const normalizedItems = items.map(normalizeReportItem)
  const normalizedDiagnostics = diagnostics.map((item) => diagnostic(
    item.code,
    item.severity,
    item.message,
    item.path,
  ))
  const severity = normalizedDiagnostics.some((item) => item.severity === 'error')
    ? 'errors'
    : normalizedDiagnostics.length > 0
      ? 'warnings'
      : 'healthy'
  const summary = {
    total: normalizedItems.length,
    legacyPackages: normalizedItems.filter((item) => item.kind === 'legacy_package').length,
    managedPapers: normalizedItems.filter((item) => item.kind === 'managed_paper').length,
    managedGenerations: normalizedItems.filter((item) => item.kind === 'managed_generation').length,
    overlays: normalizedItems.filter((item) => item.kind === 'overlay').length,
    workspaces: normalizedItems.filter((item) => item.kind === 'workspace').length,
    backups: normalizedItems.filter((item) => item.kind === 'backup').length,
    pendingRestores: normalizedItems.filter((item) => item.kind === 'restore_transaction' && item.state !== 'index_committed').length,
    migrationTransactions: normalizedItems.filter((item) => item.kind === 'migration_transaction').length,
    pendingMigrations: normalizedItems.filter((item) => item.kind === 'migration_transaction' && !['committed', 'rolled_back'].includes(item.state)).length,
    migrationArchives: normalizedItems.filter((item) => item.kind === 'migration_archive').length,
    migrationArchiveBytes,
    errors: normalizedDiagnostics.filter((item) => item.severity === 'error').length,
    warnings: normalizedDiagnostics.filter((item) => item.severity === 'warning').length,
  }
  const intrinsic = {
    schemaVersion: DOCTOR_REPORT_VERSION,
    status: severity,
    layoutVersion: '1.0.0',
    payloadsVerified: options.verifyBackupPayloads !== false,
    summary,
    items: normalizedItems,
    diagnostics: normalizedDiagnostics,
  }
  return assertSchema('doctor', {
    ...intrinsic,
    generatedAt: options.now || new Date().toISOString(),
    inventoryHash: sha256(stableJson(intrinsic)),
  }, 'DOCTOR_REPORT_INVALID')
}

export function buildMigrationPlan(input, options = {}) {
  const layout = getLibraryLayout(options.libraryRoot)
  const target = structuralTarget(input, layout.libraryRoot)
  let descriptor = null
  let resolutionError = null
  try {
    descriptor = descriptorForMigrationTarget(target, layout.libraryRoot)
  } catch (error) {
    resolutionError = error
  }
  const versions = descriptor
    ? packageVersions(descriptor.packageDir)
    : {
        compatibility: {
          mode: 'unknown_read_only',
          packageVersion: null,
          diagnostics: [{
            code: resolutionError?.code || 'MIGRATION_SOURCE_INVALID',
            message: 'The migration source authority cannot be resolved safely.',
          }],
        },
        identityVersion: 'invalid',
        manifestVersion: 'invalid',
      }
  const doctorReport = inspectLibrary({
    libraryRoot: layout.libraryRoot,
    now: options.now,
    verifyBackupPayloads: false,
  })
  const targetReportPath = reportPath(target.targetRelativePath)
  const doctorBlockers = doctorReport.diagnostics.filter((item) => {
    if (item.code === 'LIBRARY_SCAN_UNSTABLE') return true
    if (item.severity !== 'error') return false
    if (!item.path || item.path === 'index.json') return true
    return item.path === targetReportPath || item.path.startsWith(`${targetReportPath}/`)
  })
  let manifestVerified = false
  if (descriptor && versions.manifestVersion && versions.manifestVersion !== 'invalid') {
    try {
      verifyGenerationManifest(descriptor.packageDir)
      manifestVerified = true
    } catch {}
  }
  const alreadyCurrent = versions.compatibility.mode === 'native_2_1'
    && versions.identityVersion === '2.0.0'
    && versions.manifestVersion === '2.0.0'
    && manifestVerified
  const live = migrationSourceSnapshot(target.targetDir, target.kind)
  let backup = alreadyCurrent
    ? { required: false, status: 'not_required', backupId: null }
    : { required: true, status: 'missing', backupId: null }
  let backupBlocker = null
  if (options.backupId && !alreadyCurrent) {
    if (!BACKUP_ID_PATTERN.test(options.backupId)) {
      throw new LibraryMaintenanceError('BACKUP_ID_INVALID', 'Backup ID is invalid.', 400)
    }
    try {
      const inspected = inspectBackup(options.backupId, { libraryRoot: layout.libraryRoot })
      verifyBackup(options.backupId, { libraryRoot: layout.libraryRoot })
      const sameTarget = inspected.manifest.target.relativePath === target.targetRelativePath
      backup = {
        required: true,
        status: sameTarget
          && migrationSourceSnapshot(inspected.payloadDir, target.kind).snapshotHash === live.snapshotHash
          ? 'verified'
          : 'stale',
        backupId: options.backupId,
      }
    } catch (error) {
      const status = error?.statusCode === 404 ? 'not_found' : 'invalid'
      backup = { required: true, status, backupId: options.backupId }
      backupBlocker = {
        code: status === 'not_found' ? 'MIGRATION_BACKUP_NOT_FOUND' : 'MIGRATION_BACKUP_INVALID',
        severity: 'error',
        message: status === 'not_found'
          ? 'The selected backup does not exist.'
          : 'The selected backup failed integrity or schema verification.',
      }
    }
  }
  const blockers = []
  blockers.push(...doctorBlockers)
  if (resolutionError && !doctorBlockers.some((item) => item.code === resolutionError.code)) {
    blockers.push(diagnostic(
      resolutionError.code || 'MIGRATION_SOURCE_INVALID',
      'error',
      'The migration source authority cannot be resolved safely.',
      target.targetRelativePath,
    ))
  }
  if (versions.compatibility.mode === 'unknown_read_only') {
    blockers.push(...versions.compatibility.diagnostics.map((item) => diagnostic(
      item.code || 'PACKAGE_VERSION_UNSUPPORTED',
      'error',
      item.message || 'The package version is unsupported.',
      target.targetRelativePath,
    )))
  }
  if (!alreadyCurrent && backupBlocker) blockers.push(backupBlocker)
  else if (!alreadyCurrent && backup.status !== 'verified') {
    blockers.push({
      code: backup.status === 'missing' ? 'MIGRATION_BACKUP_REQUIRED' : 'MIGRATION_BACKUP_STALE',
      severity: 'error',
      message: backup.status === 'missing'
        ? 'Create and verify a target-scoped backup before migration.'
        : 'The selected backup no longer matches the current paper state.',
    })
  }
  const policy = {
    ...MIGRATION_POLICY,
    sha256: sha256(stableJson(MIGRATION_POLICY)),
  }
  if (alreadyCurrent) {
    blockers.push({
      code: 'MIGRATION_NOT_REQUIRED',
      severity: 'warning',
      message: 'The current generation already satisfies the migration target contract.',
    })
  }
  const intrinsic = {
    target: {
      kind: target.kind,
      relativePath: target.targetRelativePath,
      paperKey: target.paperKey,
      routeSlug: target.routeSlug,
    },
    source: {
      layoutMode: target.kind,
      compatibilityMode: versions.compatibility.mode,
      packageVersion: versions.compatibility.packageVersion,
      identityVersion: versions.identityVersion,
      manifestVersion: versions.manifestVersion,
      manifestVerified,
      snapshotHash: live.snapshotHash,
    },
    backup,
    targetContract: {
      packageVersion: '2.1.0',
      identityVersion: '2.0.0',
      generationManifestVersion: '2.0.0',
      generationContractVersion: '2.0.0',
    },
    policy,
  }
  const blocking = blockers.some((item) => item.severity === 'error')
  const planId = `mp-sha256-${sha256(stableJson(intrinsic))}`
  return assertSchema('migration', {
    schemaVersion: MIGRATION_PLAN_VERSION,
    planId,
    target: intrinsic.target,
    source: intrinsic.source,
    doctor: {
      status: doctorReport.status,
      payloadsVerified: doctorReport.payloadsVerified,
      inventoryHash: doctorReport.inventoryHash,
      blockers: doctorBlockers,
    },
    backup: intrinsic.backup,
    targetContract: intrinsic.targetContract,
    policy,
    actions: [
      'verify_backup',
      'create_generation_workspace',
      'translate_evidence_aliases',
      'author_and_validate_new_generation',
      'publish_with_manifest_2_0',
      'switch_current_and_rebuild_index',
      'retain_previous_generation_for_rollback',
    ],
    eligibility: alreadyCurrent ? 'not_required' : (blocking ? 'blocked' : 'ready'),
    executionAvailable: !alreadyCurrent && !blocking,
    diagnostics: blockers,
  }, 'MIGRATION_PLAN_INVALID')
}
