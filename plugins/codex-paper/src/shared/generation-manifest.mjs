import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { readFileNoFollowBounded } from './storage-transaction.mjs'
import {
  MANIFEST_VERSION,
  authoringSummary,
  buildArtifactGraph,
  collectExecutionReports,
  deriveManifestId as deriveManifestIdV2,
  manifestDiagnostics,
  reportIntrinsicHash,
  runtimeGenerationContract,
  sanitizeSourceLocator,
  verifyReadmeProjection,
} from './generation-provenance.mjs'
import { validationReportIntrinsicHash } from './validation-report-intrinsic.mjs'

export const GENERATION_MANIFEST_VERSION = MANIFEST_VERSION
export const LEGACY_GENERATION_MANIFEST_VERSION = '1.0.0'
export const GENERATION_MANIFEST_RELATIVE_PATH = '.codex-paper/generation-manifest.json'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MANIFEST_ID_PATTERN = /^gm-sha256-[a-f0-9]{64}$/
const TRANSACTION_ID_PATTERN = /^pub-[a-f0-9]{32}$/
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_DEPTH = 16
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST_SCHEMA_PATH = path.resolve(HERE, '../../skills/study/schemas/generation-manifest-2.0.schema.json')
const schemaCompiler = new Ajv2020({ allErrors: true, strict: true })
let validateManifestV2Schema = null

function manifestSchemaValidator() {
  if (validateManifestV2Schema) return validateManifestV2Schema
  try {
    validateManifestV2Schema = schemaCompiler.compile(JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf8')))
    return validateManifestV2Schema
  } catch {
    throw Object.assign(new Error('Generation Manifest 2.0 schema configuration is invalid.'), {
      code: 'PROVENANCE_CONFIG_INVALID',
      statusCode: 500,
    })
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

export function deriveManifestId(input) {
  return deriveManifestIdV2(input)
}

function deriveLegacyManifestId({ paperKey, generationId, validationReportHash }) {
  return `gm-sha256-${sha256(stableJson({ paperKey, generationId, validationReportHash }))}`
}

function manifestIntrinsic(manifest) {
  const { manifestHash, ...intrinsic } = manifest
  return intrinsic
}

function sanitizedLocator(value) {
  if (typeof value !== 'string') return false
  const sanitized = sanitizeSourceLocator(value)
  return sanitized?.locator === value && !sanitized.queryPresent && !sanitized.credentialsPresent
}

export function buildGenerationManifest({ packageDir, transactionId, paperKey, identity, validationReport, provenanceDraft, sealedAt = new Date().toISOString() }) {
  const validationReportHash = validationReport?.reportHash?.value
  const manifestId = deriveManifestId({
    paperKey,
    sourceRevisionId: identity?.sourceRevisionId,
    generationId: identity?.generationId,
  })
  if (provenanceDraft?.manifestId !== manifestId
    || provenanceDraft?.generationId !== identity?.generationId
    || provenanceDraft?.sourceRevisionId !== identity?.sourceRevisionId) {
    throw Object.assign(new Error('Workspace provenance does not bind the generation identity.'), { code: 'PROVENANCE_DRAFT_INVALID', statusCode: 422 })
  }
  const files = inventoryGenerationFiles(packageDir)
  const validationPath = '.codex-paper/validation-report.json'
  const validationFile = files.find((item) => item.path === validationPath)
  if (!validationFile) throw Object.assign(new Error('Validation report is missing from the generation inventory.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
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
    source: provenanceDraft.source,
    generation: {
      parameters: identity.generation.inputs,
      identitySchemaVersion: identity.schemaVersion,
      generationContractVersion: identity.generation.inputs.generationContractVersion,
    },
    software: provenanceDraft.software,
    runtime: provenanceDraft.runtime,
    artifacts: {
      graph: buildArtifactGraph(files, provenanceDraft),
    },
    validation: {
      path: validationPath,
      fileSha256: validationFile.sha256,
      schemaVersion: validationReport?.schemaVersion,
      status: validationReport?.status,
      phase: validationReport?.phase,
      publishable: validationReport?.publishable,
      reportHash: validationReportHash,
      validator: validationReport?.validator,
    },
    executions: {
      atSeal: collectExecutionReports(packageDir, {
        manifestId,
        generationId: identity.generationId,
      }),
    },
    authoring: authoringSummary(provenanceDraft),
    migrations: provenanceDraft.migrations,
    diagnostics: manifestDiagnostics(provenanceDraft),
    integrity: {
      canonicalization: 'sorted-json-v1',
      hashAlgorithm: 'sha256',
      signature: { status: 'unsigned', reason: 'deferred_to_p2_5' },
    },
    sealedAt,
    files,
  }
  const manifest = { ...intrinsic, manifestHash: sha256(stableJson(intrinsic)) }
  return validateGenerationManifest(manifest)
}

export function validateGenerationManifest(manifest) {
  if (manifest?.schemaVersion === LEGACY_GENERATION_MANIFEST_VERSION) return validateLegacyGenerationManifest(manifest)
  if (manifest?.schemaVersion !== GENERATION_MANIFEST_VERSION) {
    throw Object.assign(new Error('Generation manifest version is unsupported.'), { code: 'GENERATION_MANIFEST_VERSION_UNSUPPORTED', statusCode: 422 })
  }
  const validateSchema = manifestSchemaValidator()
  if (!validateSchema(manifest)) {
    throw Object.assign(new Error('Generation manifest does not satisfy the 2.0 schema.'), {
      code: 'GENERATION_MANIFEST_INVALID',
      statusCode: 422,
      details: (validateSchema.errors || []).slice(0, 20),
    })
  }
  const files = manifest?.files
  if (!MANIFEST_ID_PATTERN.test(String(manifest?.manifestId || ''))
    || manifest?.transactionState !== 'sealed'
    || !TRANSACTION_ID_PATTERN.test(String(manifest?.transactionId || ''))
    || !/^p-[a-f0-9]{64}$/.test(String(manifest?.paperKey || ''))
    || typeof manifest?.paperId !== 'string' || !manifest.paperId
    || !/^sha256:[a-f0-9]{64}$/.test(String(manifest?.sourceRevisionId || ''))
    || !/^gen:sha256:[a-f0-9]{64}$/.test(String(manifest?.generationId || ''))
    || !HASH_PATTERN.test(String(manifest?.sourceSha256 || ''))
    || !HASH_PATTERN.test(String(manifest?.generationFingerprint || ''))
    || manifest?.source?.sha256 !== manifest?.sourceSha256
    || manifest?.generation?.identitySchemaVersion !== '2.0.0'
    || manifest?.generation?.generationContractVersion !== '2.0.0'
    || manifest?.generation?.parameters?.sourceSha256 !== manifest?.sourceSha256
    || manifest?.runtime?.contentStatus !== 'conformant'
    || !Array.isArray(manifest?.software?.schemas)
    || manifest?.validation?.path !== '.codex-paper/validation-report.json'
    || !HASH_PATTERN.test(String(manifest?.validation?.fileSha256 || ''))
    || manifest?.validation?.schemaVersion !== '1.0.0'
    || !['pass', 'pass_with_warnings'].includes(manifest?.validation?.status)
    || manifest?.validation?.phase !== 'complete'
    || manifest?.validation?.publishable !== true
    || !HASH_PATTERN.test(String(manifest?.validation?.reportHash || ''))
    || !Array.isArray(manifest?.executions?.atSeal) || manifest.executions.atSeal.length > 256
    || !['codex_only', 'human_involved', 'unknown'].includes(manifest?.authoring?.status)
    || !Array.isArray(manifest?.authoring?.events) || manifest.authoring.events.length > 2048
    || !Array.isArray(manifest?.migrations) || !Array.isArray(manifest?.diagnostics)
    || manifest?.integrity?.canonicalization !== 'sorted-json-v1'
    || manifest?.integrity?.hashAlgorithm !== 'sha256'
    || manifest?.integrity?.signature?.status !== 'unsigned'
    || manifest?.integrity?.signature?.reason !== 'deferred_to_p2_5'
    || !Array.isArray(manifest?.artifacts?.graph?.nodes) || !Array.isArray(manifest?.artifacts?.graph?.edges)
    || Number.isNaN(Date.parse(manifest?.sealedAt))
    || !Array.isArray(files) || files.length < 1 || files.length > MAX_FILES
    || files.some((item) => !safeSegments(item?.path) || item.path.length > 512 || item.path === GENERATION_MANIFEST_RELATIVE_PATH || !HASH_PATTERN.test(String(item?.sha256 || '')) || !Number.isInteger(item?.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES)
    || new Set(files.map((item) => item.path)).size !== files.length
    || JSON.stringify(files.map((item) => item.path)) !== JSON.stringify(files.map((item) => item.path).sort())
    || !HASH_PATTERN.test(String(manifest?.manifestHash || ''))
    || sha256(stableJson(manifestIntrinsic(manifest))) !== manifest.manifestHash) {
    throw Object.assign(new Error('Generation manifest is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const expectedId = deriveManifestId({
    paperKey: manifest.paperKey,
    sourceRevisionId: manifest.sourceRevisionId,
    generationId: manifest.generationId,
  })
  if (expectedId !== manifest.manifestId) throw Object.assign(new Error('Generation manifest identity binding is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  const expectedFingerprint = sha256(stableJson(manifest.generation.parameters))
  const authoringEvents = manifest.authoring.events
  const completedAuthoringEvents = authoringEvents.filter((event) => event.state === 'completed')
  const authoringActors = new Set(authoringEvents.map((event) => event.actor))
  const expectedAuthoringStatus = authoringActors.has('human')
    ? 'human_involved'
    : authoringActors.has('unknown')
      ? 'unknown'
      : 'codex_only'
  const schemaPaths = manifest.software.schemas.map((item) => item.path)
  const diagnosticCodes = manifest.diagnostics.map((item) => item.code)
  const expectedDiagnostics = manifestDiagnostics({
    software: manifest.software,
    source: manifest.source,
    authoringEvents,
  })
  const executionPaths = manifest.executions.atSeal.map((item) => item.path)
  const sourceIdentity = manifest.source.canonical.doi
    ? `doi:${manifest.source.canonical.doi}`
    : manifest.source.canonical.arxiv
      ? `arxiv:${manifest.source.canonical.arxiv}`
      : `source:sha256:${manifest.sourceSha256}`
  if (manifest.generationFingerprint !== expectedFingerprint
    || manifest.generationId !== `gen:sha256:${expectedFingerprint}`
    || manifest.sourceRevisionId !== `sha256:${manifest.sourceSha256}`
    || manifest.paperId !== sourceIdentity
    || manifest.software.plugin.baseVersion !== manifest.generation.parameters.pluginBaseVersion
    || manifest.software.skill.name !== (manifest.generation.parameters.workflow === 'summary' ? 'paper-summary' : 'paper-study')
    || stableJson(runtimeGenerationContract(manifest.runtime)) !== stableJson(manifest.generation.parameters.runtimeContract)
    || Number.isNaN(Date.parse(manifest.source.acquiredAt))
    || authoringEvents.some((event, index) => event.sequence !== index + 1
      || !safeSegments(event.path) || Number.isNaN(Date.parse(event.createdAt))
      || Number.isNaN(Date.parse(event.completedAt))
      || event.dependencies.some((dependency) => !safeSegments(dependency.path))
      || new Set(event.dependencies.map((dependency) => dependency.path)).size !== event.dependencies.length)
    || new Set(authoringEvents.map((event) => event.eventId)).size !== authoringEvents.length
    || manifest.authoring.status !== expectedAuthoringStatus
    || (completedAuthoringEvents.length > 0
      && manifest.authoring.lastEditedAt !== completedAuthoringEvents.at(-1).completedAt)
    || Number.isNaN(Date.parse(manifest.authoring.lastEditedAt))
    || schemaPaths.some((item) => !safeSegments(item))
    || new Set(schemaPaths).size !== schemaPaths.length
    || stableJson(schemaPaths) !== stableJson([...schemaPaths].sort())
    || new Set(diagnosticCodes).size !== diagnosticCodes.length
    || stableJson(diagnosticCodes) !== stableJson([...diagnosticCodes].sort())
    || stableJson(manifest.diagnostics) !== stableJson(expectedDiagnostics)
    || new Set(executionPaths).size !== executionPaths.length
    || new Set(manifest.executions.atSeal.map((item) => item.executionId)).size !== manifest.executions.atSeal.length
    || (manifest.source.kind === 'local_file'
      && (manifest.source.requestedLocator !== null || manifest.source.resolvedLocator !== null))
    || (manifest.source.kind === 'remote_https'
      && (!sanitizedLocator(manifest.source.requestedLocator) || !sanitizedLocator(manifest.source.resolvedLocator)))
    || manifest.source.filename.includes('/') || manifest.source.filename.includes('\\')) {
    throw Object.assign(new Error('Generation manifest provenance bindings are invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const validationFile = files.find((item) => item.path === manifest.validation.path)
  if (!validationFile || validationFile.sha256 !== manifest.validation.fileSha256) {
    throw Object.assign(new Error('Generation manifest validation file binding is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const expectedGraph = buildArtifactGraph(files, {
    source: manifest.source,
    runtime: manifest.runtime,
    authoringEvents: manifest.authoring.events,
  })
  if (stableJson(expectedGraph) !== stableJson(manifest.artifacts.graph)) {
    throw Object.assign(new Error('Generation manifest artifact graph is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  for (const execution of manifest.executions.atSeal) {
    const file = files.find((item) => item.path === execution.path)
    if (!file || file.sha256 !== execution.fileSha256) {
      throw Object.assign(new Error('Generation manifest execution inventory binding is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
    }
  }
  return manifest
}

function validateLegacyGenerationManifest(manifest) {
  const files = manifest?.files
  if (!MANIFEST_ID_PATTERN.test(String(manifest?.manifestId || ''))
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
    || !validFiles(files)
    || !HASH_PATTERN.test(String(manifest?.manifestHash || ''))
    || sha256(stableJson(manifestIntrinsic(manifest))) !== manifest.manifestHash) {
    throw Object.assign(new Error('Generation manifest is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  }
  const expectedId = deriveLegacyManifestId({ paperKey: manifest.paperKey, generationId: manifest.generationId, validationReportHash: manifest.validation.reportHash })
  if (expectedId !== manifest.manifestId) throw Object.assign(new Error('Generation manifest identity binding is invalid.'), { code: 'GENERATION_MANIFEST_INVALID', statusCode: 422 })
  return manifest
}

function validFiles(files) {
  return Array.isArray(files) && files.length >= 1 && files.length <= MAX_FILES
    && files.every((item) => safeSegments(item?.path) && item.path.length <= 512
      && item.path !== GENERATION_MANIFEST_RELATIVE_PATH && HASH_PATTERN.test(String(item?.sha256 || ''))
      && Number.isInteger(item?.bytes) && item.bytes >= 0 && item.bytes <= MAX_FILE_BYTES)
    && new Set(files.map((item) => item.path)).size === files.length
    && JSON.stringify(files.map((item) => item.path)) === JSON.stringify(files.map((item) => item.path).sort())
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
  if (verified.manifest.schemaVersion === GENERATION_MANIFEST_VERSION) {
    let identity
    try {
      identity = JSON.parse(readManifestBoundFile(
        packageDir,
        verified.manifest,
        '.codex-paper/paper-identity.json',
        8 * 1024 * 1024,
      ).toString('utf8'))
    } catch (error) {
      if (error?.code) throw error
      throw Object.assign(new Error('Published paper identity is invalid.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
    }
    if (identity?.schemaVersion !== verified.manifest.generation.identitySchemaVersion
      || identity?.paperId !== verified.manifest.paperId
      || identity?.sourceRevisionId !== verified.manifest.sourceRevisionId
      || identity?.generationId !== verified.manifest.generationId
      || identity?.source?.sha256 !== verified.manifest.sourceSha256
      || identity?.generation?.fingerprint?.value !== verified.manifest.generationFingerprint
      || stableJson(identity?.generation?.inputs) !== stableJson(verified.manifest.generation.parameters)) {
      throw Object.assign(new Error('Published paper identity differs from its manifest binding.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
    }
    verifyReadmeProjection(packageDir, verified.manifest.manifestId)
    let validationReport
    try {
      validationReport = JSON.parse(readManifestBoundFile(
        packageDir,
        verified.manifest,
        verified.manifest.validation.path,
        8 * 1024 * 1024,
      ).toString('utf8'))
    } catch (error) {
      if (error?.code) throw error
      throw Object.assign(new Error('Published validation report is invalid.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
    }
    if (validationReport?.reportHash?.value !== verified.manifest.validation.reportHash
      || validationReport.reportHash.value !== validationReportIntrinsicHash(validationReport)
      || validationReport?.status !== verified.manifest.validation.status
      || validationReport?.phase !== verified.manifest.validation.phase
      || validationReport?.publishable !== verified.manifest.validation.publishable
      || stableJson(validationReport?.validator) !== stableJson(verified.manifest.validation.validator)) {
      throw Object.assign(new Error('Published validation report differs from its manifest binding.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
    }
    for (const execution of verified.manifest.executions.atSeal) {
      let report
      try {
        report = JSON.parse(readManifestBoundFile(packageDir, verified.manifest, execution.path, 8 * 1024 * 1024).toString('utf8'))
      } catch (error) {
        if (error?.code) throw error
        throw Object.assign(new Error('Published execution report is invalid.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
      }
      if (report?.reportHash?.value !== execution.reportHash
        || reportIntrinsicHash(report) !== execution.reportHash
        || report?.generationBinding?.phase !== 'preseal'
        || report.generationBinding.manifestId !== verified.manifest.manifestId
        || report.generationBinding.generationId !== verified.manifest.generationId) {
        throw Object.assign(new Error('Published execution report differs from its manifest binding.'), { code: 'GENERATION_MANIFEST_DIRTY', statusCode: 409 })
      }
    }
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
