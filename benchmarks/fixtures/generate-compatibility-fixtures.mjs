#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildGenerationManifest,
  stableJson,
} from '../../plugins/codex-paper/src/shared/generation-manifest.mjs'
import {
  applyReadmeProjection,
  buildProvenanceDraft,
  runtimeGenerationContract,
  sha256,
} from '../../plugins/codex-paper/src/shared/generation-provenance.mjs'
import {
  buildPaperIdentity,
  canonicalStringify,
  validatePaperIdentity,
} from '../../plugins/codex-paper/skills/study/scripts/paper-identity.js'
import { createValidationReport } from '../../plugins/codex-paper/skills/study/scripts/validation-report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT = path.join(HERE, 'pdf', 'compatibility')
const GENERATED_AT = '2026-07-30T00:00:00.000Z'
const SOURCE_BYTES = Buffer.from('%PDF-1.4\n% Codex Paper original synthetic compatibility fixture\n%%EOF\n')
const SOURCE_SHA = sha256(SOURCE_BYTES)
const LICENSE = {
  id: 'codex-paper-compatibility-source',
  kind: 'pdf',
  origin: 'original-synthetic',
  copyright: 'Copyright (c) 2026 Codex Paper contributors',
  spdx: 'MIT',
  license: 'MIT License',
  redistributable: true,
  sha256: SOURCE_SHA,
  generator: 'node benchmarks/fixtures/generate-compatibility-fixtures.mjs --write',
}

function writeFile(root, relativePath, value, mode = 0o600) {
  const target = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, value, { mode })
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeSource(root) {
  writeFile(root, 'paper.pdf', SOURCE_BYTES)
  writeJson(root, 'paper.pdf.manifest.json', LICENSE)
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function treeInventory(root, exclude = new Set()) {
  const files = []
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = relative ? `${relative}/${entry.name}` : entry.name
      if (exclude.has(item)) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target, item)
      else if (entry.isFile()) files.push({ path: item, sha256: hashFile(target), bytes: fs.statSync(target).size })
      else throw new Error(`Unsupported fixture entry: ${item}`)
    }
  }
  walk(root)
  return files.sort((left, right) => left.path < right.path ? -1 : (left.path > right.path ? 1 : 0))
}

function flatFixture(root, id, packageVersion) {
  const packageDir = path.join(root, id, 'package')
  fs.mkdirSync(packageDir, { recursive: true })
  writeSource(packageDir)
  writeJson(packageDir, 'meta.json', {
    slug: id,
    title: `Synthetic ${id}`,
    ...(packageVersion ? { packageVersion } : {}),
  })
  writeJson(packageDir, 'paper-data.json', { paperSlug: id, title: `Synthetic ${id}`, abstract: 'Synthetic compatibility fixture.' })
  writeJson(packageDir, 'facts.json', packageVersion === '2.1.0'
    ? { schemaVersion: '2.1.0', coreClaims: [], resultClaims: [], keyResults: [], limitations: [] }
    : { coreClaims: [], keyResults: [], limitations: [] })
  writeJson(packageDir, 'analysis.json', {})
  if (packageVersion) {
    writeJson(packageDir, 'evidence-ledger.json', { schemaVersion: '2.0.0', paperSlug: id, evidence: [], sections: [] })
    writeJson(packageDir, 'reasoning-analysis.json', {
      schemaVersion: '2.0.0',
      analysisVersion: '2.0.0',
      paperSlug: id,
      status: 'draft',
      contextMode: 'paper-only',
      paperProfile: 'other',
      centralClaims: [],
      mechanismMap: [],
      keyResults: [],
      assumptions: [],
      limitations: [],
      uncertaintyZones: [],
      alternativeExplanations: [],
      externalEvidenceRefs: [],
      followUpIdeas: [],
    })
  }
}

function runtime() {
  return {
    schemaVersion: '1.0.0',
    policyVersion: 'synthetic-runtime-1.0.0',
    policySha256: '1'.repeat(64),
    contentStatus: 'conformant',
    contentChecks: { node: true, python: true, pyMuPDF: true, parserPolicy: true },
    host: {
      os: 'synthetic',
      arch: 'synthetic',
      release: 'synthetic',
      node: '22.23.1',
      python: { version: '3.11.15', implementation: 'CPython', pyMuPDF: '1.28.0' },
    },
    tooling: { npm: '10.9.8' },
    parserPolicy: { version: 'synthetic-parser-1.0.0', sha256: '2'.repeat(64) },
    sandbox: {
      node: '20.20.2',
      python: '3.11.15',
      nodeBaseImage: `node@sha256:${'3'.repeat(64)}`,
      pythonBaseImage: `python@sha256:${'4'.repeat(64)}`,
      scope: 'sandbox-only',
    },
    contentAffecting: ['node', 'python', 'pymupdf', 'parser-policy'],
    toolingOnly: ['npm'],
  }
}

function contentContract(version) {
  const files = [{ path: 'synthetic-contract.txt', sha256: '5'.repeat(64) }]
  return {
    version,
    sha256: sha256(canonicalStringify({ version, files })),
    files,
  }
}

function identityV1(slug) {
  const inputs = {
    sourceSha256: SOURCE_SHA,
    identityPolicyVersion: '1.0.0',
    generationContractVersion: '1.0.0',
    packageVersion: '2.1.0',
    pluginBaseVersion: '2.0.0',
    evidenceSchemaVersion: '2.0.0',
    factsSchemaVersion: '2.1.0',
    reasoningSchemaVersion: '2.0.0',
    workflow: 'study',
    language: 'en',
    contextMode: 'paper-only',
    requestedPaperProfile: 'other',
    parser: { backend: 'synthetic', backendVersion: '1.0.0', contractVersion: '2.0.0' },
    externalSourceLocator: null,
    contentContract: contentContract('1.0.0'),
  }
  const fingerprint = sha256(canonicalStringify(inputs))
  const identity = {
    schemaVersion: '1.0.0',
    slug,
    paperId: `source:sha256:${SOURCE_SHA}`,
    sourceRevisionId: `sha256:${SOURCE_SHA}`,
    generationId: `gen:sha256:${fingerprint}`,
    source: { sha256: SOURCE_SHA },
    canonical: { resolution: 'source_fallback', primary: null, aliases: [], candidates: [], diagnostics: [] },
    generation: { fingerprint: { algorithm: 'sha256', value: fingerprint }, inputs },
    provenance: { createdAt: GENERATED_AT, pluginBuildVersion: '2.0.0+codex.synthetic', platform: 'synthetic' },
  }
  if (!validatePaperIdentity(identity).valid) throw new Error('Synthetic Identity 1.0 fixture is invalid.')
  return identity
}

function identityV2(slug) {
  return buildPaperIdentity({
    slug,
    sourceSha256: SOURCE_SHA,
    pages: [],
    workflow: 'study',
    language: 'en',
    contextMode: 'paper-only',
    requestedPaperProfile: 'other',
    parserBackend: 'synthetic',
    parserBackendVersion: '1.0.0',
    runtimeContract: runtimeGenerationContract(runtime()),
    authoringProvider: 'openai',
    authoringModel: 'synthetic-model',
    contentContract: contentContract('2.0.0'),
    pluginBuildVersion: '2.0.0+codex.synthetic',
    platform: 'synthetic',
    createdAt: GENERATED_AT,
  })
}

function software(identity) {
  return {
    repository: { commit: null, status: 'unavailable', treeState: 'unavailable' },
    plugin: { baseVersion: '2.0.0', buildVersion: '2.0.0+codex.synthetic' },
    skill: { name: 'paper-study', sha256: '6'.repeat(64) },
    codex: {
      product: 'codex',
      cliVersion: null,
      status: 'unavailable',
      authoringEngine: identity.generation.inputs.authoringEngine,
    },
    schemas: [{ name: 'synthetic', version: '1.0.0', path: 'synthetic.schema.json', sha256: '7'.repeat(64) }],
    validator: { name: 'codex-paper-validation', version: '1.0.0', sha256: '8'.repeat(64) },
    diagnostics: [
      { code: 'CODEX_VERSION_UNAVAILABLE', message: 'Codex CLI version was not observable.' },
      { code: 'REPOSITORY_COMMIT_UNAVAILABLE', message: 'Repository commit was not observable for the exact codex-paper repository root.' },
    ],
  }
}

function packageCore(packageDir, slug, identity, manifestId, schemaVersion) {
  writeSource(packageDir)
  writeJson(packageDir, 'paper-data.json', { paperSlug: slug, title: `Synthetic ${slug}` })
  writeJson(packageDir, 'evidence-ledger.json', { schemaVersion: '2.0.0', paperSlug: slug, evidence: [], sections: [] })
  writeJson(packageDir, 'facts.json', { schemaVersion: '2.1.0', coreClaims: [], resultClaims: [], keyResults: [], limitations: [] })
  writeJson(packageDir, 'analysis.json', {})
  writeJson(packageDir, 'reasoning-analysis.json', {
    schemaVersion: '2.0.0',
    analysisVersion: '2.0.0',
    paperSlug: slug,
    status: 'complete',
    contextMode: 'paper-only',
    paperProfile: 'other',
    centralClaims: [],
    mechanismMap: [],
    keyResults: [],
    assumptions: [],
    limitations: [],
    uncertaintyZones: [],
    alternativeExplanations: [],
    externalEvidenceRefs: [],
    followUpIdeas: [],
  })
  writeJson(packageDir, 'meta.json', {
    slug,
    title: `Synthetic ${slug}`,
    packageVersion: '2.1.0',
    generationManifest: { schemaVersion, manifestId },
  })
  writeJson(packageDir, '.codex-paper/paper-identity.json', identity)
  writeFile(packageDir, 'README.md', applyReadmeProjection('# Synthetic compatibility package\n', manifestId))
}

function managedV1(root) {
  const id = 'managed-manifest-1-identity-1'
  const identity = identityV1(id)
  const paperKey = `p-${'a'.repeat(64)}`
  const recordDir = path.join(root, id, 'record')
  const relativePackage = `sources/${identity.sourceRevisionId.replace(':', '-')}/generations/${identity.generationId.replaceAll(':', '-')}/package`
  const packageDir = path.join(recordDir, ...relativePackage.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  const report = createValidationReport({ phase: 'complete', generatedAt: GENERATED_AT })
  const validationHash = report.reportHash.value
  const manifestId = `gm-sha256-${sha256(stableJson({
    paperKey,
    generationId: identity.generationId,
    validationReportHash: validationHash,
  }))}`
  packageCore(packageDir, id, identity, manifestId, '1.0.0')
  writeJson(packageDir, '.codex-paper/validation-report.json', report)
  const files = treeInventory(packageDir)
  const intrinsic = {
    schemaVersion: '1.0.0',
    manifestId,
    transactionState: 'sealed',
    transactionId: `pub-${'b'.repeat(32)}`,
    paperKey,
    paperId: identity.paperId,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    sourceSha256: SOURCE_SHA,
    generationFingerprint: identity.generation.fingerprint.value,
    validation: { schemaVersion: '1.0.0', status: 'pass', reportHash: validationHash },
    sealedAt: GENERATED_AT,
    files,
  }
  const manifest = { ...intrinsic, manifestHash: sha256(stableJson(intrinsic)) }
  writeJson(packageDir, '.codex-paper/generation-manifest.json', manifest)
  const manifestFileSha256 = hashFile(path.join(packageDir, '.codex-paper/generation-manifest.json'))
  writeManagedRecords(recordDir, id, paperKey, identity, relativePackage, manifest, manifestFileSha256, validationHash)
}

function managedV2(root) {
  const id = 'managed-manifest-2-identity-2'
  const identity = identityV2(id)
  const paperKey = `p-${'c'.repeat(64)}`
  const recordDir = path.join(root, id, 'record')
  const relativePackage = `sources/${identity.sourceRevisionId.replace(':', '-')}/generations/${identity.generationId.replaceAll(':', '-')}/package`
  const packageDir = path.join(recordDir, ...relativePackage.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  const workspaceId = `ws-${'d'.repeat(12)}-${'e'.repeat(12)}-${'f'.repeat(32)}`
  const draft = buildProvenanceDraft({
    workspaceId,
    paperKey,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    identity,
    runtime: runtime(),
    software: software(identity),
    source: {
      kind: 'local_file',
      requestedUrl: null,
      resolvedUrl: null,
      filename: 'paper.pdf',
      bytes: SOURCE_BYTES.length,
      acquiredAt: GENERATED_AT,
    },
    now: GENERATED_AT,
  })
  packageCore(packageDir, id, identity, draft.manifestId, '2.0.0')
  const report = createValidationReport({ phase: 'complete', generatedAt: GENERATED_AT })
  writeJson(packageDir, '.codex-paper/validation-report.json', report)
  const manifest = buildGenerationManifest({
    packageDir,
    transactionId: `pub-${'1'.repeat(32)}`,
    paperKey,
    identity,
    validationReport: report,
    provenanceDraft: draft,
    sealedAt: GENERATED_AT,
  })
  writeJson(packageDir, '.codex-paper/generation-manifest.json', manifest)
  const manifestFileSha256 = hashFile(path.join(packageDir, '.codex-paper/generation-manifest.json'))
  writeManagedRecords(recordDir, id, paperKey, identity, relativePackage, manifest, manifestFileSha256, report.reportHash.value)
}

function writeManagedRecords(recordDir, slug, paperKey, identity, relativePackage, manifest, manifestFileSha256, validationReportHash) {
  writeJson(recordDir, 'paper.json', {
    schemaVersion: '1.0.0',
    paperKey,
    primaryPaperId: identity.paperId,
    paperIdAliases: [identity.paperId],
    routeAliases: [slug],
    createdAt: GENERATED_AT,
    reconciliations: [],
  })
  writeJson(recordDir, 'current.json', {
    schemaVersion: '1.0.0',
    paperKey,
    paperId: identity.paperId,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    packageRelativePath: relativePackage,
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    manifestFileSha256,
    validationReportHash,
    publishedAt: GENERATED_AT,
  })
  writeJson(recordDir, 'overlay/state.json', { schemaVersion: '1.0.0', tags: ['synthetic'], progress: {}, annotations: [] })
}

function build(root) {
  fs.mkdirSync(root, { recursive: true })
  flatFixture(root, 'legacy-v1-flat', null)
  flatFixture(root, 'package-2.0-flat', '2.0.0')
  flatFixture(root, 'package-2.1-flat', '2.1.0')
  managedV1(root)
  managedV2(root)
  const fixtures = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const files = treeInventory(path.join(root, entry.name))
      return {
        id: entry.name,
        origin: 'original-synthetic',
        spdx: 'MIT',
        license: 'MIT License',
        redistributable: true,
        files,
        snapshotSha256: sha256(stableJson(files)),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  writeJson(root, 'manifest.json', {
    schemaVersion: '1.0.0',
    generatedAt: GENERATED_AT,
    generator: 'node benchmarks/fixtures/generate-compatibility-fixtures.mjs --write',
    fixtures,
  })
}

function compare(left, right) {
  const leftFiles = treeInventory(left)
  const rightFiles = treeInventory(right)
  if (stableJson(leftFiles) !== stableJson(rightFiles)) throw new Error('Compatibility fixture files differ from deterministic generation.')
  for (const item of leftFiles) {
    const leftBytes = fs.readFileSync(path.join(left, ...item.path.split('/')))
    const rightBytes = fs.readFileSync(path.join(right, ...item.path.split('/')))
    if (!leftBytes.equals(rightBytes)) throw new Error(`Compatibility fixture differs: ${item.path}`)
  }
}

const command = process.argv[2]
if (command === '--write') {
  fs.rmSync(OUTPUT, { recursive: true, force: true })
  build(OUTPUT)
  process.stdout.write(`${OUTPUT}\n`)
} else if (command === '--check') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-compatibility-fixtures-'))
  try {
    build(temporary)
    compare(OUTPUT, temporary)
    process.stdout.write('Compatibility fixtures are deterministic.\n')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
} else {
  process.stderr.write('Usage: node benchmarks/fixtures/generate-compatibility-fixtures.mjs <--write|--check>\n')
  process.exit(2)
}
