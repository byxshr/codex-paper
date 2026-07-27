import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readFileNoFollowBounded } from './storage-transaction.mjs'

export const GENERATION_MANIFEST_VERSION = '1.0.0'
export const GENERATION_MANIFEST_RELATIVE_PATH = '.codex-paper/generation-manifest.json'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MANIFEST_ID_PATTERN = /^gm-sha256-[a-f0-9]{64}$/
const TRANSACTION_ID_PATTERN = /^pub-[a-f0-9]{32}$/
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_DEPTH = 16

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeSegments(relativePath) {
  return typeof relativePath === 'string' && relativePath && !path.posix.isAbsolute(relativePath)
    && !relativePath.includes('\\') && !relativePath.split('/').some((item) => !item || item === '.' || item === '..')
}

export function inventoryGenerationFiles(packageDir) {
  const rootStats = fs.lstatSync(packageDir)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw Object.assign(new Error('Generation package must be a non-symlink directory.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  const files = []
  function walk(current, relative = '', depth = 0) {
    if (depth > MAX_DEPTH) throw Object.assign(new Error('Generation package exceeds the manifest depth budget.'), { code: 'GENERATION_MANIFEST_LIMIT_EXCEEDED', statusCode: 413 })
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : (left.name > right.name ? 1 : 0))) {
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name
      const itemPath = path.join(current, entry.name)
      if (!safeSegments(itemRelative)) throw Object.assign(new Error('Generation package contains an unsafe path.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
      if (entry.isSymbolicLink()) throw Object.assign(new Error('Generation package symlinks are forbidden.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
      if (entry.isDirectory()) { walk(itemPath, itemRelative, depth + 1); continue }
      if (!entry.isFile()) throw Object.assign(new Error('Generation package special files are forbidden.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
      if (itemRelative === GENERATION_MANIFEST_RELATIVE_PATH) continue
      const bytes = readFileNoFollowBounded(itemPath, MAX_FILE_BYTES)
      files.push({ path: itemRelative, sha256: sha256(bytes), bytes: bytes.length })
      if (files.length > MAX_FILES) throw Object.assign(new Error('Generation package exceeds the manifest file budget.'), { code: 'GENERATION_MANIFEST_LIMIT_EXCEEDED', statusCode: 413 })
    }
  }
  walk(packageDir)
  return files.sort((left, right) => left.path < right.path ? -1 : (left.path > right.path ? 1 : 0))
}

export function deriveManifestId({ paperKey, generationId, validationReportHash }) {
  return `gm-sha256-${sha256(stableJson({ paperKey, generationId, validationReportHash }))}`
}

function manifestIntrinsic(manifest) {
  const { manifestHash, ...intrinsic } = manifest
  return intrinsic
}

export function buildGenerationManifest({ packageDir, transactionId, paperKey, identity, validationReport, sealedAt = new Date().toISOString() }) {
  const validationReportHash = validationReport?.reportHash?.value
  const manifestId = deriveManifestId({ paperKey, generationId: identity?.generationId, validationReportHash })
  const intrinsic = {
    schemaVersion: GENERATION_MANIFEST_VERSION,
    manifestId,
    transactionState: 'sealed',
    transactionId,
    paperKey,
    paperId: identity?.paperId,
    sourceRevisionId: identity?.sourceRevisionId,
    generationId: identity?.generationId,
    sourceSha256: identity?.source?.sha256,
    generationFingerprint: identity?.generation?.fingerprint?.value,
    validation: {
      schemaVersion: validationReport?.schemaVersion,
      status: validationReport?.status,
      reportHash: validationReportHash,
    },
    sealedAt,
    files: inventoryGenerationFiles(packageDir),
  }
  const manifest = { ...intrinsic, manifestHash: sha256(stableJson(intrinsic)) }
  return validateGenerationManifest(manifest)
}

export function validateGenerationManifest(manifest) {
  const files = manifest?.files
  if (manifest?.schemaVersion !== GENERATION_MANIFEST_VERSION
    || !MANIFEST_ID_PATTERN.test(String(manifest?.manifestId || ''))
    || manifest?.transactionState !== 'sealed'
    || !TRANSACTION_ID_PATTERN.test(String(manifest?.transactionId || ''))
    || !/^p-[a-f0-9]{64}$/.test(String(manifest?.paperKey || ''))
    || typeof manifest?.paperId !== 'string' || !manifest.paperId
    || !/^sha256:[a-f0-9]{64}$/.test(String(manifest?.sourceRevisionId || ''))
    || !/^gen:sha256:[a-f0-9]{64}$/.test(String(manifest?.generationId || ''))
    || !HASH_PATTERN.test(String(manifest?.sourceSha256 || ''))
    || !HASH_PATTERN.test(String(manifest?.generationFingerprint || ''))
    || manifest?.validation?.schemaVersion !== '1.0.0'
    || !['pass', 'pass_with_warnings'].includes(manifest?.validation?.status)
    || !HASH_PATTERN.test(String(manifest?.validation?.reportHash || ''))
    || Number.isNaN(Date.parse(manifest?.sealedAt))
    || !Array.isArray(files) || files.length < 1 || files.length > MAX_FILES
    || files.some((item) => !safeSegments(item?.path) || item.path.length > 512 || item.path === GENERATION_MANIFEST_RELATIVE_PATH || !HASH_PATTERN.test(String(item?.sha256 || '')) || !Number.isInteger(item?.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES)
    || new Set(files.map((item) => item.path)).size !== files.length
    || JSON.stringify(files.map((item) => item.path)) !== JSON.stringify(files.map((item) => item.path).sort())
    || !HASH_PATTERN.test(String(manifest?.manifestHash || ''))
    || sha256(stableJson(manifestIntrinsic(manifest))) !== manifest.manifestHash) {
    throw Object.assign(new Error('Generation manifest is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const expectedId = deriveManifestId({ paperKey: manifest.paperKey, generationId: manifest.generationId, validationReportHash: manifest.validation.reportHash })
  if (expectedId !== manifest.manifestId) throw Object.assign(new Error('Generation manifest identity binding is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  return manifest
}

export function readGenerationManifest(packageDir) {
  const filePath = path.join(packageDir, ...GENERATION_MANIFEST_RELATIVE_PATH.split('/'))
  let parsed
  try { parsed = JSON.parse(readFileNoFollowBounded(filePath, 8 * 1024 * 1024).toString('utf8')) } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error('Generation manifest is missing.'), { code: 'GENERATION_MANIFEST_MISSING', statusCode: 422 })
    if (error?.code) throw error
    throw Object.assign(new Error('Generation manifest is invalid JSON.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  return validateGenerationManifest(parsed)
}

export function verifyGenerationManifestBinding(packageDir, expected = {}) {
  const manifestPath = path.join(packageDir, ...GENERATION_MANIFEST_RELATIVE_PATH.split('/'))
  const manifestBytes = readFileNoFollowBounded(manifestPath, 8 * 1024 * 1024)
  let manifest
  try { manifest = validateGenerationManifest(JSON.parse(manifestBytes.toString('utf8'))) } catch (error) {
    if (error?.code) throw error
    throw Object.assign(new Error('Generation manifest is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const actualManifestFileSha256 = sha256(manifestBytes)
  if ((expected.manifestId && expected.manifestId !== manifest.manifestId)
    || (expected.manifestHash && expected.manifestHash !== manifest.manifestHash)
    || (expected.manifestFileSha256 && expected.manifestFileSha256 !== actualManifestFileSha256)
    || (expected.paperKey && expected.paperKey !== manifest.paperKey)
    || (expected.generationId && expected.generationId !== manifest.generationId)) {
    throw Object.assign(new Error('Generation manifest does not match the authoritative current record.'), { code: 'GENERATION_MANIFEST_BINDING_MISMATCH', statusCode: 422 })
  }
  return { manifest, manifestFileSha256: actualManifestFileSha256 }
}

export function readManifestBoundFile(packageDir, manifest, relativePath, maxBytes = MAX_FILE_BYTES) {
  validateGenerationManifest(manifest)
  if (!safeSegments(relativePath) || relativePath === GENERATION_MANIFEST_RELATIVE_PATH) {
    throw Object.assign(new Error('Generation manifest file path is unsafe.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  const expected = manifest.files.find((item) => item.path === relativePath)
  if (!expected) throw Object.assign(new Error('Published generation file is not present in its sealed manifest.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
  const bytes = readFileNoFollowBounded(path.join(packageDir, ...relativePath.split('/')), Math.min(maxBytes, MAX_FILE_BYTES))
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw Object.assign(new Error('Published generation file differs from its sealed manifest.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
  }
  return bytes
}

export function verifyGenerationManifest(packageDir, expected = {}) {
  const verified = verifyGenerationManifestBinding(packageDir, expected)
  const actual = inventoryGenerationFiles(packageDir)
  if (JSON.stringify(actual) !== JSON.stringify(verified.manifest.files)) {
    throw Object.assign(new Error('Published generation content differs from its sealed manifest.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
  }
  return verified
}

export function unsealGenerationPackageForLifecycle(packageDir, options = {}) {
  if (options.authorized !== true) {
    throw Object.assign(new Error('Generation lifecycle authorization is required before changing sealed permissions.'), { code: 'GENERATION_LIFECYCLE_AUTHORIZATION_REQUIRED', statusCode: 403 })
  }
  if (typeof options.containmentRoot !== 'string' || !options.containmentRoot) {
    throw Object.assign(new Error('Generation lifecycle containment root is required.'), { code: 'GENERATION_LIFECYCLE_CONTAINMENT_REQUIRED', statusCode: 403 })
  }
  const requestedStats = fs.lstatSync(packageDir)
  if (requestedStats.isSymbolicLink()) {
    throw Object.assign(new Error('Generation package must be a non-symlink directory.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  const requestedContainmentRoot = path.resolve(options.containmentRoot)
  const requestedPackage = path.resolve(packageDir)
  const containmentRoot = fs.realpathSync(requestedContainmentRoot)
  const canonicalPackage = fs.realpathSync(requestedPackage)
  if (requestedContainmentRoot !== containmentRoot || requestedPackage !== canonicalPackage) {
    throw Object.assign(new Error('Generation lifecycle paths must not contain symlinked ancestors.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  const relative = path.relative(containmentRoot, canonicalPackage)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Generation package is outside its lifecycle containment root.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  let cursor = containmentRoot
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const stats = fs.lstatSync(cursor)
    if (stats.isSymbolicLink()) throw Object.assign(new Error('Generation package symlinks are forbidden.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  const rootStats = fs.lstatSync(canonicalPackage)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw Object.assign(new Error('Generation package must be a non-symlink directory.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
  }
  function walk(current) {
    const stats = fs.lstatSync(current)
    if (stats.isSymbolicLink()) throw Object.assign(new Error('Generation package symlinks are forbidden.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
    if (stats.isDirectory()) {
      fs.chmodSync(current, 0o700)
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry))
      return
    }
    if (!stats.isFile()) throw Object.assign(new Error('Generation package special files are forbidden.'), { code: 'GENERATION_MANIFEST_PATH_UNSAFE', statusCode: 403 })
    fs.chmodSync(current, 0o600)
  }
  walk(canonicalPackage)
}
