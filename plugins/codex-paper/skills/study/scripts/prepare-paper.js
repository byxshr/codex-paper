import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildAnalysisFromArtifacts } from './build-analysis.js';
import { buildEvidenceLedger } from './build-evidence-ledger.js';
import { buildFactsFromLedger, validateFactsEvidenceRefs } from './extract-facts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { stagePdfInput } = require('./download-pdf.cjs');
const LIBRARY_ROOT = path.resolve(process.env.PAPERS_DIR || path.join(process.env.HOME || '', 'codex-papers'));
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
const INDEX_PATH = path.join(LIBRARY_ROOT, 'index.json');
const PACKAGE_VERSION = '2.1.0';
const PLUGIN_BASE_VERSION = '2.0.0';
const EVIDENCE_SCHEMA_VERSION = '2.0.0';
const REASONING_SCHEMA_VERSION = '2.0.0';
const CONTEXT_MODES = new Set(['paper-only', 'canonical', 'literature']);
const PAPER_PROFILES = new Set(['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other']);
const FACTS_SCHEMA_PATH = path.resolve(__dirname, '../schemas/facts-2.1.schema.json');
const validateFactsSchema = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(fs.readFileSync(FACTS_SCHEMA_PATH, 'utf8')));

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parsePrepareArgs(argv) {
  const args = {
    input: null,
    contextMode: 'paper-only',
    profile: 'auto'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--context') {
      args.contextMode = argv[index + 1];
      index += 1;
    } else if (arg === '--profile') {
      args.profile = argv[index + 1];
      index += 1;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error('Paper input is required');
  }

  if (!CONTEXT_MODES.has(args.contextMode)) {
    throw new Error('--context must be paper-only, canonical, or literature');
  }

  if (!PAPER_PROFILES.has(args.profile)) {
    throw new Error('--profile is not recognized');
  }

  return args;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
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

function readIndexPreserveShape() {
  if (!fs.existsSync(INDEX_PATH)) {
    return {
      raw: [],
      papers: [],
      isArray: true
    };
  }

  const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
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

function writeIndexPreserveShape(indexState) {
  if (indexState.isArray) {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(indexState.papers, null, 2));
    return;
  }

  indexState.raw.papers = indexState.papers;
  fs.writeFileSync(INDEX_PATH, JSON.stringify(indexState.raw, null, 2));
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

function maybeWriteExternalEvidenceManifest({ paperDir, paperSlug, contextMode, sourceUrl }) {
  if (contextMode === 'paper-only') {
    return null;
  }

  const codexDir = path.join(paperDir, '.codex-paper');
  ensureDir(codexDir);
  const outputPath = path.join(codexDir, 'external-evidence.json');
  const manifest = buildExternalEvidenceManifest({ paperSlug, contextMode, sourceUrl });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return outputPath;
}

export async function preparePaper(userInput, options = {}) {
  if (!userInput) {
    throw new Error('Paper input is required');
  }

  const contextMode = options.contextMode || 'paper-only';
  const profile = options.profile || 'auto';
  if (!CONTEXT_MODES.has(contextMode)) {
    throw new Error('contextMode must be paper-only, canonical, or literature');
  }
  if (!PAPER_PROFILES.has(profile)) {
    throw new Error('profile is not recognized');
  }

  ensureDir(PAPERS_ROOT);

  const resolvedInput = await resolveInput(userInput);
  const { inputPath, sourceUrl } = resolvedInput;
  try {
  const detailed = await parsePdfDetailed(inputPath);
  const parsed = detailed.publicData;
  parsed.warnings = Array.from(new Set([...(resolvedInput.inputWarnings || []), ...(parsed.warnings || [])]));
  const sourceFilename = resolvedInput.sourceFilename || path.basename(inputPath);
  const paperSlug = slugify(parsed.title || path.basename(inputPath, path.extname(inputPath)));
  const paperDir = path.join(PAPERS_ROOT, paperSlug);
  const today = new Date().toISOString().slice(0, 10);
  const sourceSha256 = sha256File(inputPath);

  ensureDir(paperDir);

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
    generatedWith: {
      pluginVersion: PLUGIN_BASE_VERSION,
      parserVersion: parsed.parserVersion
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
    qualityFlags: parsed.qualityFlags,
    url: sourceUrl
  };

  fs.copyFileSync(inputPath, path.join(paperDir, 'paper.pdf'));
  fs.writeFileSync(path.join(paperDir, 'paper-data.json'), JSON.stringify(paperData, null, 2));
  fs.writeFileSync(path.join(paperDir, 'evidence-ledger.json'), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const externalEvidencePath = maybeWriteExternalEvidenceManifest({ paperDir, paperSlug, contextMode, sourceUrl });

  const indexState = readIndexPreserveShape();
  const existingIndex = indexState.papers.findIndex((paper) => paper.slug === paperSlug);
  if (existingIndex >= 0) {
    indexState.papers[existingIndex] = {
      ...indexState.papers[existingIndex],
      ...indexEntry
    };
  } else {
    indexState.papers.push(indexEntry);
  }
  writeIndexPreserveShape(indexState);

  return {
    paperSlug,
    paperDir,
    inputPath,
    sourceFilename,
    paperData,
    ledger,
    facts,
    analysis,
    meta,
    contextMode,
    profile,
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
    paperSlug: result.paperSlug,
    paperDir: result.paperDir,
    sourceFilename: result.sourceFilename,
    parserVersion: result.paperData.parserVersion,
    packageVersion: PACKAGE_VERSION,
    contextMode: result.contextMode,
    requestedPaperProfile: result.profile,
    evidenceCount: result.ledger.evidence.length,
    analysisVersion: result.analysis.analysisVersion,
    externalEvidencePath: result.externalEvidencePath || null,
    next: 'Run scaffold-reasoning-analysis.js, fill reasoning-analysis.json from the evidence ledger, then run validate-reasoning.js --strict before authoring visible materials.'
  }, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    console.error(`Error preparing paper: ${error.message}`);
    process.exit(1);
  });
}
