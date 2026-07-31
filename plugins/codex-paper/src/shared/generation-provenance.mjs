import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  atomicWriteFile,
  atomicWriteJson,
  fileWritePrecondition,
  readFileNoFollowBounded,
} from './storage-transaction.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '../..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..')
export const RUNTIME_POLICY_PATH = path.join(PLUGIN_ROOT, 'runtime/runtime-baseline.json')
export const PARSER_POLICY_PATH = path.join(PLUGIN_ROOT, 'skills/study/scripts/pdf-security-policy.json')
export const PROVENANCE_DRAFT_VERSION = '1.0.0'
export const PROVENANCE_DRAFT_FILENAME = 'provenance-draft.json'
export const MANIFEST_VERSION = '2.0.0'
export const MAX_AUTHORING_EVENTS = 2048
export const MAX_AUTHORING_DEPENDENCIES = 64
const HASH_PATTERN = /^[a-f0-9]{64}$/
const ACTORS = new Set(['codex', 'human', 'unknown', 'tool'])
const EVENT_STATES = new Set(['pending', 'completed', 'aborted'])
const README_START = '<!-- codex-paper-provenance:start -->'
const README_END = '<!-- codex-paper-provenance:end -->'

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

function readJsonNoFollow(filename, maxBytes = 8 * 1024 * 1024) {
  try {
    return JSON.parse(readFileNoFollowBounded(filename, maxBytes).toString('utf8'))
  } catch (error) {
    if (error?.code) throw error
    const wrapped = new Error('Provenance JSON is invalid.')
    wrapped.code = 'PROVENANCE_INVALID'
    wrapped.statusCode = 422
    throw wrapped
  }
}

function bounded(value, max = 256) {
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.slice(0, max)
}

function validBoundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key))
}

function validObservation(value, max = 160) {
  return hasOnlyKeys(value, ['status', 'value'])
    && ['observed', 'unavailable'].includes(value.status)
    && (value.value === null || validBoundedText(value.value, max))
}

function validDiagnostic(value) {
  return hasOnlyKeys(value, ['code', 'message'])
    && /^[A-Z][A-Z0-9_]{2,79}$/.test(String(value.code || ''))
    && validBoundedText(value.message, 300)
}

function validRuntimeRecord(runtime) {
  return hasOnlyKeys(runtime, [
    'schemaVersion', 'policyVersion', 'policySha256', 'contentStatus', 'contentChecks',
    'host', 'tooling', 'parserPolicy', 'sandbox', 'contentAffecting', 'toolingOnly',
  ])
    && runtime.schemaVersion === '1.0.0'
    && validBoundedText(runtime.policyVersion, 80)
    && HASH_PATTERN.test(String(runtime.policySha256 || ''))
    && runtime.contentStatus === 'conformant'
    && hasOnlyKeys(runtime.contentChecks, ['node', 'python', 'pyMuPDF', 'parserPolicy'])
    && Object.values(runtime.contentChecks).every((value) => value === true)
    && hasOnlyKeys(runtime.host, ['os', 'arch', 'release', 'node', 'python'])
    && [runtime.host.os, runtime.host.arch, runtime.host.release, runtime.host.node].every((value) => validBoundedText(value, 80))
    && hasOnlyKeys(runtime.host.python, ['version', 'implementation', 'pyMuPDF'])
    && runtime.host.python.implementation === 'CPython'
    && validBoundedText(runtime.host.python.version, 40)
    && validBoundedText(runtime.host.python.pyMuPDF, 40)
    && hasOnlyKeys(runtime.tooling, ['npm'])
    && (runtime.tooling.npm === null || validBoundedText(runtime.tooling.npm, 40))
    && hasOnlyKeys(runtime.parserPolicy, ['version', 'sha256'])
    && validBoundedText(runtime.parserPolicy.version, 80)
    && HASH_PATTERN.test(String(runtime.parserPolicy.sha256 || ''))
    && hasOnlyKeys(runtime.sandbox, ['node', 'python', 'nodeBaseImage', 'pythonBaseImage', 'scope'])
    && runtime.sandbox.scope === 'sandbox-only'
    && [runtime.sandbox.node, runtime.sandbox.python].every((value) => validBoundedText(value, 40))
    && [runtime.sandbox.nodeBaseImage, runtime.sandbox.pythonBaseImage].every((value) => /@sha256:[a-f0-9]{64}$/.test(String(value || '')))
    && [runtime.contentAffecting, runtime.toolingOnly].every((items) =>
      Array.isArray(items) && items.every((value) => validBoundedText(value, 120)))
}

function validSoftwareRecord(software) {
  return hasOnlyKeys(software, ['repository', 'plugin', 'skill', 'codex', 'schemas', 'validator', 'diagnostics'])
    && hasOnlyKeys(software.repository, ['commit', 'status', 'treeState'])
    && ['observed', 'unavailable'].includes(software.repository.status)
    && (software.repository.commit === null || /^[a-f0-9]{40}$/.test(software.repository.commit))
    && ['clean', 'dirty', 'unavailable'].includes(software.repository.treeState)
    && hasOnlyKeys(software.plugin, ['baseVersion', 'buildVersion'])
    && validBoundedText(software.plugin.baseVersion, 40)
    && validBoundedText(software.plugin.buildVersion, 120)
    && hasOnlyKeys(software.skill, ['name', 'sha256'])
    && ['paper-study', 'paper-summary'].includes(software.skill.name)
    && HASH_PATTERN.test(String(software.skill.sha256 || ''))
    && hasOnlyKeys(software.codex, ['product', 'cliVersion', 'status', 'authoringEngine'])
    && software.codex.product === 'codex'
    && validObservation({ status: software.codex.status, value: software.codex.cliVersion })
    && hasOnlyKeys(software.codex.authoringEngine, ['provider', 'model', 'evidence'])
    && validBoundedText(software.codex.authoringEngine.provider, 80)
    && validBoundedText(software.codex.authoringEngine.model, 160)
    && ['declared', 'unavailable'].includes(software.codex.authoringEngine.evidence)
    && Array.isArray(software.schemas) && software.schemas.length > 0
    && software.schemas.every((item) => hasOnlyKeys(item, ['name', 'version', 'path', 'sha256'])
      && validBoundedText(item.name, 80) && validBoundedText(item.version, 40)
      && safeRelative(item.path) && HASH_PATTERN.test(String(item.sha256 || '')))
    && hasOnlyKeys(software.validator, ['name', 'version', 'sha256'])
    && validBoundedText(software.validator.name, 80)
    && validBoundedText(software.validator.version, 40)
    && HASH_PATTERN.test(String(software.validator.sha256 || ''))
    && Array.isArray(software.diagnostics) && software.diagnostics.every(validDiagnostic)
}

function safeRelative(relativePath) {
  return typeof relativePath === 'string' && relativePath && relativePath.length <= 512
    && !relativePath.includes('\0') && !relativePath.includes('\\') && !path.posix.isAbsolute(relativePath)
    && !relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
}

function validSanitizedHttps(value) {
  if (typeof value !== 'string') return false
  const sanitized = sanitizeSourceLocator(value)
  return sanitized?.locator === value && !sanitized.queryPresent && !sanitized.credentialsPresent
}

function runtimeRoot(env = process.env) {
  return env.CODEX_PAPER_RUNTIME_DIR
    ? path.resolve(env.CODEX_PAPER_RUNTIME_DIR)
    : path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), '.cache'), 'codex-paper/runtime-v1')
}

function npmVersion(env) {
  const result = spawnSync(env.NPM_BIN || 'npm', ['--version'], { encoding: 'utf8', env, timeout: 3000 })
  return result.status === 0 ? bounded(result.stdout, 40) : null
}

function pythonObservation(policy, env) {
  const python = env.CODEX_PAPER_PYTHON_BIN
    || path.join(runtimeRoot(env), `python-${policy.host.python}`, 'bin/python')
  try {
    const stats = fs.lstatSync(python)
    if (stats.isSymbolicLink() || !stats.isFile()) return null
    const script = [
      'import json,platform',
      'import fitz',
      'print(json.dumps({"version":platform.python_version(),"implementation":platform.python_implementation(),"pyMuPDF":fitz.__version__}))',
    ].join(';')
    const result = spawnSync(python, ['-I', '-B', '-c', script], {
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PYTHON') && !key.startsWith('DYLD_') && key !== 'LD_PRELOAD' && key !== 'LD_LIBRARY_PATH')),
      timeout: 5000,
      maxBuffer: 64 * 1024,
    })
    return result.status === 0 ? JSON.parse(result.stdout) : null
  } catch {
    return null
  }
}

export function collectRuntimeAttestation(env = process.env, overrides = {}) {
  const policyBytes = readFileNoFollowBounded(RUNTIME_POLICY_PATH, 1024 * 1024)
  const parserPolicyBytes = readFileNoFollowBounded(PARSER_POLICY_PATH, 1024 * 1024)
  const policy = JSON.parse(policyBytes)
  const python = overrides.python || pythonObservation(policy, env)
  const observedNode = overrides.node || process.versions.node
  const contentChecks = {
    node: observedNode === policy.host.node,
    python: python?.version === policy.host.python
      && python?.implementation === policy.host.pythonImplementation,
    pyMuPDF: python?.pyMuPDF === policy.host.pyMuPDF,
    parserPolicy: true,
  }
  return {
    schemaVersion: '1.0.0',
    policyVersion: policy.policyVersion,
    policySha256: sha256(policyBytes),
    contentStatus: Object.values(contentChecks).every(Boolean) ? 'conformant' : 'nonconformant',
    contentChecks,
    host: {
      os: process.platform,
      arch: process.arch,
      release: bounded(os.release(), 80),
      node: observedNode,
      python: python ? {
        version: python.version,
        implementation: python.implementation,
        pyMuPDF: python.pyMuPDF,
      } : null,
    },
    tooling: {
      npm: overrides.npm === undefined ? npmVersion(env) : overrides.npm,
    },
    parserPolicy: {
      version: JSON.parse(parserPolicyBytes).policyVersion,
      sha256: sha256(parserPolicyBytes),
    },
    sandbox: policy.sandbox,
    contentAffecting: policy.contentAffecting,
    toolingOnly: policy.toolingOnly,
  }
}

export function runtimeGenerationContract(attestation) {
  return {
    policyVersion: attestation.policyVersion,
    policySha256: attestation.policySha256,
    node: attestation.host.node,
    python: attestation.host.python?.version || 'unavailable',
    pyMuPDF: attestation.host.python?.pyMuPDF || 'unavailable',
    parserPolicyVersion: attestation.parserPolicy.version,
    parserPolicySha256: attestation.parserPolicy.sha256,
  }
}

export function assertContentRuntime(attestation) {
  if (attestation?.contentStatus !== 'conformant') {
    let policy = null
    try { policy = JSON.parse(readFileNoFollowBounded(RUNTIME_POLICY_PATH, 1024 * 1024)) } catch {}
    const failedChecks = Object.entries(attestation?.contentChecks || {})
      .filter(([, passed]) => passed !== true)
      .map(([check]) => check)
      .sort()
    const error = new Error(`The content runtime is nonconformant (${failedChecks.join(', ') || 'attestation unavailable'}). Run "bash scripts/codex-paper.sh runtime-status"; provision Node ${policy?.host?.node || 'from runtime policy'} and then run "bash scripts/codex-paper.sh runtime-setup".`)
    error.code = 'PROVENANCE_RUNTIME_NONCONFORMANT'
    error.statusCode = 503
    error.details = {
      failedChecks,
      expected: {
        node: policy?.host?.node || null,
        python: policy?.host?.python || null,
        pyMuPDF: policy?.host?.pyMuPDF || null,
        parserPolicy: true,
      },
      observed: {
        node: attestation?.host?.node || null,
        python: attestation?.host?.python?.version || null,
        pyMuPDF: attestation?.host?.python?.pyMuPDF || null,
        parserPolicy: attestation?.contentChecks?.parserPolicy === true,
      },
    }
    throw error
  }
  return attestation
}

export function normalizeAuthoringEngine(provider = 'unavailable', model = 'unavailable') {
  const normalizedProvider = bounded(provider, 80) || 'unavailable'
  const normalizedModel = bounded(model, 160) || 'unavailable'
  return {
    provider: normalizedProvider,
    model: normalizedModel,
    evidence: normalizedProvider === 'unavailable' || normalizedModel === 'unavailable' ? 'unavailable' : 'declared',
  }
}

export function sanitizeSourceLocator(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') return null
    const queryPresent = Boolean(parsed.search)
    const credentialsPresent = Boolean(parsed.username || parsed.password)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return { locator: parsed.toString(), queryPresent, credentialsPresent }
  } catch {
    return null
  }
}

export function arxivVersionFromLocator(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'arxiv.org') return null
    return url.pathname.match(/(?:^|\/)(?:[a-z-]+\/)?(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]+\/\d{7})(v\d+)(?:\.pdf)?$/i)?.[1]?.toLowerCase() || null
  } catch {
    return null
  }
}

export function deriveManifestId({ paperKey, sourceRevisionId, generationId }) {
  return `gm-sha256-${sha256(stableJson({
    schemaVersion: MANIFEST_VERSION,
    paperKey,
    sourceRevisionId,
    generationId,
  }))}`
}

function commandObservation(command, args, pattern, max = 160) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 })
    const output = bounded(result.stdout || result.stderr, max)
    return result.status === 0 && (!pattern || pattern.test(output))
      ? { status: 'observed', value: output }
      : { status: 'unavailable', value: null }
  } catch {
    return { status: 'unavailable', value: null }
  }
}

export function collectRepositoryProvenance(repoRoot = REPO_ROOT) {
  const topLevel = commandObservation('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], null, 4096)
  let exactRepository = false
  if (topLevel.status === 'observed') {
    try {
      exactRepository = fs.realpathSync(topLevel.value) === fs.realpathSync(repoRoot)
    } catch {
      exactRepository = false
    }
  }
  if (!exactRepository) return { commit: null, status: 'unavailable', treeState: 'unavailable' }
  const gitCommit = commandObservation('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], /^[a-f0-9]{40}$/)
  const gitDirty = commandObservation('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'], null, 4096)
  return {
    commit: gitCommit.value,
    status: gitCommit.status,
    treeState: gitDirty.status === 'observed' ? (gitDirty.value ? 'dirty' : 'clean') : 'unavailable',
  }
}

export function collectSoftwareProvenance(identity) {
  const repository = collectRepositoryProvenance()
  const codex = commandObservation(process.env.CODEX_BIN || 'codex', ['--version'], /^codex-cli\s+\S+/)
  const skillPath = path.join(PLUGIN_ROOT, `skills/${identity.generation.inputs.workflow === 'summary' ? 'summary' : 'study'}/SKILL.md`)
  const identitySchemaPath = {
    '1.0.0': 'skills/study/schemas/paper-identity-1.0.schema.json',
    '2.0.0': 'skills/study/schemas/paper-identity-2.0.schema.json',
  }[identity.schemaVersion]
  if (!identitySchemaPath) {
    const error = new Error('Paper Identity schema version has no exact provenance schema mapping.')
    error.code = 'PROVENANCE_CONFIG_INVALID'
    error.statusCode = 500
    throw error
  }
  const schemas = [
    ['paperIdentity', identitySchemaPath, identity.schemaVersion],
    ['evidenceLedger', 'skills/study/schemas/evidence-ledger.schema.json', identity.generation.inputs.evidenceSchemaVersion],
    ['facts', 'skills/study/schemas/facts-2.1.schema.json', identity.generation.inputs.factsSchemaVersion],
    ['reasoning', 'skills/study/schemas/reasoning-analysis.schema.json', identity.generation.inputs.reasoningSchemaVersion],
    ['validation', 'skills/study/schemas/validation-report-1.0.schema.json', '1.0.0'],
    ['generationManifest', 'skills/study/schemas/generation-manifest-2.0.schema.json', MANIFEST_VERSION],
  ].map(([name, relativePath, version]) => {
    const absolute = path.join(PLUGIN_ROOT, relativePath)
    return { name, version, path: relativePath, sha256: sha256(readFileNoFollowBounded(absolute, 8 * 1024 * 1024)) }
  }).sort((left, right) => left.name.localeCompare(right.name))
  const diagnostics = []
  if (repository.status === 'unavailable') diagnostics.push({ code: 'REPOSITORY_COMMIT_UNAVAILABLE', message: 'Repository commit was not observable for the exact codex-paper repository root.' })
  if (codex.status === 'unavailable') diagnostics.push({ code: 'CODEX_VERSION_UNAVAILABLE', message: 'Codex CLI version was not observable.' })
  if (identity.generation.inputs.authoringEngine.evidence === 'unavailable') diagnostics.push({ code: 'AUTHORING_MODEL_UNAVAILABLE', message: 'Authoring model/provider was not exposed to the workflow.' })
  return {
    repository,
    plugin: {
      baseVersion: identity.generation.inputs.pluginBaseVersion,
      buildVersion: identity.provenance.pluginBuildVersion,
    },
    skill: {
      name: identity.generation.inputs.workflow === 'summary' ? 'paper-summary' : 'paper-study',
      sha256: sha256(readFileNoFollowBounded(skillPath, 8 * 1024 * 1024)),
    },
    codex: {
      product: 'codex',
      cliVersion: codex.value,
      status: codex.status,
      authoringEngine: identity.generation.inputs.authoringEngine,
    },
    schemas,
    validator: {
      name: 'codex-paper-validation',
      version: '1.0.0',
      sha256: sha256(readFileNoFollowBounded(path.join(PLUGIN_ROOT, 'skills/study/scripts/validation-report.js'), 8 * 1024 * 1024)),
    },
    diagnostics,
  }
}

function sourceRecord(source, identity) {
  const requested = sanitizeSourceLocator(source.requestedUrl)
  const resolved = sanitizeSourceLocator(source.resolvedUrl)
  const canonical = identity.canonical || {}
  const arxiv = [canonical.primary, ...(canonical.aliases || [])].find((item) => item?.kind === 'arxiv') || null
  const doi = [canonical.primary, ...(canonical.aliases || [])].find((item) => item?.kind === 'doi') || null
  return {
    kind: source.kind === 'remote_https' ? 'remote_https' : 'local_file',
    requestedLocator: requested?.locator || null,
    resolvedLocator: resolved?.locator || null,
    queryPresent: Boolean(requested?.queryPresent || resolved?.queryPresent),
    credentialsPresent: Boolean(requested?.credentialsPresent || resolved?.credentialsPresent),
    filename: bounded(source.filename, 255),
    bytes: source.bytes,
    sha256: identity.source.sha256,
    acquiredAt: source.acquiredAt,
    canonical: {
      doi: doi?.value || null,
      arxiv: arxiv?.value || null,
      arxivVersion: arxivVersionFromLocator(source.requestedUrl) || arxivVersionFromLocator(source.resolvedUrl),
    },
  }
}

export function buildProvenanceDraft({ workspaceId, paperKey, sourceRevisionId, generationId, identity, runtime, source, software = null, now = new Date().toISOString() }) {
  const manifestId = deriveManifestId({ paperKey, sourceRevisionId, generationId })
  const draft = {
    schemaVersion: PROVENANCE_DRAFT_VERSION,
    manifestSchemaVersion: MANIFEST_VERSION,
    manifestId,
    workspaceId,
    paperKey,
    sourceRevisionId,
    generationId,
    source: sourceRecord(source, identity),
    runtime,
    software: software || collectSoftwareProvenance(identity),
    authoringEvents: [],
    migrations: [],
    createdAt: now,
    updatedAt: now,
  }
  return validateProvenanceDraft(draft)
}

export function validateProvenanceDraft(draft, expected = {}) {
  if (!hasOnlyKeys(draft, [
    'schemaVersion', 'manifestSchemaVersion', 'manifestId', 'workspaceId', 'paperKey',
    'sourceRevisionId', 'generationId', 'source', 'runtime', 'software',
    'authoringEvents', 'migrations', 'createdAt', 'updatedAt',
  ])
    || draft?.schemaVersion !== PROVENANCE_DRAFT_VERSION
    || draft?.manifestSchemaVersion !== MANIFEST_VERSION
    || !/^gm-sha256-[a-f0-9]{64}$/.test(String(draft?.manifestId || ''))
    || !/^ws-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{32}$/.test(String(draft?.workspaceId || ''))
    || (expected.workspaceId && draft.workspaceId !== expected.workspaceId)
    || !/^p-[a-f0-9]{64}$/.test(String(draft?.paperKey || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(draft?.sourceRevisionId || ''))
    || !/^gen:sha256:[a-f0-9]{64}$/.test(String(draft?.generationId || ''))
    || draft?.source?.sha256 !== draft.sourceRevisionId.replace(/^sha256:/, '')
    || !Number.isInteger(draft?.source?.bytes) || draft.source.bytes < 5
    || !['local_file', 'remote_https'].includes(draft?.source?.kind)
    || !validBoundedText(draft?.source?.filename, 255)
    || draft.source.filename.includes('/') || draft.source.filename.includes('\\')
    || typeof draft.source.queryPresent !== 'boolean'
    || typeof draft.source.credentialsPresent !== 'boolean'
    || (draft.source.kind === 'remote_https' && (
      typeof draft.source.requestedLocator !== 'string'
      || typeof draft.source.resolvedLocator !== 'string'
      || !draft.source.requestedLocator.startsWith('https://')
      || !draft.source.resolvedLocator.startsWith('https://')
    ))
    || (draft.source.kind === 'local_file' && (
      draft.source.requestedLocator !== null || draft.source.resolvedLocator !== null
    ))
    || Number.isNaN(Date.parse(draft?.source?.acquiredAt))
    || !hasOnlyKeys(draft.source, [
      'kind', 'requestedLocator', 'resolvedLocator', 'queryPresent', 'credentialsPresent',
      'filename', 'bytes', 'sha256', 'acquiredAt', 'canonical',
    ])
    || !hasOnlyKeys(draft.source.canonical, ['doi', 'arxiv', 'arxivVersion'])
    || (draft.source.kind === 'remote_https'
      && (!validSanitizedHttps(draft.source.requestedLocator) || !validSanitizedHttps(draft.source.resolvedLocator)))
    || ![draft.source.canonical.doi, draft.source.canonical.arxiv, draft.source.canonical.arxivVersion]
      .every((value) => value === null || validBoundedText(value, 255))
    || !validRuntimeRecord(draft.runtime)
    || !validSoftwareRecord(draft.software)
    || !Array.isArray(draft?.authoringEvents) || draft.authoringEvents.length > MAX_AUTHORING_EVENTS
    || !Array.isArray(draft?.migrations) || draft.migrations.length > 256
    || Number.isNaN(Date.parse(draft?.createdAt)) || Number.isNaN(Date.parse(draft?.updatedAt))) {
    const error = new Error('Workspace provenance draft is invalid.')
    error.code = 'PROVENANCE_DRAFT_INVALID'
    error.statusCode = 422
    throw error
  }
  const expectedId = deriveManifestId(draft)
  if (draft.manifestId !== expectedId) {
    const error = new Error('Workspace provenance draft manifest identity is invalid.')
    error.code = 'PROVENANCE_DRAFT_INVALID'
    error.statusCode = 422
    throw error
  }
  for (const [index, event] of draft.authoringEvents.entries()) {
    if (!hasOnlyKeys(event, [
      'sequence', 'eventId', 'state', 'actor', 'attestation', 'operation', 'path',
      'beforeSha256', 'afterSha256', 'dependencies', 'createdAt', 'completedAt', 'recovered',
    ])
      || !Number.isInteger(event?.sequence) || event.sequence !== index + 1
      || !/^ae-[a-f0-9]{32}$/.test(String(event?.eventId || ''))
      || !EVENT_STATES.has(event?.state) || !ACTORS.has(event?.actor)
      || event?.attestation !== 'declared'
      || !['create', 'replace'].includes(event?.operation)
      || !safeRelative(event?.path)
      || (![null, undefined].includes(event?.beforeSha256) && !HASH_PATTERN.test(String(event.beforeSha256)))
      || !HASH_PATTERN.test(String(event?.afterSha256 || ''))
      || !Array.isArray(event?.dependencies) || event.dependencies.length > MAX_AUTHORING_DEPENDENCIES
      || event.dependencies.some((item) => !hasOnlyKeys(item, ['path', 'sha256'])
        || !safeRelative(item?.path) || !HASH_PATTERN.test(String(item?.sha256 || '')))
      || Number.isNaN(Date.parse(event?.createdAt))
      || (event.state !== 'pending' && Number.isNaN(Date.parse(event?.completedAt)))) {
      const error = new Error('Workspace provenance authoring event is invalid.')
      error.code = 'PROVENANCE_DRAFT_INVALID'
      error.statusCode = 422
      throw error
    }
  }
  for (const migration of draft.migrations) {
    if (!migration || typeof migration !== 'object'
      || Object.keys(migration).some((key) => !['migrationId', 'fromVersion', 'toVersion', 'toolVersion', 'appliedAt', 'backupId', 'rollbackAvailable'].includes(key))
      || !validBoundedText(migration.migrationId, 128)
      || !validBoundedText(migration.fromVersion, 40)
      || !validBoundedText(migration.toVersion, 40)
      || !validBoundedText(migration.toolVersion, 80)
      || Number.isNaN(Date.parse(migration.appliedAt))
      || !validBoundedText(migration.backupId, 160)
      || typeof migration.rollbackAvailable !== 'boolean') {
      const error = new Error('Workspace provenance migration event is invalid.')
      error.code = 'PROVENANCE_DRAFT_INVALID'
      error.statusCode = 422
      throw error
    }
  }
  return draft
}

export function readProvenanceDraft(workspace) {
  let draft
  try {
    draft = readJsonNoFollow(path.join(workspace.workspaceDir, PROVENANCE_DRAFT_FILENAME))
  } catch (cause) {
    const missing = cause?.code === 'ENOENT'
    const error = new Error(missing
      ? 'Workspace provenance draft is missing.'
      : 'Workspace provenance draft is unreadable or invalid.')
    error.code = missing ? 'PROVENANCE_DRAFT_MISSING' : 'PROVENANCE_DRAFT_INVALID'
    error.statusCode = missing ? 404 : 422
    error.details = { causeCode: String(cause?.code || 'PROVENANCE_DRAFT_READ_FAILED') }
    throw error
  }
  return validateProvenanceDraft(draft, { workspaceId: workspace.workspaceId })
}

export function appendMigrationEvent(workspace, migration, lockHandle) {
  lockHandle.assertOwns(workspace.workspaceLockKey)
  const draft = readProvenanceDraft(workspace)
  if (draft.migrations.some((item) => item.migrationId === migration?.migrationId)) {
    const existing = draft.migrations.find((item) => item.migrationId === migration.migrationId)
    if (stableJson(existing) !== stableJson(migration)) {
      const error = new Error('Workspace provenance already contains a different migration event with this ID.')
      error.code = 'PROVENANCE_MIGRATION_CONFLICT'
      error.statusCode = 409
      throw error
    }
    return draft
  }
  if (draft.migrations.length >= 256) {
    const error = new Error('Workspace provenance migration history is full.')
    error.code = 'PROVENANCE_MIGRATION_LIMIT_EXCEEDED'
    error.statusCode = 413
    throw error
  }
  return writeDraft(workspace, {
    ...draft,
    migrations: [...draft.migrations, migration],
  }, lockHandle)
}

export function writeInitialProvenanceDraft(initDir, draft, lockHandle, requiredLock) {
  return atomicWriteJson({
    root: initDir,
    relativePath: PROVENANCE_DRAFT_FILENAME,
    value: draft,
    lockHandle,
    requiredLock,
    expectAbsent: true,
    maxBytes: 8 * 1024 * 1024,
  })
}

function writeDraft(workspace, draft, lockHandle) {
  const target = path.join(workspace.workspaceDir, PROVENANCE_DRAFT_FILENAME)
  return atomicWriteJson({
    root: workspace.workspaceDir,
    relativePath: PROVENANCE_DRAFT_FILENAME,
    value: validateProvenanceDraft({ ...draft, updatedAt: new Date().toISOString() }, { workspaceId: workspace.workspaceId }),
    lockHandle,
    requiredLock: workspace.workspaceLockKey,
    maxBytes: 8 * 1024 * 1024,
    ...fileWritePrecondition(target, 8 * 1024 * 1024),
  })
}

export function defaultDependencies(relativePath, packageDir) {
  let candidates
  if (relativePath === 'reasoning-analysis.json' || relativePath === '.codex-paper/reasoning-review.md') {
    candidates = ['paper-data.json', 'evidence-ledger.json', 'facts.json', 'analysis.json']
  } else if (relativePath.startsWith('images/')) {
    candidates = ['paper.pdf']
  } else if (relativePath.startsWith('code/') || relativePath.endsWith('.md') || relativePath === 'index.html') {
    candidates = [
      fs.existsSync(path.join(packageDir, 'reasoning-analysis.json'))
        ? 'reasoning-analysis.json'
        : 'analysis.json',
      'evidence-ledger.json',
      'facts.json',
    ]
  } else candidates = []
  if (fs.existsSync(path.join(packageDir, '.codex-paper/external-evidence.json'))
    && (relativePath.endsWith('.md') || relativePath === 'index.html' || relativePath.startsWith('code/'))) {
    candidates.push('.codex-paper/external-evidence.json')
  }
  return [...new Set(candidates)].sort()
}

function dependenciesWithHashes(packageDir, paths) {
  const unique = [...new Set(paths)].sort()
  if (unique.length > MAX_AUTHORING_DEPENDENCIES) {
    const error = new Error(`Authoring dependencies exceed the ${MAX_AUTHORING_DEPENDENCIES}-path limit.`)
    error.code = 'PROVENANCE_DEPENDENCY_LIMIT_EXCEEDED'
    error.statusCode = 413
    throw error
  }
  return unique.map((relativePath) => {
    if (!safeRelative(relativePath)) {
      const error = new Error('Authoring dependency path is invalid.')
      error.code = 'PROVENANCE_DEPENDENCY_INVALID'
      error.statusCode = 400
      throw error
    }
    try {
      return {
        path: relativePath,
        sha256: sha256(readFileNoFollowBounded(path.join(packageDir, ...relativePath.split('/')), 128 * 1024 * 1024)),
      }
    } catch (cause) {
      const error = new Error(`Authoring dependency is missing or unreadable: ${relativePath}.`)
      error.code = 'PROVENANCE_DEPENDENCY_INVALID'
      error.statusCode = cause?.statusCode || (cause?.code === 'ENOENT' ? 409 : 422)
      error.details = { path: relativePath, causeCode: String(cause?.code || 'READ_FAILED') }
      throw error
    }
  })
}

export function applyReadmeProjection(data, manifestId) {
  const input = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  const without = input
    .replace(new RegExp(`${README_START}[\\s\\S]*?${README_END}\\s*`, 'g'), '')
    .replace(/^<!-- codex-paper-provenance:(?:start|end) -->\s*$/gm, '')
    .trimEnd()
  return `${without}\n\n${README_START}\nProvenance: Generation Manifest ${MANIFEST_VERSION} (\`${manifestId}\`)\n${README_END}\n`
}

export function writeAuthoringWithProvenance({ workspace, relativePath, data, precondition, actor = 'unknown', additionalDependencies = [], lockHandle, maxBytes = 16 * 1024 * 1024, mode = 0o600 }) {
  if (!ACTORS.has(actor)) {
    const error = new Error('Authoring actor must be codex, human, unknown, or tool.')
    error.code = 'PROVENANCE_ACTOR_INVALID'
    error.statusCode = 400
    throw error
  }
  let draft = recoverPendingAuthoringEvents(workspace, lockHandle)
  if (draft.authoringEvents.length >= MAX_AUTHORING_EVENTS) {
    const error = new Error('Workspace provenance authoring event budget is exhausted.')
    error.code = 'PROVENANCE_EVENT_LIMIT_EXCEEDED'
    error.statusCode = 413
    throw error
  }
  const bytes = Buffer.from(relativePath === 'README.md' ? applyReadmeProjection(data, draft.manifestId) : data)
  const target = path.join(workspace.packageDir, ...relativePath.split('/'))
  let beforeSha256 = null
  try { beforeSha256 = sha256(readFileNoFollowBounded(target, maxBytes)) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const afterSha256 = sha256(bytes)
  const dependencies = dependenciesWithHashes(
    workspace.packageDir,
    [...defaultDependencies(relativePath, workspace.packageDir), ...additionalDependencies],
  )
  const event = {
    sequence: draft.authoringEvents.length + 1,
    eventId: `ae-${crypto.randomBytes(16).toString('hex')}`,
    state: 'pending',
    actor,
    attestation: 'declared',
    operation: beforeSha256 === null ? 'create' : 'replace',
    path: relativePath,
    beforeSha256,
    afterSha256,
    dependencies,
    createdAt: new Date().toISOString(),
  }
  draft = { ...draft, authoringEvents: [...draft.authoringEvents, event] }
  writeDraft(workspace, draft, lockHandle)
  const result = atomicWriteFile({
    root: workspace.packageDir,
    relativePath,
    data: bytes,
    lockHandle,
    requiredLock: workspace.workspaceLockKey,
    maxBytes,
    mode,
    ...precondition,
  })
  draft = readProvenanceDraft(workspace)
  draft.authoringEvents[event.sequence - 1] = { ...event, state: 'completed', completedAt: new Date().toISOString() }
  writeDraft(workspace, draft, lockHandle)
  return result
}

export function recoverPendingAuthoringEvents(workspace, lockHandle) {
  let draft = readProvenanceDraft(workspace)
  let changed = false
  const events = draft.authoringEvents.map((event) => {
    if (event.state !== 'pending') return event
    let current = null
    try { current = sha256(readFileNoFollowBounded(path.join(workspace.packageDir, ...event.path.split('/')), 128 * 1024 * 1024)) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    changed = true
    if (current === event.afterSha256) return { ...event, state: 'completed', completedAt: new Date().toISOString(), recovered: true }
    if (current === event.beforeSha256 || (current === null && event.beforeSha256 === null)) {
      return { ...event, state: 'aborted', completedAt: new Date().toISOString(), recovered: true }
    }
    const error = new Error(`Pending authoring event ${event.eventId} for ${event.path} cannot be reconciled. Use provenance-resolve with --adopt-current to audit and adopt the current bytes, or abandon the workspace and prepare again.`)
    error.code = 'PROVENANCE_EVENT_UNRESOLVED'
    error.statusCode = 409
    error.details = {
      eventId: event.eventId,
      path: event.path,
      beforeSha256: event.beforeSha256,
      intendedSha256: event.afterSha256,
      currentSha256: current,
    }
    throw error
  })
  if (changed) {
    draft = { ...draft, authoringEvents: events }
    writeDraft(workspace, draft, lockHandle)
  }
  return draft
}

export function resolveUnresolvedAuthoringEvent(workspace, eventId, lockHandle) {
  let draft = readProvenanceDraft(workspace)
  const index = draft.authoringEvents.findIndex((event) => event.eventId === eventId)
  const event = draft.authoringEvents[index]
  if (!event || event.state !== 'pending') {
    const error = new Error('The requested authoring event is missing or is not pending.')
    error.code = 'PROVENANCE_EVENT_NOT_PENDING'
    error.statusCode = 409
    throw error
  }
  if (draft.authoringEvents.length >= MAX_AUTHORING_EVENTS) {
    const error = new Error('Workspace provenance authoring event budget is exhausted.')
    error.code = 'PROVENANCE_EVENT_LIMIT_EXCEEDED'
    error.statusCode = 413
    throw error
  }
  let currentBytes
  try {
    currentBytes = readFileNoFollowBounded(path.join(workspace.packageDir, ...event.path.split('/')), 128 * 1024 * 1024)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const missing = new Error('The unresolved artifact is missing; abandon the workspace and prepare again.')
      missing.code = 'PROVENANCE_EVENT_UNRESOLVED'
      missing.statusCode = 409
      throw missing
    }
    throw error
  }
  const currentSha256 = sha256(currentBytes)
  if (currentSha256 === event.beforeSha256 || currentSha256 === event.afterSha256) {
    return recoverPendingAuthoringEvents(workspace, lockHandle)
  }
  const now = new Date().toISOString()
  let dependencies
  try {
    dependencies = dependenciesWithHashes(workspace.packageDir, event.dependencies.map((item) => item.path))
  } catch (cause) {
    const missingDependency = cause?.details?.path || null
    const error = new Error(
      missingDependency
        ? `Pending authoring event ${event.eventId} cannot adopt current bytes because dependency ${missingDependency} is missing or unreadable; abandon the workspace and prepare again.`
        : `Pending authoring event ${event.eventId} cannot adopt current bytes because a recorded dependency is unavailable; abandon the workspace and prepare again.`,
    )
    error.code = 'PROVENANCE_EVENT_UNRESOLVED'
    error.statusCode = 409
    error.details = {
      eventId: event.eventId,
      path: event.path,
      missingDependency,
      causeCode: String(cause?.code || 'PROVENANCE_DEPENDENCY_INVALID'),
    }
    throw error
  }
  draft.authoringEvents[index] = { ...event, state: 'aborted', completedAt: now, recovered: true }
  draft.authoringEvents.push({
    sequence: draft.authoringEvents.length + 1,
    eventId: `ae-${crypto.randomBytes(16).toString('hex')}`,
    state: 'completed',
    actor: 'unknown',
    attestation: 'declared',
    operation: event.beforeSha256 === null ? 'create' : 'replace',
    path: event.path,
    beforeSha256: event.beforeSha256,
    afterSha256: currentSha256,
    dependencies,
    createdAt: now,
    completedAt: now,
    recovered: true,
  })
  writeDraft(workspace, draft, lockHandle)
  return draft
}

export function authoringSummary(draft) {
  const terminal = draft.authoringEvents.filter((event) => event.state !== 'pending')
  const completed = draft.authoringEvents.filter((event) => event.state === 'completed')
  const actors = new Set(terminal.map((event) => event.actor))
  return {
    status: actors.has('human') ? 'human_involved' : (actors.has('unknown') ? 'unknown' : 'codex_only'),
    lastEditedAt: completed.at(-1)?.completedAt || draft.createdAt,
    events: terminal,
  }
}

function graphDefaults(files) {
  const present = new Set(files.map((item) => item.path))
  const edges = []
  const add = (output, inputs) => {
    if (!present.has(output)) return
    for (const input of inputs) if (present.has(input)) edges.push({ from: input, to: output })
  }
  add('paper-data.json', ['paper.pdf'])
  add('evidence-ledger.json', ['paper.pdf', 'paper-data.json'])
  add('facts.json', ['evidence-ledger.json'])
  add('analysis.json', ['paper-data.json', 'facts.json'])
  add('.codex-paper/paper-identity.json', ['paper.pdf'])
  add('.codex-paper/validation-report.json', files.filter((item) => item.path !== '.codex-paper/validation-report.json').map((item) => item.path))
  return edges
}

export function buildArtifactGraph(files, draft) {
  const filesByPath = new Map(files.map((item) => [item.path, item]))
  const sourceFile = filesByPath.get('paper.pdf')
  if (!sourceFile || sourceFile.sha256 !== draft.source.sha256) {
    const error = new Error('Artifact graph source input does not match paper.pdf.')
    error.code = 'PROVENANCE_GRAPH_INVALID'
    error.statusCode = 422
    throw error
  }
  const nodes = files.map((item) => ({ id: `file:${item.path}`, kind: 'file', path: item.path, sha256: item.sha256 }))
  nodes.push({ id: 'input:source', kind: 'input', sha256: draft.source.sha256 })
  nodes.push({ id: 'input:runtime-policy', kind: 'input', sha256: draft.runtime.policySha256 })
  const edgeKeys = new Set()
  const edges = []
  const add = (from, to) => {
    const key = `${from}\0${to}`
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ from, to }) }
  }
  add('input:source', 'file:paper.pdf')
  add('input:runtime-policy', 'file:paper-data.json')
  for (const edge of graphDefaults(files)) add(`file:${edge.from}`, `file:${edge.to}`)
  const latestEvents = new Map()
  for (const event of draft.authoringEvents.filter((item) => item.state === 'completed')) {
    latestEvents.set(event.path, event)
  }
  for (const event of latestEvents.values()) {
    if (!filesByPath.has(event.path)
      || event.dependencies.some((dependency) => !filesByPath.has(dependency.path))) {
      const error = new Error('Artifact dependency graph references a missing node.')
      error.code = 'PROVENANCE_GRAPH_INVALID'
      error.statusCode = 422
      throw error
    }
    const stale = []
    const actualOutput = filesByPath.get(event.path).sha256
    if (actualOutput !== event.afterSha256) {
      stale.push({
        path: event.path,
        dependency: null,
        expectedSha256: event.afterSha256,
        actualSha256: actualOutput,
      })
    }
    for (const dependency of event.dependencies) {
      const actualSha256 = filesByPath.get(dependency.path).sha256
      if (actualSha256 !== dependency.sha256) {
        stale.push({
          path: event.path,
          dependency: dependency.path,
          expectedSha256: dependency.sha256,
          actualSha256,
        })
      }
    }
    if (stale.length > 0) {
      const error = new Error(`Artifact dependency graph is stale for ${event.path}; regenerate the downstream artifact after finalizing its dependencies.`)
      error.code = 'PROVENANCE_DEPENDENCY_STALE'
      error.statusCode = 409
      error.details = stale
      throw error
    }
    for (const dependency of event.dependencies) add(`file:${dependency.path}`, `file:${event.path}`)
  }
  const nodeIds = new Set(nodes.map((item) => item.id))
  if (edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) {
    const error = new Error('Artifact dependency graph references a missing node.')
    error.code = 'PROVENANCE_GRAPH_INVALID'
    error.statusCode = 422
    throw error
  }
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to)
    indegree.set(edge.to, indegree.get(edge.to) + 1)
  }
  const queue = [...nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0)].sort()
  let visited = 0
  while (queue.length) {
    const id = queue.shift()
    visited += 1
    for (const target of outgoing.get(id).sort()) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
    queue.sort()
  }
  if (visited !== nodes.length) {
    const error = new Error('Artifact dependency graph contains a cycle.')
    error.code = 'PROVENANCE_GRAPH_INVALID'
    error.statusCode = 422
    throw error
  }
  return {
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
  }
}

export function verifyReadmeProjection(packageDir, manifestId) {
  let content
  try {
    content = readFileNoFollowBounded(path.join(packageDir, 'README.md'), 16 * 1024 * 1024).toString('utf8')
  } catch (cause) {
    const error = new Error('README provenance projection is missing or unreadable.')
    error.code = 'PROVENANCE_PROJECTION_INVALID'
    error.statusCode = cause?.statusCode || (cause?.code === 'ENOENT' ? 409 : 422)
    throw error
  }
  const matches = [...content.matchAll(/<!-- codex-paper-provenance:start -->[\s\S]*?<!-- codex-paper-provenance:end -->/g)]
  if (matches.length !== 1 || !matches[0][0].includes(manifestId) || !matches[0][0].includes(MANIFEST_VERSION)) {
    const error = new Error('README provenance projection is missing or does not match the workspace manifest identity.')
    error.code = 'PROVENANCE_PROJECTION_INVALID'
    error.statusCode = 409
    throw error
  }
  let meta
  try {
    meta = readJsonNoFollow(path.join(packageDir, 'meta.json'))
  } catch (cause) {
    const error = new Error('meta.json provenance projection is missing or unreadable.')
    error.code = 'PROVENANCE_PROJECTION_INVALID'
    error.statusCode = cause?.statusCode || (cause?.code === 'ENOENT' ? 409 : 422)
    throw error
  }
  if (meta?.generationManifest?.schemaVersion !== MANIFEST_VERSION || meta.generationManifest.manifestId !== manifestId) {
    const error = new Error('meta.json provenance projection does not match the workspace manifest identity.')
    error.code = 'PROVENANCE_PROJECTION_INVALID'
    error.statusCode = 409
    throw error
  }
}

export function reportIntrinsicHash(report) {
  const { reportHash, ...intrinsic } = report
  return sha256(stableJson(intrinsic))
}

export function collectExecutionReports(packageDir, expected) {
  const root = path.join(packageDir, '.codex-paper/execution-reports')
  if (!fs.existsSync(root)) return []
  const rootStats = fs.lstatSync(root)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    const error = new Error('Execution report directory is unsafe.')
    error.code = 'PROVENANCE_EXECUTION_INVALID'
    error.statusCode = 403
    throw error
  }
  const reports = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      const error = new Error('Execution report directory contains an unresolved or unsafe entry.')
      error.code = 'PROVENANCE_EXECUTION_INVALID'
      error.statusCode = 409
      throw error
    }
    const relativePath = `.codex-paper/execution-reports/${entry.name}`
    const bytes = readFileNoFollowBounded(path.join(root, entry.name), 8 * 1024 * 1024)
    let report
    try {
      report = JSON.parse(bytes)
    } catch {
      const error = new Error('Execution report is invalid JSON.')
      error.code = 'PROVENANCE_EXECUTION_INVALID'
      error.statusCode = 422
      throw error
    }
    if (report?.executionReportVersion !== '2.0.0'
      || report?.generationBinding?.phase !== 'preseal'
      || report.generationBinding.manifestId !== expected.manifestId
      || report?.generationBinding?.generationId !== expected.generationId
      || !validBoundedText(report?.executionId, 128)
      || !['pass', 'fail'].includes(report?.outcome)
      || !validBoundedText(report?.policyVersion, 80)
      || !HASH_PATTERN.test(String(report?.reportHash?.value || ''))
      || report.reportHash.value !== reportIntrinsicHash(report)) {
      const error = new Error('Execution report does not bind the workspace generation provenance.')
      error.code = 'PROVENANCE_EXECUTION_INVALID'
      error.statusCode = 422
      throw error
    }
    reports.push({
      path: relativePath,
      fileSha256: sha256(bytes),
      reportHash: report.reportHash.value,
      executionId: report.executionId,
      outcome: report.outcome,
      policyVersion: report.policyVersion,
      imageId: report.backend?.imageId || null,
    })
  }
  return reports
}

export function manifestDiagnostics(draft) {
  const diagnostics = [...draft.software.diagnostics]
  if (draft.source.queryPresent || draft.source.credentialsPresent) {
    diagnostics.push({
      code: 'SOURCE_LOCATOR_REDACTED',
      message: 'Source locator credentials, query values, or fragment were excluded from provenance.',
    })
  }
  if (draft.authoringEvents.some((event) => event.state !== 'pending' && event.actor === 'unknown')) {
    diagnostics.push({
      code: 'AUTHORING_ACTOR_UNDECLARED',
      message: 'One or more authoring events use the declared unknown actor.',
    })
  }
  const adoptedIndexes = new Set()
  // Manifest 2.0 and the draft key allowlist are frozen, so explicit adoption
  // is encoded as an adjacent recovered aborted/completed pair instead of a
  // new event flag. Keep this conservative inference until a versioned schema
  // can add a first-class resolution field.
  for (let index = 1; index < draft.authoringEvents.length; index += 1) {
    const previous = draft.authoringEvents[index - 1]
    const current = draft.authoringEvents[index]
    if (previous.recovered === true && previous.state === 'aborted'
      && current.recovered === true && current.state === 'completed'
      && current.actor === 'unknown' && current.path === previous.path
      && current.beforeSha256 === previous.beforeSha256
      && current.completedAt === previous.completedAt) {
      adoptedIndexes.add(index - 1)
      adoptedIndexes.add(index)
    }
  }
  if (adoptedIndexes.size > 0) {
    diagnostics.push({
      code: 'AUTHORING_EVENT_ADOPTED',
      message: 'One or more out-of-band artifact states were explicitly adopted with an unknown actor.',
    })
  }
  if (draft.authoringEvents.some((event, index) => event.recovered === true && !adoptedIndexes.has(index))) {
    diagnostics.push({
      code: 'AUTHORING_EVENT_RECONCILED',
      message: 'One or more interrupted authoring events were automatically reconciled to their recorded before or after hash.',
    })
  }
  return [...new Map(diagnostics.map((item) => [item.code, item])).values()]
    .sort((left, right) => left.code.localeCompare(right.code))
}
