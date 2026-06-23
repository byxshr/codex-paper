import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildAnalysisFromArtifacts } from './build-analysis.js';
import { buildEvidenceLedger } from './build-evidence-ledger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
const INDEX_PATH = path.join(LIBRARY_ROOT, 'index.json');
const PACKAGE_VERSION = '2.0.0';
const CONTEXT_MODES = new Set(['paper-only', 'canonical', 'literature']);
const PAPER_PROFILES = new Set(['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other']);

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

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

function buildEvidenceItem(section, text) {
  return {
    section,
    quote: text
  };
}

function normalizeForEvidenceMatch(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findEvidenceRefForQuote(ledger, quote) {
  const normalizedQuote = normalizeForEvidenceMatch(quote);
  if (!normalizedQuote || normalizedQuote.length < 24) {
    return [];
  }

  const exact = ledger.evidence.find((item) => {
    const normalizedText = normalizeForEvidenceMatch(item.text);
    return normalizedText === normalizedQuote || normalizedText.includes(normalizedQuote) || normalizedQuote.includes(normalizedText);
  });

  return exact ? [exact.id] : [];
}

function attachLedgerEvidenceRefs(facts, ledger) {
  const withRefs = structuredClone(facts);

  for (const key of ['coreClaims', 'keyResults', 'limitations']) {
    const items = Array.isArray(withRefs[key]) ? withRefs[key] : [];
    for (const item of items) {
      const quote = item.evidence?.quote || item.text || item.context || '';
      const evidenceRefs = findEvidenceRefForQuote(ledger, quote);
      if (evidenceRefs.length > 0) {
        item.evidenceRefs = evidenceRefs;
      }
    }
  }

  return withRefs;
}

function extractCoreClaims(parsed) {
  const candidates = [];
  const claimSections = [
    ['abstract', parsed.sections.abstract],
    ['introduction', parsed.sections.introduction],
    ['conclusion', parsed.sections.conclusion]
  ];

  for (const [section, content] of claimSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b(?:introduce|propose|present|show|demonstrate|develop|our approach|this paper)\b/i.test(sentence));
    for (const sentence of sentences) {
      candidates.push({
        text: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  if (candidates.length === 0 && parsed.sections.abstract) {
    const firstSentence = splitSentences(parsed.sections.abstract)[0];
    if (firstSentence) {
      candidates.push({
        text: firstSentence,
        evidence: buildEvidenceItem('abstract', firstSentence)
      });
    }
  }

  return candidates;
}

function extractKeyResults(parsed) {
  const candidates = [];
  const resultSections = [
    ['abstract', parsed.sections.abstract],
    ['conclusion', parsed.sections.conclusion]
  ];

  for (const [section, content] of resultSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b\d+(?:\.\d+)?\b/.test(sentence) || /\b(?:outperform|improve|benchmark|state-of-the-art|languages|billion|million)\b/i.test(sentence));
    for (const sentence of sentences) {
      const valueMatch = sentence.match(/\b\d+(?:\.\d+)?(?:\s?(?:%|percent|points?|languages?|billion|million|hours?|x))?\b/i);
      const labelMatch = sentence.match(/\b(?:accuracy|score|benchmark|languages|parameters|performance|efficiency|improvement)\b/i);
      candidates.push({
        label: labelMatch ? labelMatch[0] : `Result ${candidates.length + 1}`,
        value: valueMatch ? valueMatch[0] : 'See evidence',
        context: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  return candidates;
}

function extractLimitations(parsed) {
  const candidates = [];
  const limitationSections = [
    ['conclusion', parsed.sections.conclusion],
    ['abstract', parsed.sections.abstract],
    ['introduction', parsed.sections.introduction]
  ];

  for (const [section, content] of limitationSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b(?:however|limitation|future work|remain|challenge|unstable|risk)\b/i.test(sentence));
    for (const sentence of sentences) {
      candidates.push({
        text: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  return candidates;
}

function buildFacts(paperSlug, parsed) {
  return {
    paperSlug,
    parserVersion: parsed.parserVersion,
    coreClaims: extractCoreClaims(parsed),
    keyResults: extractKeyResults(parsed),
    limitations: extractLimitations(parsed)
  };
}

function resolveInput(input) {
  if (/^https?:\/\//i.test(input)) {
    const scriptPath = path.join(__dirname, 'download-pdf.cjs');
    const output = execFileSync(process.execPath, [scriptPath, input], {
      encoding: 'utf8'
    }).trim();

    return {
      inputPath: output.split('\n').pop().trim(),
      sourceUrl: input
    };
  }

  return {
    inputPath: path.resolve(input),
    sourceUrl: null
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
    schemaVersion: '2.0.0',
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

  const { inputPath, sourceUrl } = resolveInput(userInput);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`PDF not found: ${inputPath}`);
  }

  const detailed = await parsePdfDetailed(inputPath);
  const parsed = detailed.publicData;
  const sourceFilename = path.basename(inputPath);
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
  const facts = attachLedgerEvidenceRefs(buildFacts(paperSlug, parsed), ledger);
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
    evidenceSchemaVersion: PACKAGE_VERSION,
    reasoningSchemaVersion: PACKAGE_VERSION,
    contextMode,
    requestedPaperProfile: profile,
    generatedWith: {
      pluginVersion: PACKAGE_VERSION,
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
    contextMode,
    profile,
    externalEvidencePath
  };
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
