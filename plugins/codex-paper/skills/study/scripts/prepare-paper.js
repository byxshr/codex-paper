import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildAnalysisFromArtifacts, validateAnalysisWithFacts } from './build-analysis.js';
import { buildEvidenceLedger } from './build-evidence-ledger.js';
import { buildFactsFromLedger, validateFactsEvidenceRefs } from './extract-facts.js';
import {
  IDENTITY_RELATIVE_PATH,
  PaperIdentityError,
  assertIdentityProjection,
  buildPaperIdentity,
  identityProjection,
  platformProvenance,
  readPaperIdentity,
  sha256File
} from './paper-identity.js';
import {
  buildPackageRelativePath,
  derivePaperKey,
  getLibraryLayout,
  listManagedRecords,
  readCurrentRecord,
  reconcilePaperRecord,
  requireSafeDirectory,
  sourceDirectoryName,
  generationDirectoryName,
  validatePaperRecord
} from '../../../src/shared/paper-library.mjs';
import {
  createGenerationWorkspace,
  isActiveGenerationWorkspace,
  listGenerationWorkspaces,
  resolveGenerationWorkspace
} from '../../../src/shared/generation-workspace.mjs';
import {
  assertContentRuntime,
  collectSoftwareProvenance,
  collectRuntimeAttestation,
  deriveManifestId,
  runtimeGenerationContract,
  writeAuthoringWithProvenance
} from '../../../src/shared/generation-provenance.mjs';
import {
  MAX_LOCK_TIMEOUT_MS,
  readFileNoFollowBounded,
  storageCliExitCode
} from '../../../src/shared/storage-transaction.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { stagePdfInput } = require('./download-pdf.cjs');
const PACKAGE_VERSION = '2.1.0';
const PLUGIN_BASE_VERSION = '2.0.0';
const EVIDENCE_SCHEMA_VERSION = '2.0.0';
const REASONING_SCHEMA_VERSION = '2.0.0';
const CONTEXT_MODES = new Set(['paper-only', 'canonical', 'literature']);
const PAPER_PROFILES = new Set(['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other']);
const WORKFLOWS = new Set(['study', 'summary']);
const LANGUAGES = new Set(['zh', 'en']);
const PREPARED_FILES = ['paper.pdf', 'paper-data.json', 'evidence-ledger.json', 'facts.json', 'analysis.json', 'meta.json'];
const FACTS_SCHEMA_PATH = path.resolve(__dirname, '../schemas/facts-2.1.schema.json');
const EVIDENCE_SCHEMA_PATH = path.resolve(__dirname, '../schemas/evidence-ledger.schema.json');
const EXTERNAL_EVIDENCE_SCHEMA_PATH = path.resolve(__dirname, '../schemas/external-evidence.schema.json');
const schemaCompiler = new Ajv2020({ allErrors: true, strict: true });
const validateFactsSchema = schemaCompiler.compile(JSON.parse(fs.readFileSync(FACTS_SCHEMA_PATH, 'utf8')));
const validateEvidenceSchema = schemaCompiler.compile(JSON.parse(fs.readFileSync(EVIDENCE_SCHEMA_PATH, 'utf8')));
const validateExternalEvidenceSchema = schemaCompiler.compile(JSON.parse(fs.readFileSync(EXTERNAL_EVIDENCE_SCHEMA_PATH, 'utf8')));

export function slugify(value) {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.length <= 160 ? normalized : normalized.slice(0, 160).replace(/-+$/g, '');
}

function parsePrepareArgs(argv) {
  const args = {
    input: null,
    contextMode: 'paper-only',
    profile: 'auto',
    workflow: 'study',
    language: 'en',
    resume: false,
    newRevision: false,
    replace: false,
    reconcileIdentity: null,
    resumeWorkspace: null,
    authoringProvider: 'unavailable',
    authoringModel: 'unavailable',
    lockTimeoutMs: 10_000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--context') {
      args.contextMode = argv[index + 1];
      index += 1;
    } else if (arg === '--profile') {
      args.profile = argv[index + 1];
      index += 1;
    } else if (arg === '--workflow') {
      args.workflow = argv[index + 1];
      index += 1;
    } else if (arg === '--language') {
      args.language = argv[index + 1];
      index += 1;
    } else if (arg === '--resume') {
      args.resume = true;
    } else if (arg === '--new-revision') {
      args.newRevision = true;
    } else if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--reconcile-identity') {
      args.reconcileIdentity = argv[index + 1];
      index += 1;
    } else if (arg === '--resume-workspace') {
      args.resumeWorkspace = argv[index + 1];
      index += 1;
    } else if (arg === '--authoring-provider') {
      args.authoringProvider = argv[index + 1];
      index += 1;
    } else if (arg === '--authoring-model') {
      args.authoringModel = argv[index + 1];
      index += 1;
    } else if (arg === '--lock-timeout-ms') {
      args.lockTimeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new PaperIdentityError('ARGUMENT_INVALID', `Unknown option: ${arg}`);
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new PaperIdentityError('ARGUMENT_INVALID', `Unexpected argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'Paper input is required.');
  }

  if (!CONTEXT_MODES.has(args.contextMode)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', '--context must be paper-only, canonical, or literature.');
  }

  if (!PAPER_PROFILES.has(args.profile)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', '--profile is not recognized.');
  }

  if (!WORKFLOWS.has(args.workflow)) throw new PaperIdentityError('ARGUMENT_INVALID', '--workflow must be study or summary.');
  if (!LANGUAGES.has(args.language)) throw new PaperIdentityError('ARGUMENT_INVALID', '--language must be zh or en.');
  if (args.replace) throw new PaperIdentityError('ARGUMENT_INVALID', '--replace is not supported before P0-C2; no existing generation will be overwritten.');
  if (args.resume && args.newRevision) throw new PaperIdentityError('ARGUMENT_INVALID', '--resume and --new-revision are mutually exclusive.');
  if (args.resumeWorkspace && (args.resume || args.newRevision || args.replace)) throw new PaperIdentityError('ARGUMENT_INVALID', '--resume-workspace cannot be combined with --resume, --new-revision, or --replace.');
  if (!Number.isInteger(args.lockTimeoutMs) || args.lockTimeoutMs < 0 || args.lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) throw new PaperIdentityError('ARGUMENT_INVALID', `--lock-timeout-ms must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}.`);
  if (args.reconcileIdentity !== null && !args.reconcileIdentity) throw new PaperIdentityError('ARGUMENT_INVALID', '--reconcile-identity requires an existing route alias.');
  if (!args.authoringProvider || args.authoringProvider.length > 80) throw new PaperIdentityError('ARGUMENT_INVALID', '--authoring-provider requires a bounded value.');
  if (!args.authoringModel || args.authoringModel.length > 160) throw new PaperIdentityError('ARGUMENT_INVALID', '--authoring-model requires a bounded value.');

  return args;
}

async function resolveInput(input) {
  const staged = await stagePdfInput(input);
  return {
    inputPath: staged.path,
    sourceUrl: staged.sourceUrl || null,
    requestedUrl: /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : null,
    sourceKind: staged.sourceUrl ? 'remote_https' : 'local_file',
    sourceFilename: staged.sourceFilename,
    sourceBytes: staged.bytes,
    acquiredAt: staged.acquiredAt,
    inputWarnings: staged.warnings || [],
    cleanup: staged.cleanup
  };
}

function readIndexPreserveShape(indexPath) {
  let stats;
  try {
    stats = fs.lstatSync(indexPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { raw: [], papers: [], isArray: true };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new PaperIdentityError('INDEX_PATH_UNSAFE', 'Library index path is unsafe.');
  const descriptor = fs.openSync(indexPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
  if (Array.isArray(raw)) {
    return {
      raw,
      papers: raw,
      isArray: true
    };
  }

  return {
    raw,
    papers: Array.isArray(raw.papers) ? raw.papers : [],
    isArray: false
  };
}

function buildExternalEvidenceManifest({ paperSlug, contextMode, sourceUrl }) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    paperSlug,
    contextMode,
    generatedAt: new Date().toISOString(),
    policy: {
      paperOnlyDefault: contextMode === 'paper-only',
      storedSeparatelyFromEvidenceLedger: true,
      note: contextMode === 'paper-only'
        ? 'No external evidence was collected in paper-only mode.'
        : 'External evidence must be added explicitly by Codex and must never be copied into evidence-ledger.json.'
    },
    sources: sourceUrl ? [{
      id: 'source-input',
      kind: 'user_provided_pdf_url',
      title: 'Original user-provided paper URL',
      url: sourceUrl,
      accessedAt: new Date().toISOString()
    }] : [],
    evidence: []
  };
}

function readJsonFile(filePath, code = 'IDENTITY_STATE_INCOMPLETE') {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('not a regular file');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new PaperIdentityError(code, 'Existing paper generation is incomplete or invalid.');
  }
}

function scanIdentityRegistry(libraryRoot) {
  const records = [];
  for (const managed of listManagedRecords({ libraryRoot })) {
    const sourcesRoot = path.join(managed.recordDir, 'sources');
    if (!fs.existsSync(sourcesRoot)) continue;
    requireSafeDirectory(sourcesRoot, managed.recordDir);
    for (const sourceEntry of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
      if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Paper source registry contains an unsafe entry.');
      const generationsRoot = path.join(sourcesRoot, sourceEntry.name, 'generations');
      requireSafeDirectory(generationsRoot, managed.recordDir);
      for (const generationEntry of fs.readdirSync(generationsRoot, { withFileTypes: true })) {
        if (generationEntry.isSymbolicLink() || !generationEntry.isDirectory()) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Paper generation registry contains an unsafe entry.');
        const paperDir = path.join(generationsRoot, generationEntry.name, 'package');
        requireSafeDirectory(paperDir, managed.recordDir);
        const identityPath = path.join(paperDir, IDENTITY_RELATIVE_PATH);
        let identity;
        try { identity = readPaperIdentity(identityPath); } catch {
          throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Paper identity registry contains an invalid generation record.');
        }
        if (sourceEntry.name !== sourceDirectoryName(identity.sourceRevisionId)
          || generationEntry.name !== generationDirectoryName(identity.generationId)) {
          throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Generation path does not match its identity.');
        }
        records.push({ paperDir, identity, managed });
      }
    }
  }
  return records;
}

function validateReusableGeneration(record) {
  const { paperDir, identity } = record;
  for (const relativePath of PREPARED_FILES) {
    const filePath = path.join(paperDir, relativePath);
    let stats;
    try { stats = fs.lstatSync(filePath); } catch { throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing paper generation is incomplete.'); }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing paper generation is incomplete.');
  }
  let externalEvidence = null;
  if (identity.generation.inputs.contextMode !== 'paper-only') {
    externalEvidence = readJsonFile(path.join(paperDir, '.codex-paper/external-evidence.json'));
    if (!validateExternalEvidenceSchema(externalEvidence)) throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing external evidence is invalid.');
  }
  if (sha256File(path.join(paperDir, 'paper.pdf')) !== identity.source.sha256) {
    throw new PaperIdentityError('SOURCE_HASH_MISMATCH', 'Stored PDF does not match the paper identity.');
  }
  const meta = readJsonFile(path.join(paperDir, 'meta.json'));
  const paperData = readJsonFile(path.join(paperDir, 'paper-data.json'));
  const ledger = readJsonFile(path.join(paperDir, 'evidence-ledger.json'));
  const facts = readJsonFile(path.join(paperDir, 'facts.json'));
  const analysis = readJsonFile(path.join(paperDir, 'analysis.json'));
  assertIdentityProjection(meta, identity, 'meta.json');
  assertIdentityProjection(paperData, identity, 'paper-data.json');
  if (paperData.paperSlug !== identity.slug
    || ledger.paperSlug !== identity.slug
    || facts.paperSlug !== identity.slug
    || analysis.paperSlug !== identity.slug
    || ledger.document?.sha256 !== identity.source.sha256) {
    throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing prepared artifacts do not match the identity record.');
  }
  if (!validateEvidenceSchema(ledger) || !validateFactsSchema(facts)) {
    throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing prepared artifacts do not satisfy their schemas.');
  }
  const factsValidation = validateFactsEvidenceRefs(facts, ledger);
  const analysisValidation = validateAnalysisWithFacts(analysis, facts);
  if (!factsValidation.valid || !analysisValidation.valid) {
    throw new PaperIdentityError('IDENTITY_STATE_INCOMPLETE', 'Existing prepared artifacts contain invalid evidence references.');
  }
  return {
    paperData,
    ledger,
    facts,
    analysis,
    meta,
    externalEvidencePath: identity.generation.inputs.contextMode === 'paper-only' ? null : path.join(paperDir, '.codex-paper/external-evidence.json')
  };
}

function allocateRouteSlug(baseSlug, identity, managedRecords, indexState, legacyPapersRoot, workspaces) {
  const proposedPaperKey = derivePaperKey(identity.paperId);
  const used = new Set([
    ...managedRecords.flatMap(({ record }) => record.routeAliases),
    ...indexState.papers.map((entry) => entry?.slug).filter(Boolean),
    ...workspaces
      .filter((item) => isActiveGenerationWorkspace(item) && item.paperKey !== proposedPaperKey)
      .map((item) => item.routeSlug)
  ]);
  if (fs.existsSync(legacyPapersRoot)) {
    const stats = fs.lstatSync(legacyPapersRoot);
    if (stats.isSymbolicLink()) throw new PaperIdentityError('PAPER_PATH_UNSAFE', 'Legacy papers root is unsafe.');
    for (const entry of fs.readdirSync(legacyPapersRoot, { withFileTypes: true })) if (entry.isDirectory() || entry.isSymbolicLink()) used.add(entry.name);
  }
  if (!used.has(baseSlug)) return baseSlug;
  const sourceSuffix = identity.source.sha256.slice(0, 12);
  const candidate = `${baseSlug.slice(0, Math.max(1, 160 - sourceSuffix.length - 1)).replace(/-+$/g, '')}-${sourceSuffix}`;
  if (!used.has(candidate)) return candidate;
  const generationSuffix = identity.generation.fingerprint.value.slice(0, 12);
  const fallback = `${baseSlug.slice(0, Math.max(1, 160 - generationSuffix.length - 1)).replace(/-+$/g, '')}-${generationSuffix}`;
  if (!used.has(fallback)) return fallback;
  throw new PaperIdentityError('PAPER_ROUTE_CONFLICT', 'A unique route alias could not be allocated.');
}

function resolvePreparationAction(identity, baseSlug, indexState, options = {}) {
  const layout = getLibraryLayout(options.libraryRoot);
  const managedRecords = listManagedRecords({ libraryRoot: options.libraryRoot });
  const workspaces = listGenerationWorkspaces({ libraryRoot: options.libraryRoot });
  const registry = scanIdentityRegistry(options.libraryRoot);
  const generationMatches = registry.filter((item) => item.identity.generationId === identity.generationId);
  if (generationMatches.length > 1) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Multiple paper directories claim the same generation identity.');
  if (generationMatches.length === 1) {
    const match = generationMatches[0];
    if (match.identity.sourceRevisionId !== identity.sourceRevisionId) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Generation identity maps to conflicting source revisions.');
    if (!match.managed.record.paperIdAliases.includes(identity.paperId)) {
      if (!options.reconcileIdentity || !match.managed.record.routeAliases.includes(options.reconcileIdentity)) {
        throw new PaperIdentityError('PAPER_IDENTITY_RECONCILIATION_REQUIRED', 'The same generation resolved to another paper ID; explicit reconciliation is required.');
      }
      const record = reconcilePaperRecord(match.managed.record, identity.paperId, identity);
      return {
        action: 'workspace', identity, managed: { ...match.managed, record, reconciled: true },
        reconciliation: { existingPaperKey: record.paperKey, incomingPaperId: identity.paperId },
        packageRelativePath: buildPackageRelativePath(identity.sourceRevisionId, identity.generationId)
      };
    }
    if (options.newRevision) throw new PaperIdentityError('NEW_REVISION_REQUIRED', '--new-revision requires different source bytes.');
    const artifacts = validateReusableGeneration(match);
    return { action: 'reused', paperDir: match.paperDir, identity: match.identity, artifacts, managed: match.managed };
  }
  if (options.resume) throw new PaperIdentityError('RESUME_GENERATION_NOT_FOUND', '--resume requires an existing exact generation.');

  let managed = managedRecords.find(({ record }) => record.paperIdAliases.includes(identity.paperId)) || null;
  const sourceOwner = registry.find((item) => item.identity.sourceRevisionId === identity.sourceRevisionId) || null;
  if (!managed && sourceOwner) {
    if (!options.reconcileIdentity || !sourceOwner.managed.record.routeAliases.includes(options.reconcileIdentity)) {
      throw new PaperIdentityError('PAPER_IDENTITY_RECONCILIATION_REQUIRED', 'This source revision belongs to another paper ID; explicit reconciliation is required.');
    }
    const record = reconcilePaperRecord(sourceOwner.managed.record, identity.paperId, identity);
    managed = { ...sourceOwner.managed, record, reconciled: true };
  }
  if (options.newRevision) {
    if (!managed) throw new PaperIdentityError('NEW_REVISION_PAPER_NOT_FOUND', '--new-revision requires an existing paper identity.');
    const current = readCurrentRecord(managed.recordDir, managed.record);
    if (current.sourceRevisionId === identity.sourceRevisionId) throw new PaperIdentityError('NEW_REVISION_REQUIRED', '--new-revision requires different source bytes.');
  }

  if (!managed) {
    const routeSlug = allocateRouteSlug(baseSlug, identity, managedRecords, indexState, layout.legacyPapersRoot, workspaces);
    const paperKey = derivePaperKey(identity.paperId);
    if (managedRecords.some(({ record }) => record.paperKey === paperKey)) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Paper storage key collision.');
    managed = {
      recordDir: path.join(layout.recordsRoot, paperKey),
      record: {
        schemaVersion: '1.0.0',
        paperKey,
        primaryPaperId: identity.paperId,
        paperIdAliases: [identity.paperId],
        routeAliases: [routeSlug],
        createdAt: new Date().toISOString(),
        reconciliations: []
      },
      isNew: true
    };
  }

  const packageRelativePath = buildPackageRelativePath(identity.sourceRevisionId, identity.generationId);
  const paperDir = path.join(managed.recordDir, ...packageRelativePath.split('/'));
  if (fs.existsSync(paperDir)) throw new PaperIdentityError('IDENTITY_REGISTRY_CONFLICT', 'Generation destination already exists without a valid identity record.');
  return { action: 'workspace', paperDir, identity, managed, packageRelativePath, reconciliation: managed.reconciled ? { existingPaperKey: managed.record.paperKey, incomingPaperId: identity.paperId } : null };
}

function resolveMigrationPreparation(identity, routeSlug, paperRecord = null) {
  if (typeof routeSlug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(routeSlug)) {
    throw new PaperIdentityError('MIGRATION_TARGET_INVALID', 'Migration requires an exact safe route alias.');
  }
  let record = paperRecord;
  let reconciliation = null;
  if (record) {
    record = validatePaperRecord(record, record.paperKey);
    if (!record.routeAliases.includes(routeSlug)) {
      throw new PaperIdentityError('MIGRATION_TARGET_INVALID', 'Migration route is not owned by the selected paper record.');
    }
    if (!record.paperIdAliases.includes(identity.paperId)) {
      const previous = record;
      record = reconcilePaperRecord(record, identity.paperId, identity);
      reconciliation = { existingPaperKey: previous.paperKey, incomingPaperId: identity.paperId };
    }
  } else {
    const paperKey = derivePaperKey(identity.paperId);
    record = {
      schemaVersion: '1.0.0',
      paperKey,
      primaryPaperId: identity.paperId,
      paperIdAliases: [identity.paperId],
      routeAliases: [routeSlug],
      createdAt: new Date().toISOString(),
      reconciliations: []
    };
  }
  return {
    action: 'workspace',
    identity,
    managed: { record, recordDir: null, isNew: !paperRecord },
    reconciliation,
    packageRelativePath: buildPackageRelativePath(identity.sourceRevisionId, identity.generationId)
  };
}

export async function preparePaper(userInput, options = {}) {
  if (!userInput) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'Paper input is required.');
  }

  const contextMode = options.contextMode || 'paper-only';
  const profile = options.profile || 'auto';
  const workflow = options.workflow || 'study';
  const language = options.language || 'en';
  const resume = options.resume === true;
  const newRevision = options.newRevision === true;
  const replace = options.replace === true;
  const reconcileIdentity = options.reconcileIdentity || null;
  const resumeWorkspace = options.resumeWorkspace || null;
  const authoringProvider = options.authoringProvider || 'unavailable';
  const authoringModel = options.authoringModel || 'unavailable';
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  if (!CONTEXT_MODES.has(contextMode)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'contextMode must be paper-only, canonical, or literature.');
  }
  if (!PAPER_PROFILES.has(profile)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'profile is not recognized.');
  }
  if (!WORKFLOWS.has(workflow)) throw new PaperIdentityError('ARGUMENT_INVALID', 'workflow must be study or summary.');
  if (!LANGUAGES.has(language)) throw new PaperIdentityError('ARGUMENT_INVALID', 'language must be zh or en.');
  if (replace) throw new PaperIdentityError('ARGUMENT_INVALID', '--replace is not supported before P0-C2b publication; no existing generation will be overwritten.');
  if (resume && newRevision) throw new PaperIdentityError('ARGUMENT_INVALID', '--resume and --new-revision are mutually exclusive.');
  if (resumeWorkspace && (resume || newRevision || replace)) throw new PaperIdentityError('ARGUMENT_INVALID', '--resume-workspace cannot be combined with --resume, --new-revision, or --replace.');
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) throw new PaperIdentityError('ARGUMENT_INVALID', `lockTimeoutMs must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}.`);
  if (!authoringProvider || authoringProvider.length > 80 || !authoringModel || authoringModel.length > 160) throw new PaperIdentityError('ARGUMENT_INVALID', 'authoring provider/model must be bounded non-empty values.');

  const libraryRoot = path.resolve(options.libraryRoot || process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'));
  const layout = getLibraryLayout(libraryRoot);
  fs.mkdirSync(libraryRoot, { recursive: true, mode: 0o700 });
  const indexState = readIndexPreserveShape(layout.indexPath);

  const runtimeAttestation = assertContentRuntime(options.runtimeAttestation || collectRuntimeAttestation(options.env || process.env));
  const resolvedInput = await resolveInput(userInput);
  const { inputPath, sourceUrl } = resolvedInput;
  try {
  const detailed = await parsePdfDetailed(inputPath);
  const parsed = detailed.publicData;
  parsed.warnings = Array.from(new Set([...(resolvedInput.inputWarnings || []), ...(parsed.warnings || [])]));
  const sourceFilename = resolvedInput.sourceFilename || path.basename(inputPath);
  const basePaperSlug = slugify(parsed.title || path.basename(inputPath, path.extname(inputPath)));
  if (!basePaperSlug) throw new PaperIdentityError('PAPER_SLUG_INVALID', 'Parsed title cannot produce a safe paper slug.');
  const today = new Date().toISOString().slice(0, 10);
  const sourceSha256 = sha256File(inputPath);
  const identity = buildPaperIdentity({
    slug: basePaperSlug,
    sourceSha256,
    sourceUrl: resolvedInput.sourceKind === 'remote_https' ? resolvedInput.requestedUrl : null,
    pages: detailed.pages,
    workflow,
    language,
    contextMode,
    requestedPaperProfile: profile,
    parserBackend: detailed.parserMetadata?.parser || 'unknown',
    parserBackendVersion: detailed.parserMetadata?.backendVersion || 'unknown',
    runtimeContract: runtimeGenerationContract(runtimeAttestation),
    authoringProvider,
    authoringModel,
    pluginBuildVersion: detailed.parserMetadata?.parserBuildVersion || parsed.parserBuildVersion || PLUGIN_BASE_VERSION,
    platform: platformProvenance()
  });
  if (resumeWorkspace) {
    const workspace = resolveGenerationWorkspace(resumeWorkspace, { libraryRoot });
    if (workspace.initializationResidue) {
      throw new PaperIdentityError('WORKSPACE_INITIALIZATION_INCOMPLETE', 'Initialization residues are read-only; inspect or abandon this workspace and run prepare again.');
    }
    if (workspace.workspace.state === 'abandoned') {
      throw new PaperIdentityError('WORKSPACE_ABANDONED', 'Abandoned workspaces are read-only and cannot be resumed.');
    }
    const storedIdentity = readPaperIdentity(path.join(workspace.packageDir, IDENTITY_RELATIVE_PATH));
    if (workspace.generationId !== identity.generationId || workspace.sourceRevisionId !== identity.sourceRevisionId || workspace.paperId !== identity.paperId
      || storedIdentity.generationId !== identity.generationId || storedIdentity.sourceRevisionId !== identity.sourceRevisionId || storedIdentity.paperId !== identity.paperId) {
      throw new PaperIdentityError('WORKSPACE_IDENTITY_MISMATCH', 'The requested workspace does not match the prepared paper identity.');
    }
    const artifacts = validateReusableGeneration({ paperDir: workspace.packageDir, identity: storedIdentity, managed: { record: workspace.workspace.publishIntent.paperRecord } });
    return {
      action: 'workspace_resumed', workspaceId: workspace.workspaceId, workspaceDir: workspace.workspaceDir,
      paperSlug: workspace.routeSlug, paperDir: workspace.packageDir, inputPath, sourceFilename, ...artifacts,
      identity: storedIdentity,
      diagnostics: storedIdentity.canonical.diagnostics,
      contextMode: storedIdentity.generation.inputs.contextMode,
      profile: storedIdentity.generation.inputs.requestedPaperProfile,
      workflow: storedIdentity.generation.inputs.workflow,
      language: storedIdentity.generation.inputs.language
    };
  }
  const preparation = options.migrationRouteSlug
    ? resolveMigrationPreparation(identity, options.migrationRouteSlug, options.migrationPaperRecord || null)
    : resolvePreparationAction(identity, basePaperSlug, indexState, {
      libraryRoot,
      resume,
      newRevision,
      reconcileIdentity
    });
  if (preparation.action === 'reused') {
    return {
      action: preparation.action,
      paperSlug: preparation.managed.record.routeAliases[0],
      paperDir: preparation.paperDir,
      inputPath,
      sourceFilename,
      ...preparation.artifacts,
      identity: preparation.identity,
      diagnostics: preparation.identity.canonical.diagnostics,
      contextMode: preparation.identity.generation.inputs.contextMode,
      profile: preparation.identity.generation.inputs.requestedPaperProfile,
      workflow: preparation.identity.generation.inputs.workflow,
      language: preparation.identity.generation.inputs.language
    };
  }

  const { managed } = preparation;
  const paperSlug = options.migrationRouteSlug || managed.record.routeAliases[0];
  identity.slug = paperSlug;
  const projection = identityProjection(identity);

  const paperData = {
    paperSlug,
    sourceFilename,
    sourceUrl,
    preparedAt: new Date().toISOString(),
    title: parsed.title,
    authors: parsed.authors,
    abstract: parsed.abstract,
    pageCount: parsed.pageCount,
    year: parsed.year,
    githubLinks: parsed.githubLinks,
    codeLinks: parsed.codeLinks,
    sections: parsed.sections,
    warnings: parsed.warnings,
    qualityFlags: parsed.qualityFlags,
    parserVersion: parsed.parserVersion,
    parserBuildVersion: parsed.parserBuildVersion,
    ...projection,
    rawText: detailed.rawText
  };

  const ledger = buildEvidenceLedger({
    parsed: detailed,
    source: {
      sourceUrl,
      sourceFilename,
      sha256: sourceSha256
    },
    paperSlug
  });
  const facts = buildFactsFromLedger(paperSlug, parsed.parserVersion, ledger);
  if (!validateFactsSchema(facts)) {
    const schemaErrors = (validateFactsSchema.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Generated facts.json does not satisfy facts 2.1 schema: ${schemaErrors}`);
  }
  const factsValidation = validateFactsEvidenceRefs(facts, ledger);
  if (!factsValidation.valid) {
    throw new Error(`Invalid facts evidence references: ${factsValidation.errors.join('; ')}`);
  }
  const analysis = buildAnalysisFromArtifacts(paperData, facts);
  const meta = {
    title: parsed.title,
    slug: paperSlug,
    authors: parsed.authors,
    abstract: parsed.abstract,
    year: parsed.year,
    date: today,
    tags: [],
    githubLinks: parsed.githubLinks,
    codeLinks: parsed.codeLinks,
    sourceFilename,
    parserVersion: parsed.parserVersion,
    packageVersion: PACKAGE_VERSION,
    factsSchemaVersion: '2.1.0',
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    reasoningSchemaVersion: REASONING_SCHEMA_VERSION,
    contextMode,
    requestedPaperProfile: profile,
    workflow,
    language,
    identitySchemaVersion: identity.schemaVersion,
    paperId: identity.paperId,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    sourceSha256: identity.source.sha256,
    generatedWith: {
      pluginVersion: PLUGIN_BASE_VERSION,
      pluginBuildVersion: identity.provenance.pluginBuildVersion,
      parserVersion: parsed.parserVersion,
      parserBuildVersion: parsed.parserBuildVersion
    },
    qualityFlags: parsed.qualityFlags,
    url: sourceUrl
  };
  meta.generationManifest = {
    schemaVersion: '2.0.0',
    manifestId: deriveManifestId({
      paperKey: managed.record.paperKey,
      sourceRevisionId: identity.sourceRevisionId,
      generationId: identity.generationId
    })
  };
  const softwareProvenance = collectSoftwareProvenance(identity);

  const workspace = await createGenerationWorkspace({
    identity,
    routeSlug: paperSlug,
    paperRecord: managed.record,
    reconciliation: preparation.reconciliation,
    tags: [],
    provenance: {
      identity,
      runtime: runtimeAttestation,
      software: softwareProvenance,
      source: {
        kind: resolvedInput.sourceKind,
        requestedUrl: resolvedInput.requestedUrl,
        resolvedUrl: sourceUrl,
        filename: sourceFilename,
        bytes: resolvedInput.sourceBytes,
        acquiredAt: resolvedInput.acquiredAt
      }
    },
    libraryRoot,
    lockTimeoutMs,
    populate: async ({ workspace: initializingWorkspace, lockHandle }) => {
      const write = (relativePath, data, maxBytes = 128 * 1024 * 1024) => writeAuthoringWithProvenance({
        workspace: initializingWorkspace,
        relativePath,
        data,
        precondition: { expectAbsent: true },
        actor: 'tool',
        lockHandle,
        maxBytes
      });
      const writeJson = (relativePath, value) => write(
        relativePath,
        `${JSON.stringify(value, null, 2)}\n`,
        64 * 1024 * 1024
      );
      write('paper.pdf', readFileNoFollowBounded(inputPath, 128 * 1024 * 1024));
      writeJson('paper-data.json', paperData);
      writeJson('evidence-ledger.json', ledger);
      writeJson('facts.json', facts);
      writeJson('analysis.json', analysis);
      writeJson('meta.json', meta);
      if (contextMode !== 'paper-only') writeJson('.codex-paper/external-evidence.json', buildExternalEvidenceManifest({ paperSlug, contextMode, sourceUrl }));
      writeJson(IDENTITY_RELATIVE_PATH, identity);
    }
  });
  const paperDir = workspace.packageDir;
  const externalEvidencePath = contextMode === 'paper-only' ? null : path.join(paperDir, '.codex-paper/external-evidence.json');

  return {
    action: 'workspace_created',
    workspaceId: workspace.workspaceId,
    workspaceDir: workspace.workspaceDir,
    paperSlug,
    paperDir,
    inputPath,
    sourceFilename,
    paperData,
    ledger,
    facts,
    analysis,
    meta,
    identity,
    diagnostics: identity.canonical.diagnostics,
    contextMode,
    profile,
    workflow,
    language,
    externalEvidencePath
  };
  } finally {
    resolvedInput.cleanup();
  }
}

async function runCli() {
  const args = parsePrepareArgs(process.argv.slice(2));
  const result = await preparePaper(args.input, args);
  process.stdout.write(`${JSON.stringify({
    action: result.action,
    workspaceId: result.workspaceId || null,
    workspaceDir: result.workspaceDir || null,
    paperSlug: result.paperSlug,
    paperDir: result.paperDir,
    sourceFilename: result.sourceFilename,
    parserVersion: result.paperData.parserVersion,
    packageVersion: PACKAGE_VERSION,
    contextMode: result.contextMode,
    requestedPaperProfile: result.profile,
    workflow: result.workflow,
    language: result.language,
    identity: {
      schemaVersion: result.identity.schemaVersion,
      paperId: result.identity.paperId,
      sourceRevisionId: result.identity.sourceRevisionId,
      generationId: result.identity.generationId
    },
    diagnostics: result.diagnostics,
    evidenceCount: result.ledger.evidence.length,
    analysisVersion: result.analysis.analysisVersion,
    externalEvidencePath: result.externalEvidencePath || null,
    next: result.workspaceId
      ? 'Run scaffold-reasoning-analysis.js with this exact workspace path, update authoring files through workspace-write, then validate inside the workspace. C2b publication is still required before Viewer visibility.'
      : 'This published generation was reused read-only; create or resume an exact generation workspace before authoring changes.'
  }, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    const code = error?.code || 'PREPARE_FAILED';
    console.error(`Error [${code}]: ${String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 2048)}`);
    process.exit(storageCliExitCode(error));
  });
}
