import crypto from 'node:crypto';
import fs from 'fs';
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
  ensureManagedStore,
  getLibraryLayout,
  listManagedRecords,
  readCurrentRecord,
  readOverlayState,
  readPaperRecord,
  reconcilePaperRecord,
  requireSafeDirectory,
  sourceDirectoryName,
  generationDirectoryName,
  writeJsonAtomicNoFollow
} from '../../../src/shared/paper-library.mjs';

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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
    reconcileIdentity: null
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
  if (args.reconcileIdentity !== null && !args.reconcileIdentity) throw new PaperIdentityError('ARGUMENT_INVALID', '--reconcile-identity requires an existing route alias.');

  return args;
}

async function resolveInput(input) {
  const staged = await stagePdfInput(input);
  return {
    inputPath: staged.path,
    sourceUrl: /^https:\/\//i.test(input) ? input : null,
    sourceFilename: staged.sourceFilename,
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

function writeIndexPreserveShape(indexPath, indexState) {
  const content = indexState.isArray
    ? JSON.stringify(indexState.papers, null, 2)
    : (() => {
        indexState.raw.papers = indexState.papers;
        return JSON.stringify(indexState.raw, null, 2);
      })();
  const temporary = `${indexPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, indexPath);
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

function writeFileExclusive(filePath, content, mode = 0o600) {
  const parent = path.dirname(filePath);
  const parentStats = fs.lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new PaperIdentityError('PAPER_PATH_UNSAFE', 'Paper output directory is unsafe.');
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeJsonExclusive(filePath, value) {
  writeFileExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFileExclusive(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

function maybeWriteExternalEvidenceManifest({ paperDir, paperSlug, contextMode, sourceUrl }) {
  if (contextMode === 'paper-only') {
    return null;
  }

  const codexDir = path.join(paperDir, '.codex-paper');
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { mode: 0o700 });
  const outputPath = path.join(codexDir, 'external-evidence.json');
  const manifest = buildExternalEvidenceManifest({ paperSlug, contextMode, sourceUrl });
  writeJsonExclusive(outputPath, manifest);
  return outputPath;
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

function allocateRouteSlug(baseSlug, identity, managedRecords, indexState, legacyPapersRoot) {
  const used = new Set([
    ...managedRecords.flatMap(({ record }) => record.routeAliases),
    ...indexState.papers.map((entry) => entry?.slug).filter(Boolean)
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
      const artifacts = validateReusableGeneration(match);
      const record = reconcilePaperRecord(match.managed.record, identity.paperId, identity);
      writeJsonAtomicNoFollow(path.join(match.managed.recordDir, 'paper.json'), record);
      const papers = indexState.papers.map((entry) => entry?.storageKey === record.paperKey
        ? { ...entry, paperId: record.primaryPaperId, paperIdAliases: record.paperIdAliases }
        : entry);
      writeIndexPreserveShape(layout.indexPath, { ...indexState, papers });
      return { action: 'reconciled', paperDir: match.paperDir, identity: match.identity, artifacts, managed: { ...match.managed, record } };
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
    const routeSlug = allocateRouteSlug(baseSlug, identity, managedRecords, indexState, layout.legacyPapersRoot);
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
  return { action: 'created', paperDir, identity, managed, packageRelativePath };
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
  if (!CONTEXT_MODES.has(contextMode)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'contextMode must be paper-only, canonical, or literature.');
  }
  if (!PAPER_PROFILES.has(profile)) {
    throw new PaperIdentityError('ARGUMENT_INVALID', 'profile is not recognized.');
  }
  if (!WORKFLOWS.has(workflow)) throw new PaperIdentityError('ARGUMENT_INVALID', 'workflow must be study or summary.');
  if (!LANGUAGES.has(language)) throw new PaperIdentityError('ARGUMENT_INVALID', 'language must be zh or en.');
  if (replace) throw new PaperIdentityError('ARGUMENT_INVALID', '--replace is not supported before P0-C2; no existing generation will be overwritten.');
  if (resume && newRevision) throw new PaperIdentityError('ARGUMENT_INVALID', '--resume and --new-revision are mutually exclusive.');

  const libraryRoot = path.resolve(options.libraryRoot || process.env.PAPERS_DIR || path.join(process.env.HOME || '', 'codex-papers'));
  const layout = getLibraryLayout(libraryRoot);
  fs.mkdirSync(libraryRoot, { recursive: true, mode: 0o700 });
  const indexState = readIndexPreserveShape(layout.indexPath);

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
    sourceUrl,
    pages: detailed.pages,
    workflow,
    language,
    contextMode,
    requestedPaperProfile: profile,
    parserBackend: detailed.parserMetadata?.parser || 'unknown',
    parserBackendVersion: detailed.parserMetadata?.backendVersion || 'unknown',
    pluginBuildVersion: detailed.parserMetadata?.parserBuildVersion || parsed.parserBuildVersion || PLUGIN_BASE_VERSION,
    platform: platformProvenance()
  });
  const preparation = resolvePreparationAction(identity, basePaperSlug, indexState, {
    libraryRoot,
    resume,
    newRevision,
    reconcileIdentity
  });
  if (preparation.action === 'reused' || preparation.action === 'reconciled') {
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

  ensureManagedStore({ libraryRoot });
  const { managed, paperDir } = preparation;
  if (managed.isNew) {
    fs.mkdirSync(managed.recordDir, { recursive: false, mode: 0o700 });
    fs.mkdirSync(path.join(managed.recordDir, 'overlay'), { mode: 0o700 });
    fs.mkdirSync(path.join(managed.recordDir, 'overlay', 'files'), { mode: 0o700 });
  } else {
    requireSafeDirectory(managed.recordDir, layout.recordsRoot);
    requireSafeDirectory(path.join(managed.recordDir, 'overlay'), managed.recordDir);
  }
  fs.mkdirSync(paperDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(paperDir, '.codex-paper'), { mode: 0o700 });
  const paperSlug = managed.record.routeAliases[0];
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

  const indexEntry = {
    id: paperSlug,
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
    contextMode,
    workflow,
    language,
    ...projection,
    qualityFlags: parsed.qualityFlags,
    url: sourceUrl
  };
  indexEntry.storageKey = managed.record.paperKey;
  indexEntry.paperId = managed.record.primaryPaperId;
  indexEntry.paperIdAliases = managed.record.paperIdAliases;

  copyFileExclusive(inputPath, path.join(paperDir, 'paper.pdf'));
  writeJsonExclusive(path.join(paperDir, 'paper-data.json'), paperData);
  writeJsonExclusive(path.join(paperDir, 'evidence-ledger.json'), ledger);
  writeJsonExclusive(path.join(paperDir, 'facts.json'), facts);
  writeJsonExclusive(path.join(paperDir, 'analysis.json'), analysis);
  writeJsonExclusive(path.join(paperDir, 'meta.json'), meta);
  const externalEvidencePath = maybeWriteExternalEvidenceManifest({ paperDir, paperSlug, contextMode, sourceUrl });
  writeJsonExclusive(path.join(paperDir, IDENTITY_RELATIVE_PATH), identity);

  if (managed.isNew || managed.reconciled) {
    writeJsonAtomicNoFollow(path.join(managed.recordDir, 'paper.json'), managed.record);
  }
  if (managed.isNew) {
    writeJsonAtomicNoFollow(path.join(managed.recordDir, 'overlay', 'state.json'), {
      schemaVersion: '1.0.0',
      tags: [],
      progress: {},
      annotations: []
    });
  } else {
    readOverlayState({ mode: 'managed_v1', overlayDir: path.join(managed.recordDir, 'overlay') });
  }
  const current = {
    schemaVersion: '1.0.0',
    paperKey: managed.record.paperKey,
    paperId: identity.paperId,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    packageRelativePath: preparation.packageRelativePath
  };
  writeJsonAtomicNoFollow(path.join(managed.recordDir, 'current.json'), current);
  const existingIndex = indexState.papers.findIndex((entry) => entry?.storageKey === managed.record.paperKey
    || managed.record.routeAliases.includes(entry?.slug));
  if (existingIndex >= 0) indexState.papers[existingIndex] = { ...indexState.papers[existingIndex], ...indexEntry, tags: readOverlayState({ mode: 'managed_v1', overlayDir: path.join(managed.recordDir, 'overlay') }).tags };
  else indexState.papers.push(indexEntry);
  writeIndexPreserveShape(layout.indexPath, indexState);

  return {
    action: 'created',
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
    next: 'Run scaffold-reasoning-analysis.js, fill reasoning-analysis.json from the evidence ledger, then run validate-reasoning.js before authoring visible materials. Use --strict only as an explicit warning-blocking policy.'
  }, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    const code = error?.code || 'PREPARE_FAILED';
    console.error(`Error [${code}]: ${String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 2048)}`);
    process.exit(code === 'ARGUMENT_INVALID' ? 2 : 1);
  });
}
