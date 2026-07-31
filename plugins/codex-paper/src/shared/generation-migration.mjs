import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'

import { preparePaper } from '../../skills/study/scripts/prepare-paper.js'
import {
  buildMigrationPlan,
  descriptorForMigrationTarget,
  inspectBackup,
  migrationSourceSnapshot,
  MIGRATION_POLICY,
  packageVersions,
  stableJson,
  structuralTarget,
  verifyBackup,
} from './library-maintenance.mjs'
import {
  getLibraryLayout,
  readCurrentRecord,
  readJsonNoFollow,
  readPaperRecord,
  requireNoFollowDirectory,
  validateCurrentRecord,
  validatePaperRecord,
} from './paper-library.mjs'
import {
  isAuthoringPath,
  resolveGenerationWorkspace,
} from './generation-workspace.mjs'
import {
  applyReadmeProjection,
  appendMigrationEvent,
  readProvenanceDraft,
  writeAuthoringWithProvenance,
} from './generation-provenance.mjs'
import {
  publishGenerationWorkspace,
  writeRebuiltIndexLocked,
} from './generation-publication.mjs'
import { verifyGenerationManifestBinding } from './generation-manifest.mjs'
import {
  atomicWriteJson,
  fileWritePrecondition,
  readFileNoFollowBounded,
  withStorageLocks,
} from './storage-transaction.mjs'
import {
  PAPER_EVIDENCE_ID_PATTERN,
  resolveEvidenceRefs,
  validateEvidenceAliasMap,
} from './package-compatibility.mjs'

export const MIGRATION_TRANSACTION_VERSION = '1.0.0'
export const MIGRATION_SOURCE_VERSION = '1.0.0'
export const EVIDENCE_ALIAS_VERSION = '1.0.0'

const MIGRATION_ID_PATTERN = /^mig-sha256-[a-f0-9]{64}$/
const WORKSPACE_ID_PATTERN = /^ws-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{32}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const LEGACY_REF_PATTERN = /^(?:claim|result|limitation):\d+$/
const ROOT_AUTHORING = new Set([
  'README.md', 'quick-summary.md', 'visual-assets.md', 'summary.md', 'insights.md', 'method.md',
  'mental-model.md', 'reflection.md', 'qa.md', 'index.html', 'reasoning-analysis.json',
])
const CODEX_AUTHORING = new Set(['.codex-paper/reasoning-review.md', '.codex-paper/answering-pack.md'])
const SCHEMA_ROOT = new URL('../../skills/study/schemas/', import.meta.url)
const compiler = new Ajv2020({ allErrors: true, strict: true })
const validators = Object.fromEntries([
  ['alias', 'evidence-alias-map-1.0.schema.json'],
  ['source', 'migration-source-record-1.0.schema.json'],
  ['transaction', 'migration-transaction-1.0.schema.json'],
].map(([name, filename]) => [
  name,
  compiler.compile(JSON.parse(fs.readFileSync(new URL(filename, SCHEMA_ROOT), 'utf8'))),
]))

export class GenerationMigrationError extends Error {
  constructor(code, message, statusCode = 422, details = {}) {
    super(message)
    this.name = 'GenerationMigrationError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function maybeFault(options, point) {
  if (options.faultAt === point) {
    throw new GenerationMigrationError('MIGRATION_FAULT_INJECTED', `Synthetic migration failure at ${point}.`, 409)
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function assertSchema(name, value) {
  if (validators[name](value)) return value
  throw new GenerationMigrationError(
    `MIGRATION_${name.toUpperCase()}_INVALID`,
    `Migration ${name} document is invalid.`,
    422,
    { errors: (validators[name].errors || []).slice(0, 20).map((item) => ({ path: item.instancePath || '/', keyword: item.keyword })) },
  )
}

function migrationLayout(libraryRoot) {
  const library = getLibraryLayout(libraryRoot)
  const privateRoot = path.join(library.libraryRoot, '.codex-paper')
  return {
    ...library,
    privateRoot,
    transactionsRoot: path.join(privateRoot, 'migration-transactions-v1'),
    archivesRoot: path.join(privateRoot, 'migration-archives-v1'),
  }
}

function ensurePrivateDirectory(directory, parent) {
  try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const parentReal = fs.realpathSync(parent)
  const stats = fs.lstatSync(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new GenerationMigrationError('MIGRATION_PATH_UNSAFE', 'Migration registry is unsafe.', 403)
  const real = fs.realpathSync(directory)
  const relative = path.relative(parentReal, real)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new GenerationMigrationError('MIGRATION_PATH_UNSAFE', 'Migration registry escapes its private authority.', 403)
  }
  fs.chmodSync(real, 0o700)
  return real
}

function prepareMigrationLayout(libraryRoot) {
  const layout = migrationLayout(libraryRoot)
  fs.mkdirSync(layout.libraryRoot, { recursive: true, mode: 0o700 })
  ensurePrivateDirectory(layout.privateRoot, layout.libraryRoot)
  ensurePrivateDirectory(layout.transactionsRoot, layout.privateRoot)
  ensurePrivateDirectory(layout.archivesRoot, layout.privateRoot)
  return layout
}

function transactionPath(layout, migrationId) {
  if (!MIGRATION_ID_PATTERN.test(String(migrationId || ''))) throw new GenerationMigrationError('MIGRATION_ID_INVALID', 'Migration ID is invalid.', 400)
  return path.join(layout.transactionsRoot, `${migrationId}.json`)
}

function readTransaction(migrationId, options = {}) {
  const layout = migrationLayout(options.libraryRoot)
  const target = transactionPath(layout, migrationId)
  if (!fs.existsSync(target)) throw new GenerationMigrationError('MIGRATION_NOT_FOUND', 'Migration transaction was not found.', 404)
  let value
  try {
    value = readJsonNoFollow(target, 'migration transaction', 4 * 1024 * 1024)
  } catch {
    throw new GenerationMigrationError('MIGRATION_TRANSACTION_INVALID', 'Migration transaction is unreadable.', 422)
  }
  if (value?.schemaVersion !== MIGRATION_TRANSACTION_VERSION) {
    throw new GenerationMigrationError('MIGRATION_TRANSACTION_UNSUPPORTED', 'Migration transaction version is unsupported.', 422)
  }
  return assertSchema('transaction', value)
}

function writeTransaction(layout, transaction, lockHandle) {
  const value = assertSchema('transaction', { ...transaction, updatedAt: new Date().toISOString() })
  const relativePath = `${value.migrationId}.json`
  const target = path.join(layout.transactionsRoot, relativePath)
  atomicWriteJson({
    root: layout.transactionsRoot,
    relativePath,
    value,
    lockHandle,
    requiredLock: `migration:${value.migrationId}`,
    maxBytes: 4 * 1024 * 1024,
    ...fileWritePrecondition(target, 4 * 1024 * 1024),
  })
  return value
}

function activeTransactionsForTarget(layout, target) {
  if (!fs.existsSync(layout.transactionsRoot)) return []
  const activeStates = new Set(['workspace_created', 'committing', 'rolling_back', 'rolling_forward'])
  const matches = []
  for (const entry of fs.readdirSync(layout.transactionsRoot).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const transaction = readTransaction(entry.slice(0, -5), { libraryRoot: layout.libraryRoot })
      if (!activeStates.has(transaction.state)) continue
      if (transaction.source.relativePath === target.targetRelativePath
        || (target.paperKey && transaction.target.paperKey === target.paperKey)
        || (target.routeSlug && transaction.target.routeSlug === target.routeSlug)) {
        matches.push(transaction)
      }
    } catch (error) {
      if (!['MIGRATION_TRANSACTION_INVALID', 'MIGRATION_TRANSACTION_UNSUPPORTED'].includes(error?.code)) throw error
    }
  }
  return matches
}

function optionalJson(packageDir, relativePath) {
  const target = path.join(packageDir, ...relativePath.split('/'))
  if (!fs.existsSync(target)) return null
  return readJsonNoFollow(target, relativePath, 64 * 1024 * 1024)
}

function fileSha(packageDir, relativePath) {
  const target = path.join(packageDir, ...relativePath.split('/'))
  return fs.existsSync(target) ? sha256(readFileNoFollowBounded(target, 128 * 1024 * 1024)) : null
}

function normalizedEvidence(item) {
  return stableJson({
    page: item?.location?.page ?? null,
    kind: item?.kind ?? null,
    text: String(item?.text || item?.quote || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
  })
}

function collectMachineRefs(value, output = new Set()) {
  if (typeof value === 'string') {
    if (PAPER_EVIDENCE_ID_PATTERN.test(value) || LEGACY_REF_PATTERN.test(value)) output.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectMachineRefs(item, output)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMachineRefs(item, output)
  }
  return output
}

function translateMachineRefs(value, aliases) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' && aliases.has(item)) return aliases.get(item)
      return [translateMachineRefs(item, aliases)]
    })
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateMachineRefs(item, aliases)]))
  }
  if (typeof value === 'string' && aliases.has(value) && aliases.get(value).length === 1) return aliases.get(value)[0]
  return value
}

function buildAliasMap(sourcePackage, targetPackage, plan) {
  const sourceLedger = optionalJson(sourcePackage, 'evidence-ledger.json')
  const sourceFacts = optionalJson(sourcePackage, 'facts.json')
  const targetLedger = readJsonNoFollow(path.join(targetPackage, 'evidence-ledger.json'), 'evidence-ledger.json')
  const targetById = new Map((targetLedger.evidence || []).map((item) => [item.id, item]))
  const targetByContent = new Map()
  for (const item of targetLedger.evidence || []) {
    const key = sha256(normalizedEvidence(item))
    const values = targetByContent.get(key) || []
    values.push(item.id)
    targetByContent.set(key, values)
  }
  const referenced = new Set()
  for (const relativePath of ['facts.json', 'analysis.json', 'reasoning-analysis.json']) {
    const value = optionalJson(sourcePackage, relativePath)
    if (value) collectMachineRefs(value, referenced)
  }
  const sourceEvidence = new Map((sourceLedger?.evidence || []).map((item) => [item.id, item]))
  const candidates = new Set([...sourceEvidence.keys(), ...referenced])
  for (const [kind, key] of [['claim', 'coreClaims'], ['result', 'keyResults'], ['limitation', 'limitations']]) {
    for (let index = 0; index < (sourceFacts?.[key] || []).length; index += 1) candidates.add(`${kind}:${index}`)
  }
  const aliases = []
  const unresolved = []
  const bySource = new Map()
  const sourceLedgerSha = fileSha(sourcePackage, 'evidence-ledger.json')
  const sourceFactsSha = fileSha(sourcePackage, 'facts.json')
  const directMap = new Map()
  for (const [id, item] of sourceEvidence) {
    let targets = targetById.has(id) ? [id] : (targetByContent.get(sha256(normalizedEvidence(item))) || [])
    targets = [...new Set(targets)].sort()
    if (targets.length === 1) directMap.set(id, targets)
  }
  for (const sourceRef of [...candidates].sort()) {
    let targets = []
    let method = 'content_hash'
    let sourceArtifactSha256 = sourceLedgerSha || sourceFactsSha || plan.source.snapshotHash
    if (PAPER_EVIDENCE_ID_PATTERN.test(sourceRef)) {
      targets = directMap.get(sourceRef) || []
      method = targets[0] === sourceRef ? 'identity' : 'content_hash'
      sourceArtifactSha256 = sourceLedgerSha || plan.source.snapshotHash
    } else {
      const projected = resolveEvidenceRefs([sourceRef], sourceFacts, sourceLedger)
      targets = [...new Set(projected.flatMap((ref) => directMap.get(ref) || []))].sort()
      method = 'fact_projection'
      sourceArtifactSha256 = sourceFactsSha || plan.source.snapshotHash
    }
    if (targets.length === 1) {
      aliases.push({ sourceRef, targetRefs: targets, method, sourceArtifactSha256 })
      bySource.set(sourceRef, targets)
    } else if (referenced.has(sourceRef)) unresolved.push(sourceRef)
  }
  const referencedResolved = [...referenced].filter((ref) => bySource.has(ref)).length
  const aliasMap = {
    schemaVersion: EVIDENCE_ALIAS_VERSION,
    source: {
      packageVersion: String(plan.source.packageVersion || 'legacy'),
      snapshotHash: plan.source.snapshotHash,
      ledgerSha256: sourceLedgerSha,
      factsSha256: sourceFactsSha,
    },
    target: { ledgerSha256: fileSha(targetPackage, 'evidence-ledger.json') },
    aliases,
    coverage: {
      referenced: referenced.size,
      resolved: referencedResolved,
      unresolved: referenced.size - referencedResolved,
      ratio: referenced.size === 0 ? 1 : referencedResolved / referenced.size,
    },
    diagnostics: unresolved.slice(0, 500).map((sourceRef) => ({
      code: 'EVIDENCE_ALIAS_UNRESOLVED',
      message: 'A referenced source evidence identifier could not be mapped uniquely.',
      sourceRef,
    })),
  }
  validateEvidenceAliasMap(aliasMap, targetLedger)
  assertSchema('alias', aliasMap)
  return { aliasMap, bySource }
}

function safeAuthoringFiles(packageDir) {
  const output = []
  function walk(relativeRoot) {
    const root = path.join(packageDir, ...relativeRoot.split('/'))
    if (!fs.existsSync(root)) return
    const stats = fs.lstatSync(root)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new GenerationMigrationError('MIGRATION_SOURCE_UNSAFE', 'Migrated authoring directories must be real directories.', 403)
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${relativeRoot}/${entry.name}`
      const target = path.join(packageDir, ...relativePath.split('/'))
      const itemStats = fs.lstatSync(target)
      if (itemStats.isSymbolicLink()) throw new GenerationMigrationError('MIGRATION_SOURCE_UNSAFE', 'Migrated authoring content cannot contain symlinks.', 403)
      if (itemStats.isDirectory()) walk(relativePath)
      else if (itemStats.isFile() && isAuthoringPath(relativePath)) output.push(relativePath)
      else if (!itemStats.isFile()) throw new GenerationMigrationError('MIGRATION_SOURCE_UNSAFE', 'Migrated authoring content cannot contain special files.', 403)
    }
  }
  function addRegularFile(relativePath) {
    const target = path.join(packageDir, ...relativePath.split('/'))
    if (!fs.existsSync(target)) return
    const stats = fs.lstatSync(target)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new GenerationMigrationError('MIGRATION_SOURCE_UNSAFE', 'Migrated authoring files must be regular files.', 403)
    }
    output.push(relativePath)
  }
  for (const relativePath of ROOT_AUTHORING) addRegularFile(relativePath)
  for (const relativePath of CODEX_AUTHORING) addRegularFile(relativePath)
  for (const root of ['code', 'images']) walk(root)
  return [...new Set(output)].sort()
}

async function copyAuthoring(sourcePackage, workspace, aliasLookup) {
  for (const relativePath of safeAuthoringFiles(sourcePackage)) {
    const source = path.join(sourcePackage, ...relativePath.split('/'))
    const target = path.join(workspace.packageDir, ...relativePath.split('/'))
    let data
    try {
      data = readFileNoFollowBounded(source, relativePath.startsWith('code/') ? 1024 * 1024 : 16 * 1024 * 1024)
    } catch (error) {
      error.message = `Could not read migrated authoring file ${relativePath}: ${error.message}`
      throw error
    }
    if (relativePath === 'reasoning-analysis.json') {
      try {
        data = Buffer.from(`${JSON.stringify(translateMachineRefs(JSON.parse(data.toString('utf8')), aliasLookup), null, 2)}\n`)
      } catch {
        throw new GenerationMigrationError('MIGRATION_SOURCE_INVALID', 'Source reasoning-analysis.json is invalid.', 422)
      }
    }
    if (fs.existsSync(target)) {
      const expected = relativePath === 'README.md'
        ? Buffer.from(applyReadmeProjection(data, readProvenanceDraft(workspace).manifestId))
        : data
      const existing = readFileNoFollowBounded(target, relativePath.startsWith('code/') ? 1024 * 1024 : 16 * 1024 * 1024)
      if (sha256(existing) === sha256(expected)) continue
      throw new GenerationMigrationError(
        'MIGRATION_AUTHORING_CONFLICT',
        `Migration workspace already contains divergent authoring content at ${relativePath}.`,
        409,
        { path: relativePath },
      )
    }
    const { writeWorkspaceAuthoring } = await import('./generation-workspace.mjs')
    try {
      await writeWorkspaceAuthoring(
        workspace.workspaceId,
        relativePath,
        data,
        { expectAbsent: true },
        { libraryRoot: workspace.libraryRoot, actor: 'tool' },
      )
    } catch (error) {
      error.message = `Could not migrate authoring file ${relativePath}: ${error.message}`
      throw error
    }
  }
}

function migrationSourceRecord(migrationId, plan, backupId, descriptor) {
  const versions = packageVersions(descriptor.packageDir)
  return assertSchema('source', {
    schemaVersion: MIGRATION_SOURCE_VERSION,
    migrationId,
    planId: plan.planId,
    backupId,
    source: {
      kind: plan.target.kind,
      relativePath: plan.target.relativePath,
      snapshotHash: plan.source.snapshotHash,
      packageVersion: versions.compatibility.packageVersion,
      identityVersion: versions.identityVersion,
      manifestVersion: versions.manifestVersion,
      manifestId: descriptor.current?.manifestId || null,
      manifestHash: descriptor.current?.manifestHash || null,
    },
    transform: {
      policyVersion: MIGRATION_POLICY.version,
      policySha256: plan.policy.sha256,
      authoringProvider: MIGRATION_POLICY.authoringProvider,
      authoringModel: MIGRATION_POLICY.authoringModel,
    },
    createdAt: new Date().toISOString(),
  })
}

export async function startGenerationMigration(input, backupId, options = {}) {
  const layout = prepareMigrationLayout(options.libraryRoot)
  const plan = buildMigrationPlan(input, { backupId, libraryRoot: layout.libraryRoot })
  if (plan.eligibility === 'not_required') return { status: 'not_required', plan }
  if (!plan.executionAvailable || plan.eligibility !== 'ready') {
    throw new GenerationMigrationError('MIGRATION_PLAN_BLOCKED', 'Migration plan is blocked; resolve its diagnostics before execution.', 409, { diagnostics: plan.diagnostics })
  }
  const target = structuralTarget(input, layout.libraryRoot)
  const activeTransactions = activeTransactionsForTarget(layout, target)
  const reusable = activeTransactions.find((transaction) => transaction.planId === plan.planId && transaction.backupId === backupId)
  if (reusable) {
    return {
      status: reusable.state,
      migrationId: reusable.migrationId,
      workspaceId: reusable.workspaceId,
      reused: true,
      validationRequired: reusable.state === 'workspace_created',
    }
  }
  if (activeTransactions.length > 0) {
    throw new GenerationMigrationError(
      'MIGRATION_ALREADY_ACTIVE',
      'Another migration transaction is already active for this paper; inspect or recover it before starting a new plan.',
      409,
      { migrationId: activeTransactions[0].migrationId },
    )
  }
  const descriptor = descriptorForMigrationTarget(target, layout.libraryRoot)
  const backup = inspectBackup(backupId, { libraryRoot: layout.libraryRoot })
  verifyBackup(backupId, { libraryRoot: layout.libraryRoot })
  if (backup.manifest.target.relativePath !== plan.target.relativePath
    || migrationSourceSnapshot(backup.payloadDir, plan.target.kind).snapshotHash !== plan.source.snapshotHash) {
    throw new GenerationMigrationError('MIGRATION_BACKUP_STALE', 'Verified backup does not match the current migration source.', 409)
  }
  const sourceMeta = optionalJson(descriptor.packageDir, 'meta.json') || {}
  const sourceIdentity = optionalJson(descriptor.packageDir, '.codex-paper/paper-identity.json')
  let prepared
  try {
    prepared = await preparePaper(path.join(descriptor.packageDir, 'paper.pdf'), {
      libraryRoot: layout.libraryRoot,
      contextMode: sourceIdentity?.generation?.inputs?.contextMode || sourceMeta.contextMode || 'paper-only',
      profile: sourceIdentity?.generation?.inputs?.requestedPaperProfile || sourceMeta.requestedPaperProfile || 'auto',
      workflow: sourceIdentity?.generation?.inputs?.workflow || sourceMeta.workflow || 'study',
      language: sourceIdentity?.generation?.inputs?.language || sourceMeta.language || 'en',
      authoringProvider: MIGRATION_POLICY.authoringProvider,
      authoringModel: MIGRATION_POLICY.authoringModel,
      migrationRouteSlug: descriptor.routeSlug,
      migrationPaperRecord: descriptor.record || null,
      lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
    })
  } catch (error) {
    if (error?.code !== 'WORKSPACE_EXISTS' || !error?.details?.workspaceId) throw error
    try {
      const existing = inspectGenerationMigration(error.details.workspaceId, { libraryRoot: layout.libraryRoot })
      if (existing.planId !== plan.planId || existing.backupId !== backupId) throw error
      return {
        status: existing.state,
        migrationId: existing.migrationId,
        workspaceId: existing.workspaceId,
        reused: true,
        validationRequired: existing.state === 'workspace_created',
      }
    } catch (inspectionError) {
      if (inspectionError === error) throw error
      throw new GenerationMigrationError(
        'MIGRATION_START_INCOMPLETE',
        'A prior migration start left an unregistered workspace; inspect and abandon that exact workspace before retrying.',
        409,
        { workspaceId: error.details.workspaceId },
      )
    }
  }
  const migrationId = `mig-sha256-${sha256(stableJson({
    planId: plan.planId,
    backupId,
    workspaceId: prepared.workspaceId,
    generationId: prepared.identity.generationId,
  }))}`
  let workspace = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot: layout.libraryRoot })
  const { aliasMap, bySource } = buildAliasMap(descriptor.packageDir, workspace.packageDir, plan)
  await copyAuthoring(descriptor.packageDir, workspace, bySource)
  workspace = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot: layout.libraryRoot })
  const sourceRecord = migrationSourceRecord(migrationId, plan, backupId, descriptor)
  await withStorageLocks([workspace.paperLockKey, workspace.generationLockKey, workspace.workspaceLockKey], async (lockHandle) => {
    const write = (relativePath, value) => writeAuthoringWithProvenance({
      workspace,
      relativePath,
      data: `${JSON.stringify(value, null, 2)}\n`,
      precondition: { expectAbsent: true },
      actor: 'tool',
      additionalDependencies: ['paper.pdf', 'evidence-ledger.json', 'facts.json'],
      lockHandle,
      maxBytes: 16 * 1024 * 1024,
    })
    write('.codex-paper/evidence-aliases.json', aliasMap)
    write('.codex-paper/migration-source.json', sourceRecord)
    appendMigrationEvent(workspace, {
      migrationId,
      fromVersion: String(plan.source.packageVersion || 'legacy'),
      toVersion: '2.1.0',
      toolVersion: MIGRATION_POLICY.authoringModel,
      appliedAt: sourceRecord.createdAt,
      backupId,
      rollbackAvailable: true,
    }, lockHandle)
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
  const now = new Date().toISOString()
  const transaction = assertSchema('transaction', {
    schemaVersion: MIGRATION_TRANSACTION_VERSION,
    migrationId,
    planId: plan.planId,
    state: 'workspace_created',
    source: {
      kind: plan.target.kind,
      relativePath: plan.target.relativePath,
      snapshotHash: plan.source.snapshotHash,
      routeSlug: descriptor.routeSlug,
      paperKey: descriptor.paperKey,
    },
    backupId,
    workspaceId: workspace.workspaceId,
    target: {
      paperKey: workspace.paperKey,
      paperId: workspace.paperId,
      sourceRevisionId: workspace.sourceRevisionId,
      generationId: workspace.generationId,
      routeSlug: workspace.routeSlug,
    },
    currentBefore: descriptor.current || null,
    currentAfter: null,
    archive: { sourceRelativePath: null, targetRelativePath: null },
    createdAt: now,
    updatedAt: now,
    diagnostics: aliasMap.diagnostics.map(({ code, message }) => ({ code, message })).slice(0, 64),
  })
  await withStorageLocks([`migration:${migrationId}`], async (lockHandle) => writeTransaction(layout, transaction, lockHandle), {
    libraryRoot: layout.libraryRoot,
    timeoutMs: options.lockTimeoutMs ?? 10_000,
  })
  return {
    status: 'workspace_created',
    migrationId,
    workspaceId: workspace.workspaceId,
    workspaceDir: workspace.workspaceDir,
    paperDir: workspace.packageDir,
    aliasCoverage: aliasMap.coverage,
    validationRequired: true,
  }
}

export function inspectGenerationMigration(input, options = {}) {
  if (MIGRATION_ID_PATTERN.test(String(input || ''))) return readTransaction(input, options)
  if (String(input || '').startsWith('mig-')) {
    throw new GenerationMigrationError('MIGRATION_ID_INVALID', 'Migration ID is invalid.', 400)
  }
  if (!WORKSPACE_ID_PATTERN.test(String(input || ''))
    && !path.isAbsolute(String(input || ''))
    && !String(input || '').includes(path.sep)) {
    throw new GenerationMigrationError('MIGRATION_REFERENCE_INVALID', 'Migration reference must be a migration ID or exact workspace reference.', 400)
  }
  const workspace = resolveGenerationWorkspace(input, options)
  const layout = migrationLayout(workspace.libraryRoot)
  if (!fs.existsSync(layout.transactionsRoot)) throw new GenerationMigrationError('MIGRATION_NOT_FOUND', 'Migration transaction was not found.', 404)
  for (const entry of fs.readdirSync(layout.transactionsRoot).sort()) {
    if (!entry.endsWith('.json')) continue
    try {
      const transaction = readTransaction(entry.slice(0, -5), { libraryRoot: workspace.libraryRoot })
      if (transaction.workspaceId === workspace.workspaceId) return transaction
    } catch (error) {
      if (!['MIGRATION_TRANSACTION_INVALID', 'MIGRATION_TRANSACTION_UNSUPPORTED'].includes(error?.code)) throw error
    }
  }
  throw new GenerationMigrationError('MIGRATION_NOT_FOUND', 'Migration transaction was not found for this workspace.', 404)
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function archiveRelative(migrationId, side) {
  return `.codex-paper/migration-archives-v1/${migrationId}/${side}`
}

function moveLegacySourceToArchive(layout, transaction) {
  const source = path.join(layout.libraryRoot, ...transaction.source.relativePath.split('/'))
  const archiveDir = path.join(layout.archivesRoot, transaction.migrationId)
  ensurePrivateDirectory(archiveDir, layout.archivesRoot)
  const target = path.join(archiveDir, 'source')
  if (fs.existsSync(target)) {
    if (fs.existsSync(source)) throw new GenerationMigrationError('MIGRATION_ARCHIVE_CONFLICT', 'Both legacy source and migration archive exist.', 409)
    return
  }
  requireNoFollowDirectory(layout.legacyPapersRoot, source, 'MIGRATION_SOURCE_MISSING')
  fs.renameSync(source, target)
  fsyncDirectory(layout.legacyPapersRoot)
  fsyncDirectory(archiveDir)
}

export async function commitGenerationMigration(input, options = {}) {
  const initial = inspectGenerationMigration(input, options)
  if (initial.state === 'committed') return { migrationId: initial.migrationId, committed: true, current: initial.currentAfter, reused: true }
  if (!['workspace_created', 'committing'].includes(initial.state)) {
    throw new GenerationMigrationError('MIGRATION_STATE_CONFLICT', 'Migration is not ready to commit.', 409)
  }
  const layout = prepareMigrationLayout(options.libraryRoot)
  const workspace = resolveGenerationWorkspace(initial.workspaceId, { libraryRoot: layout.libraryRoot })
  if (workspace.workspace.state !== 'validated') throw new GenerationMigrationError('MIGRATION_VALIDATION_REQUIRED', 'Migration workspace must pass complete standard validation before commit.', 409)
  const detachedRecovery = initial.state === 'committing' && !workspace.packageDir
  verifyBackup(initial.backupId, { libraryRoot: layout.libraryRoot })
  if (!detachedRecovery) {
    const aliasMap = readJsonNoFollow(path.join(workspace.packageDir, '.codex-paper/evidence-aliases.json'), 'evidence-aliases.json', 16 * 1024 * 1024)
    const ledger = readJsonNoFollow(path.join(workspace.packageDir, 'evidence-ledger.json'), 'evidence-ledger.json', 64 * 1024 * 1024)
    validateEvidenceAliasMap(aliasMap, ledger)
    if (aliasMap.coverage.unresolved !== 0) {
      throw new GenerationMigrationError('MIGRATION_EVIDENCE_UNRESOLVED', 'Referenced source evidence aliases must be fully resolved before migration commit.', 409)
    }
  }
  if (initial.source.kind === 'legacy_flat') {
    const sourcePath = path.join(layout.libraryRoot, ...initial.source.relativePath.split('/'))
    const archivedSource = path.join(layout.archivesRoot, initial.migrationId, 'source')
    const sourcePresent = fs.existsSync(sourcePath)
    const archivedPresent = fs.existsSync(archivedSource)
    if (!sourcePresent && !archivedPresent) {
      throw new GenerationMigrationError('MIGRATION_SOURCE_MISSING', 'Legacy migration source disappeared after planning.', 409)
    }
    if (sourcePresent && archivedPresent) {
      throw new GenerationMigrationError('MIGRATION_ARCHIVE_CONFLICT', 'Legacy migration must retain exactly one verified source authority.', 409)
    }
    const retainedSource = sourcePresent ? sourcePath : archivedSource
    if (migrationSourceSnapshot(retainedSource, 'legacy_flat').snapshotHash !== initial.source.snapshotHash) {
      throw new GenerationMigrationError('MIGRATION_SOURCE_CHANGED', 'Migration source changed after planning.', 409)
    }
  } else if (!detachedRecovery) {
    const sourcePath = path.join(layout.recordsRoot, initial.source.paperKey)
    if (!fs.existsSync(sourcePath)) {
      throw new GenerationMigrationError('MIGRATION_SOURCE_MISSING', 'Managed migration source disappeared after planning.', 409)
    }
    if (migrationSourceSnapshot(sourcePath, 'managed_paper').snapshotHash !== initial.source.snapshotHash) {
      throw new GenerationMigrationError('MIGRATION_SOURCE_CHANGED', 'Migration source changed after planning.', 409)
    }
  }
  if (!detachedRecovery) {
    await withStorageLocks([`migration:${initial.migrationId}`], async (lockHandle) => {
      writeTransaction(layout, { ...readTransaction(initial.migrationId, { libraryRoot: layout.libraryRoot }), state: 'committing' }, lockHandle)
    }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
    maybeFault(options, 'after_committing_journal')
  }
  const legacy = initial.source.kind === 'legacy_flat'
  const published = await publishGenerationWorkspace(initial.workspaceId, {
    libraryRoot: layout.libraryRoot,
    lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
    allowLegacyRoute: legacy ? initial.source.routeSlug : null,
    extraLockKeys: legacy ? [`legacy:${initial.source.routeSlug}`, `migration:${initial.migrationId}`] : [`migration:${initial.migrationId}`],
    beforeIndexCommit: legacy ? () => {
      moveLegacySourceToArchive(layout, initial)
      maybeFault(options, 'after_legacy_archive')
    } : null,
    targetedIndex: true,
    faultAt: options.faultAt,
  })
  maybeFault(options, 'after_migration_publication')
  const updated = await withStorageLocks([`migration:${initial.migrationId}`], async (lockHandle) => {
    const current = readTransaction(initial.migrationId, { libraryRoot: layout.libraryRoot })
    return writeTransaction(layout, {
      ...current,
      state: 'committed',
      currentAfter: published.current,
      archive: {
        ...current.archive,
        sourceRelativePath: legacy ? archiveRelative(current.migrationId, 'source') : null,
      },
    }, lockHandle)
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
  return { migrationId: updated.migrationId, committed: true, current: updated.currentAfter, manifestId: published.manifestId, manifestHash: published.manifestHash }
}

function authorityKeys(transaction) {
  return [
    'registry',
    ...(transaction.source.kind === 'legacy_flat' ? [`legacy:${transaction.source.routeSlug}`] : []),
    `paper:${transaction.target.paperKey}`,
    `migration:${transaction.migrationId}`,
    'index',
  ]
}

function writeCurrent(recordDir, value, lockHandle, paperKey) {
  const target = path.join(recordDir, 'current.json')
  atomicWriteJson({
    root: recordDir,
    relativePath: 'current.json',
    value,
    lockHandle,
    requiredLock: `paper:${paperKey}`,
    maxBytes: 4 * 1024 * 1024,
    ...fileWritePrecondition(target, 4 * 1024 * 1024),
  })
}

function verifyManagedCurrent(recordDir, current) {
  const record = path.basename(recordDir) === current.paperKey
    ? readPaperRecord(recordDir)
    : validatePaperRecord(readJsonNoFollow(path.join(recordDir, 'paper.json'), 'paper.json'), current.paperKey)
  requireNoFollowDirectory(path.dirname(recordDir), recordDir, 'PAPER_RECORD_NOT_FOUND')
  validateCurrentRecord(current, record)
  const packageDir = requireNoFollowDirectory(
    recordDir,
    path.join(recordDir, ...current.packageRelativePath.split('/')),
    'PAPER_GENERATION_NOT_FOUND',
  )
  verifyGenerationManifestBinding(packageDir, {
    manifestId: current.manifestId,
    manifestHash: current.manifestHash,
    manifestFileSha256: current.manifestFileSha256,
    paperKey: current.paperKey,
    generationId: current.generationId,
  })
  return record
}

function sameCurrent(left, right) {
  return Boolean(left && right)
    && left.paperKey === right.paperKey
    && left.paperId === right.paperId
    && left.sourceRevisionId === right.sourceRevisionId
    && left.generationId === right.generationId
    && left.packageRelativePath === right.packageRelativePath
    && left.manifestId === right.manifestId
    && left.manifestHash === right.manifestHash
    && left.manifestFileSha256 === right.manifestFileSha256
    && left.validationReportHash === right.validationReportHash
}

function liveManagedCurrent(recordDir) {
  if (!fs.existsSync(path.join(recordDir, 'paper.json')) || !fs.existsSync(path.join(recordDir, 'current.json'))) return null
  const record = readPaperRecord(recordDir)
  return readCurrentRecord(recordDir, record)
}

async function switchManaged(transaction, toTarget, options = {}) {
  const layout = prepareMigrationLayout(options.libraryRoot)
  return withStorageLocks(authorityKeys(transaction), async (lockHandle) => {
    let currentTransaction = readTransaction(transaction.migrationId, { libraryRoot: layout.libraryRoot })
    const recordDir = path.join(layout.recordsRoot, transaction.target.paperKey)
    const desired = toTarget ? currentTransaction.currentAfter : currentTransaction.currentBefore
    const expectedSource = toTarget ? currentTransaction.currentBefore : currentTransaction.currentAfter
    if (!desired) throw new GenerationMigrationError('MIGRATION_ROLLBACK_UNAVAILABLE', 'Migration does not contain the requested managed current binding.', 409)
    const live = liveManagedCurrent(recordDir)
    const alreadySwitched = sameCurrent(live, desired)
    if (!sameCurrent(live, expectedSource) && !(currentTransaction.state === (toTarget ? 'rolling_forward' : 'rolling_back') && alreadySwitched)) {
      throw new GenerationMigrationError('MIGRATION_CURRENT_CONFLICT', 'Published current generation changed outside this migration transaction.', 409)
    }
    const record = verifyManagedCurrent(recordDir, desired)
    if (currentTransaction.state !== (toTarget ? 'rolling_forward' : 'rolling_back')) {
      currentTransaction = writeTransaction(layout, { ...currentTransaction, state: toTarget ? 'rolling_forward' : 'rolling_back' }, lockHandle)
    }
    if (!alreadySwitched) {
      writeCurrent(recordDir, desired, lockHandle, record.paperKey)
      maybeFault(options, 'after_managed_current_switch')
    }
    writeRebuiltIndexLocked(layout.libraryRoot, lockHandle, {
      paperRef: currentTransaction.target.paperKey,
      descriptor: {
        mode: 'managed_v1',
        paperKey: currentTransaction.target.paperKey,
        routeSlug: currentTransaction.target.routeSlug,
        routeAliases: [currentTransaction.target.routeSlug],
        replaceLegacyRoute: currentTransaction.source.kind === 'legacy_flat',
      },
    })
    currentTransaction = writeTransaction(layout, { ...currentTransaction, state: toTarget ? 'committed' : 'rolled_back' }, lockHandle)
    return currentTransaction
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

async function switchLegacy(transaction, toTarget, options = {}) {
  const layout = prepareMigrationLayout(options.libraryRoot)
  return withStorageLocks(authorityKeys(transaction), async (lockHandle) => {
    let currentTransaction = readTransaction(transaction.migrationId, { libraryRoot: layout.libraryRoot })
    const archiveDir = path.join(layout.archivesRoot, transaction.migrationId)
    const sourceArchive = path.join(archiveDir, 'source')
    const targetArchive = path.join(archiveDir, 'target')
    const legacyPath = path.join(layout.libraryRoot, ...transaction.source.relativePath.split('/'))
    const recordDir = path.join(layout.recordsRoot, transaction.target.paperKey)
    const sourceArchived = fs.existsSync(sourceArchive)
    const legacyPresent = fs.existsSync(legacyPath)
    const recordPresent = fs.existsSync(recordDir)
    const targetPresent = fs.existsSync(targetArchive)
    const conflictCode = toTarget ? 'MIGRATION_ROLLFORWARD_CONFLICT' : 'MIGRATION_ROLLBACK_CONFLICT'
    if (sourceArchived === legacyPresent || recordPresent === targetPresent || (legacyPresent && recordPresent)) {
      throw new GenerationMigrationError(conflictCode, 'Legacy migration authority state is ambiguous or incomplete.', 409)
    }
    const retainedSource = legacyPresent ? legacyPath : sourceArchive
    if (migrationSourceSnapshot(retainedSource, 'legacy_flat').snapshotHash !== currentTransaction.source.snapshotHash) {
      throw new GenerationMigrationError(conflictCode, 'Retained legacy source no longer matches the migration snapshot.', 409)
    }
    if (recordPresent && !sameCurrent(liveManagedCurrent(recordDir), currentTransaction.currentAfter)) {
      throw new GenerationMigrationError('MIGRATION_CURRENT_CONFLICT', 'Published current generation changed outside this migration transaction.', 409)
    }
    verifyManagedCurrent(recordPresent ? recordDir : targetArchive, currentTransaction.currentAfter)
    if (toTarget && currentTransaction.state === 'rolled_back'
      && (!legacyPresent || !targetPresent || sourceArchived || recordPresent)) {
      throw new GenerationMigrationError(conflictCode, 'Legacy roll-forward did not begin from the settled rolled-back authority.', 409)
    }
    if (!toTarget && currentTransaction.state === 'committed'
      && (!sourceArchived || !recordPresent || legacyPresent || targetPresent)) {
      throw new GenerationMigrationError('MIGRATION_CURRENT_CONFLICT', 'Published current generation changed after migration.', 409)
    }
    if (currentTransaction.state !== (toTarget ? 'rolling_forward' : 'rolling_back')) {
      currentTransaction = writeTransaction(layout, { ...currentTransaction, state: toTarget ? 'rolling_forward' : 'rolling_back' }, lockHandle)
    }
    if (toTarget) {
      if (legacyPresent && !sourceArchived) {
        fs.renameSync(legacyPath, sourceArchive)
        fsyncDirectory(layout.legacyPapersRoot)
        maybeFault(options, 'after_legacy_source_archive')
      }
      if (!recordPresent && targetPresent) {
        fs.renameSync(targetArchive, recordDir)
        fsyncDirectory(layout.recordsRoot)
        maybeFault(options, 'after_legacy_target_restore')
      }
    } else {
      if (recordPresent && !targetPresent) {
        fs.renameSync(recordDir, targetArchive)
        fsyncDirectory(layout.recordsRoot)
        maybeFault(options, 'after_legacy_target_archive')
      }
      if (!legacyPresent && sourceArchived) {
        fs.renameSync(sourceArchive, legacyPath)
        fsyncDirectory(layout.legacyPapersRoot)
        maybeFault(options, 'after_legacy_source_restore')
      }
    }
    writeRebuiltIndexLocked(layout.libraryRoot, lockHandle, {
      paperRef: currentTransaction.target.routeSlug,
      descriptor: toTarget
        ? {
            mode: 'managed_v1',
            paperKey: currentTransaction.target.paperKey,
            routeSlug: currentTransaction.target.routeSlug,
            routeAliases: [currentTransaction.target.routeSlug],
            replaceLegacyRoute: true,
          }
        : {
            mode: 'legacy_flat',
            paperKey: null,
            routeSlug: currentTransaction.source.routeSlug,
            routeAliases: [currentTransaction.source.routeSlug],
            replaceManagedRoute: true,
          },
    })
    currentTransaction = writeTransaction(layout, {
      ...currentTransaction,
      state: toTarget ? 'committed' : 'rolled_back',
      archive: {
        sourceRelativePath: toTarget ? archiveRelative(transaction.migrationId, 'source') : null,
        targetRelativePath: toTarget ? null : archiveRelative(transaction.migrationId, 'target'),
      },
    }, lockHandle)
    return currentTransaction
  }, { libraryRoot: layout.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 })
}

export async function rollbackGenerationMigration(migrationId, expectedManifestHash, options = {}) {
  if (!HASH_PATTERN.test(String(expectedManifestHash || ''))) throw new GenerationMigrationError('ARGUMENT_INVALID', 'Expected current manifest hash is required.', 400)
  const transaction = readTransaction(migrationId, options)
  if (transaction.state === 'rolled_back') return { migrationId, rolledBack: true, reused: true }
  if (!['committed', 'rolling_back'].includes(transaction.state) || transaction.currentAfter?.manifestHash !== expectedManifestHash) {
    throw new GenerationMigrationError('MIGRATION_CURRENT_CONFLICT', 'Current generation does not match the requested migration rollback CAS.', 409)
  }
  const result = transaction.source.kind === 'legacy_flat'
    ? await switchLegacy(transaction, false, options)
    : await switchManaged(transaction, false, options)
  return { migrationId, rolledBack: true, state: result.state }
}

export async function rollforwardGenerationMigration(migrationId, options = {}) {
  const transaction = readTransaction(migrationId, options)
  if (transaction.state === 'committed') return { migrationId, rolledForward: true, reused: true }
  if (!['rolled_back', 'rolling_forward'].includes(transaction.state)) throw new GenerationMigrationError('MIGRATION_STATE_CONFLICT', 'Migration is not rolled back.', 409)
  const result = transaction.source.kind === 'legacy_flat'
    ? await switchLegacy(transaction, true, options)
    : await switchManaged(transaction, true, options)
  return { migrationId, rolledForward: true, state: result.state, current: result.currentAfter }
}

export async function recoverGenerationMigrations(options = {}) {
  const layout = prepareMigrationLayout(options.libraryRoot)
  const results = []
  for (const entry of fs.readdirSync(layout.transactionsRoot).filter((name) => name.endsWith('.json')).sort()) {
    const migrationId = entry.slice(0, -5)
    try {
      const transaction = readTransaction(migrationId, { libraryRoot: layout.libraryRoot })
      if (transaction.state === 'committing') {
        results.push({ migrationId, success: true, result: await commitGenerationMigration(migrationId, options) })
      } else if (transaction.state === 'rolling_back') {
        results.push({ migrationId, success: true, result: await rollbackGenerationMigration(migrationId, transaction.currentAfter.manifestHash, options) })
      } else if (transaction.state === 'rolling_forward') {
        results.push({ migrationId, success: true, result: await rollforwardGenerationMigration(migrationId, options) })
      }
    } catch (error) {
      results.push({ migrationId, success: false, code: error.code || 'MIGRATION_RECOVERY_FAILED', message: String(error.message).slice(0, 600) })
    }
  }
  return {
    recovered: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
    transactions: results,
  }
}
