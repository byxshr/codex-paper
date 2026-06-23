#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildEvidenceLedger } from './build-evidence-ledger.js';
import { scaffoldReasoningAnalysis } from './scaffold-reasoning-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
const PACKAGE_VERSION = '2.0.0';
const CONTEXT_MODES = new Set(['paper-only', 'canonical', 'literature']);
const PAPER_PROFILES = new Set(['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other']);

function usage() {
  console.error('Usage: node migrate-package.js <paper-dir-or-slug> [--force] [--context paper-only|canonical|literature] [--profile auto|empirical|theoretical|architecture|system|benchmark|survey|post-training|position|other]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    force: false,
    contextMode: 'paper-only',
    profile: 'auto'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--context') {
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
    throw new Error('Missing paper directory or slug');
  }
  if (!CONTEXT_MODES.has(args.contextMode)) {
    throw new Error('--context must be paper-only, canonical, or literature');
  }
  if (!PAPER_PROFILES.has(args.profile)) {
    throw new Error('--profile is not recognized');
  }
  return args;
}

function resolvePaperDir(input) {
  const expanded = String(input || '').replace(/^~(?=$|\/)/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    return fs.statSync(direct).isDirectory() ? direct : path.dirname(direct);
  }
  return path.join(PAPERS_ROOT, input);
}

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fallbackPagesFromText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) {
    const message = 'Legacy package did not retain parseable raw paper text. Evidence coverage is severely limited.';
    return [{
      page: 1,
      text: message,
      rawTextStart: 0,
      rawTextEnd: message.length,
      blockCount: 1
    }];
  }

  const pages = [];
  const pageSize = 8000;
  for (let offset = 0; offset < text.length; offset += pageSize) {
    const chunk = text.slice(offset, offset + pageSize);
    pages.push({
      page: pages.length + 1,
      text: chunk,
      rawTextStart: offset,
      rawTextEnd: offset + chunk.length,
      blockCount: chunk.trim() ? 1 : 0
    });
  }
  return pages;
}

function publicDataFromLegacy(paperDir, meta, paperData) {
  const slug = meta.slug || paperData.paperSlug || path.basename(paperDir);
  const rawText = paperData.rawText || [paperData.abstract, ...Object.values(paperData.sections || {})].filter(Boolean).join('\n\n');
  return {
    title: meta.title || paperData.title || slug,
    authors: Array.isArray(meta.authors) ? meta.authors : (Array.isArray(paperData.authors) ? paperData.authors : []),
    abstract: meta.abstract || paperData.abstract || '',
    sections: paperData.sections || {},
    pageCount: paperData.pageCount || Math.max(1, fallbackPagesFromText(rawText).length),
    year: meta.year || paperData.year || null,
    githubLinks: paperData.githubLinks || meta.githubLinks || [],
    codeLinks: paperData.codeLinks || meta.codeLinks || [],
    warnings: ['Migrated from a legacy package; evidence was reconstructed from retained package text.'],
    qualityFlags: ['legacy-migration'],
    parserVersion: paperData.parserVersion || meta.parserVersion || 'legacy-migration',
    rawText
  };
}

function buildExternalEvidenceManifest({ paperSlug, contextMode }) {
  return {
    schemaVersion: PACKAGE_VERSION,
    paperSlug,
    contextMode,
    generatedAt: new Date().toISOString(),
    policy: {
      paperOnlyDefault: false,
      storedSeparatelyFromEvidenceLedger: true,
      note: 'External evidence must be added explicitly and must never be copied into evidence-ledger.json.'
    },
    sources: [],
    evidence: []
  };
}

async function buildLedgerForPackage(paperDir, meta, paperData) {
  const pdfPath = path.join(paperDir, 'paper.pdf');
  const paperSlug = meta.slug || paperData.paperSlug || path.basename(paperDir);
  if (fs.existsSync(pdfPath)) {
    const detailed = await parsePdfDetailed(pdfPath);
    return buildEvidenceLedger({
      parsed: detailed,
      source: {
        sourceFilename: 'paper.pdf',
        sourceUrl: meta.url || paperData.sourceUrl || null,
        sha256: sha256File(pdfPath)
      },
      paperSlug
    });
  }

  const publicData = publicDataFromLegacy(paperDir, meta, paperData);
  const pages = fallbackPagesFromText(publicData.rawText);
  return buildEvidenceLedger({
    parsed: {
      publicData,
      rawText: publicData.rawText,
      pages,
      sectionTree: null,
      parserMetadata: {
        parser: 'legacy-migration',
        parserVersion: 'legacy-migration',
        warnings: publicData.warnings
      }
    },
    source: {
      sourceFilename: meta.sourceFilename || paperData.sourceFilename || null,
      sourceUrl: meta.url || paperData.sourceUrl || null,
      sha256: null
    },
    paperSlug
  });
}

export async function migratePackage(input, options = {}) {
  const paperDir = resolvePaperDir(input);
  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    throw new Error(`Paper directory not found: ${paperDir}`);
  }

  const metaPath = path.join(paperDir, 'meta.json');
  const paperDataPath = path.join(paperDir, 'paper-data.json');
  const ledgerPath = path.join(paperDir, 'evidence-ledger.json');
  const reasoningPath = path.join(paperDir, 'reasoning-analysis.json');
  const meta = readJson(metaPath);
  const paperData = readJson(paperDataPath, {});
  const paperSlug = meta.slug || paperData.paperSlug || path.basename(paperDir);
  const contextMode = options.contextMode || meta.contextMode || 'paper-only';
  const profile = options.profile || meta.requestedPaperProfile || 'auto';

  const wrote = [];
  if (!fs.existsSync(ledgerPath) || options.force) {
    const ledger = await buildLedgerForPackage(paperDir, meta, paperData);
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    wrote.push('evidence-ledger.json');
  }

  const nextMeta = {
    ...meta,
    title: meta.title || paperData.title || paperSlug,
    slug: paperSlug,
    packageVersion: PACKAGE_VERSION,
    evidenceSchemaVersion: PACKAGE_VERSION,
    reasoningSchemaVersion: PACKAGE_VERSION,
    contextMode,
    requestedPaperProfile: profile,
    migrationStatus: 'reasoning-draft',
    migratedAt: new Date().toISOString()
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`);
  wrote.push('meta.json');

  if (contextMode !== 'paper-only') {
    const codexDir = path.join(paperDir, '.codex-paper');
    fs.mkdirSync(codexDir, { recursive: true });
    const externalPath = path.join(codexDir, 'external-evidence.json');
    if (!fs.existsSync(externalPath) || options.force) {
      fs.writeFileSync(externalPath, `${JSON.stringify(buildExternalEvidenceManifest({ paperSlug, contextMode }), null, 2)}\n`);
      wrote.push('.codex-paper/external-evidence.json');
    }
  }

  if (!fs.existsSync(reasoningPath) || options.force) {
    scaffoldReasoningAnalysis(paperDir, {
      force: Boolean(options.force),
      contextMode,
      profile
    });
    wrote.push('reasoning-analysis.json', '.codex-paper/reasoning-review.md');
  }

  return {
    paperDir,
    paperSlug,
    contextMode,
    profile,
    wrote,
    next: 'Fill reasoning-analysis.json from evidence-ledger.json, change status to complete, then run validate-reasoning.js --strict.'
  };
}

async function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await migratePackage(args.input, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    usage();
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  runCli();
}
