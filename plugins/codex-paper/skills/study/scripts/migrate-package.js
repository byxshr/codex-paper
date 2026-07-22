#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildEvidenceLedger } from './build-evidence-ledger.js';
import { buildReasoningSkeleton, REVIEW_TEMPLATE } from './scaffold-reasoning-analysis.js';
import { classifyInvalidPackageArtifacts, classifyPackageCompatibility, isLegacyMigrationSourceVersion } from '../../../src/shared/package-compatibility.mjs';
import { getLibraryLayout, resolveExplicitPackage, resolveLibraryPaper } from '../../../src/shared/paper-library.mjs';
import { atomicWriteFile, fileWritePrecondition, withStorageLocks } from '../../../src/shared/storage-transaction.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_LAYOUT = getLibraryLayout(process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'));
const LIBRARY_ROOT = LIBRARY_LAYOUT.libraryRoot;
const PAPERS_ROOT = LIBRARY_LAYOUT.legacyPapersRoot;
const PACKAGE_VERSION = '2.0.0';
const CONTEXT_MODES = new Set(['paper-only', 'canonical', 'literature']);
const PAPER_PROFILES = new Set(['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other']);

function usage() {
  console.error('Usage: node migrate-package.js <paper-dir-or-slug> [--force] [--external-path] [--context paper-only|canonical|literature] [--profile auto|empirical|theoretical|architecture|system|benchmark|survey|post-training|position|other]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    force: false,
    externalPath: false,
    contextMode: null,
    profile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--external-path') {
      args.externalPath = true;
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
  if (args.contextMode && !CONTEXT_MODES.has(args.contextMode)) {
    throw new Error('--context must be paper-only, canonical, or literature');
  }
  if (args.profile && !PAPER_PROFILES.has(args.profile)) {
    throw new Error('--profile is not recognized');
  }
  return args;
}

function externalMigrationLockKey(canonicalPaperDir) {
  return `legacy:migration:${crypto.createHash('sha256').update(canonicalPaperDir).digest('hex')}`;
}

function migrationTargetForDescriptor(descriptor, options = {}) {
  if (descriptor.mode === 'generation_workspace_v1' || descriptor.mode === 'managed_v1' || descriptor.mode === 'managed_generation_v1') {
    throw new Error('MANAGED_LAYOUT_MIGRATION_REFUSED: Managed packages and generation workspaces must not be rewritten by the legacy migration tool.');
  }
  if (descriptor.mode === 'legacy_flat') {
    const canonicalPaperDir = fs.realpathSync(descriptor.packageDir);
    const canonicalPapersRoot = fs.realpathSync(PAPERS_ROOT);
    const legacyRelative = path.relative(canonicalPapersRoot, canonicalPaperDir);
    if (!legacyRelative || legacyRelative.startsWith('..') || path.isAbsolute(legacyRelative) || legacyRelative.includes(path.sep)) {
      throw new Error('LEGACY_PACKAGE_ROOT_REQUIRED: Migration input must identify one direct legacy paper package root.');
    }
    return { paperDir: canonicalPaperDir, lockKey: descriptor.paperLockKey || `legacy:${legacyRelative}` };
  }
  if (descriptor.mode !== 'explicit_path') {
    throw new Error('MANAGED_LAYOUT_MIGRATION_REFUSED: The migration target is not a writable legacy package.');
  }
  if (!options.externalPath) {
    throw new Error(`Refusing to migrate a directory outside ${PAPERS_ROOT}. Pass --external-path for an explicit out-of-library migration.`);
  }
  const canonicalPaperDir = fs.realpathSync(descriptor.packageDir);
  return { paperDir: canonicalPaperDir, lockKey: externalMigrationLockKey(canonicalPaperDir) };
}

function resolveMigrationTarget(input, options = {}) {
  const expanded = String(input || '').replace(/^~(?=$|\/)/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    const directStats = fs.lstatSync(direct);
    if (directStats.isSymbolicLink()) throw new Error('LIBRARY_PATH_UNSAFE: Migration input must not be a symbolic link.');
    const paperDir = directStats.isDirectory() ? direct : path.dirname(direct);
    const paperStats = fs.lstatSync(paperDir);
    if (paperStats.isSymbolicLink() || !paperStats.isDirectory()) throw new Error('LIBRARY_PATH_UNSAFE: Migration package root must be a real directory.');
    const descriptor = resolveExplicitPackage(paperDir, { libraryRoot: LIBRARY_ROOT });
    return migrationTargetForDescriptor(descriptor, options);
  }
  const descriptor = resolveLibraryPaper(input, { libraryRoot: LIBRARY_ROOT });
  return migrationTargetForDescriptor(descriptor, options);
}

function readJson(filePath, fallback = {}, label = path.basename(filePath)) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    const compatibility = classifyInvalidPackageArtifacts([label]);
    throw new Error(`${compatibility.diagnostics[0].code}: ${compatibility.diagnostics[0].message}`);
  }
}

function writeMigrationFile(paperDir, filePath, data, transaction) {
  const relativePath = path.relative(paperDir, filePath).split(path.sep).join('/');
  const precondition = fileWritePrecondition(filePath, 64 * 1024 * 1024);
  return atomicWriteFile({
    root: paperDir, relativePath, data, lockHandle: transaction.lockHandle, requiredLock: transaction.lockKey,
    maxBytes: 64 * 1024 * 1024, ...precondition
  });
}

function writeJsonAtomic(paperDir, filePath, value, transaction) {
  return writeMigrationFile(paperDir, filePath, `${JSON.stringify(value, null, 2)}\n`, transaction);
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

function normalizedPaperDataFromLegacy(paperDir, meta, paperData) {
  const publicData = publicDataFromLegacy(paperDir, meta, paperData);
  return {
    ...paperData,
    paperSlug: paperData.paperSlug || meta.slug || path.basename(paperDir),
    title: paperData.title || publicData.title,
    authors: Array.isArray(paperData.authors) ? paperData.authors : publicData.authors,
    abstract: paperData.abstract || publicData.abstract,
    pageCount: paperData.pageCount || publicData.pageCount,
    year: paperData.year || publicData.year,
    githubLinks: paperData.githubLinks || publicData.githubLinks,
    codeLinks: paperData.codeLinks || publicData.codeLinks,
    sections: paperData.sections || publicData.sections || {},
    warnings: Array.isArray(paperData.warnings) ? paperData.warnings : publicData.warnings,
    qualityFlags: Array.isArray(paperData.qualityFlags) ? paperData.qualityFlags : publicData.qualityFlags,
    parserVersion: paperData.parserVersion || publicData.parserVersion,
    rawText: paperData.rawText || publicData.rawText
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

async function migratePackageLocked(paperDir, options, transaction) {
  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    throw new Error(`Paper directory not found: ${paperDir}`);
  }

  const metaPath = path.join(paperDir, 'meta.json');
  const paperDataPath = path.join(paperDir, 'paper-data.json');
  const ledgerPath = path.join(paperDir, 'evidence-ledger.json');
  const reasoningPath = path.join(paperDir, 'reasoning-analysis.json');
  const meta = readJson(metaPath, {}, 'meta.json');
  const existingLedger = readJson(ledgerPath, null, 'evidence-ledger.json');
  const existingReasoning = readJson(reasoningPath, null, 'reasoning-analysis.json');
  const declaredVersion = typeof meta.packageVersion === 'string' ? meta.packageVersion.trim() : '';
  if (declaredVersion && declaredVersion !== PACKAGE_VERSION && !isLegacyMigrationSourceVersion(declaredVersion)) {
    throw new Error(`MIGRATION_SOURCE_VERSION_UNSUPPORTED: Package version ${declaredVersion} cannot be migrated by the v1-to-v2 tool.`);
  }
  const artifactCompatibility = classifyPackageCompatibility({ reasoning: existingReasoning, ledger: existingLedger });
  if (artifactCompatibility.mode === 'unknown_read_only') {
    throw new Error(`MIGRATION_SOURCE_VERSION_UNSUPPORTED: ${artifactCompatibility.diagnostics[0].message}`);
  }
  const paperData = readJson(paperDataPath, {}, 'paper-data.json');
  const paperSlug = meta.slug || paperData.paperSlug || path.basename(paperDir);
  const contextMode = options.contextMode ?? meta.contextMode ?? 'paper-only';
  const profile = options.profile ?? meta.requestedPaperProfile ?? 'auto';
  if (!CONTEXT_MODES.has(contextMode)) {
    throw new Error(`Invalid contextMode in migration input or meta.json: ${contextMode}`);
  }
  if (!PAPER_PROFILES.has(profile)) {
    throw new Error(`Invalid profile in migration input or meta.json: ${profile}`);
  }

  const wrote = [];
  let scaffoldedReasoning = false;
  const paperDataForMigration = normalizedPaperDataFromLegacy(paperDir, meta, paperData);

  if (!fs.existsSync(paperDataPath)) {
    writeJsonAtomic(paperDir, paperDataPath, paperDataForMigration, transaction);
    wrote.push('paper-data.json');
  }

  if (!fs.existsSync(ledgerPath) || options.force) {
    const ledger = await buildLedgerForPackage(paperDir, meta, paperDataForMigration);
    writeJsonAtomic(paperDir, ledgerPath, ledger, transaction);
    wrote.push('evidence-ledger.json');
  }

  if (contextMode !== 'paper-only') {
    const codexDir = path.join(paperDir, '.codex-paper');
    const externalPath = path.join(codexDir, 'external-evidence.json');
    if (!fs.existsSync(externalPath) || options.force) {
      writeJsonAtomic(paperDir, externalPath, buildExternalEvidenceManifest({ paperSlug, contextMode }), transaction);
      wrote.push('.codex-paper/external-evidence.json');
    }
  }

  if (!fs.existsSync(reasoningPath) || options.force) {
    const skeleton = buildReasoningSkeleton({ paperDir, contextMode, profile });
    writeJsonAtomic(paperDir, reasoningPath, skeleton, transaction);
    const reviewPath = path.join(paperDir, '.codex-paper', 'reasoning-review.md');
    if (!fs.existsSync(reviewPath) || options.force) {
      writeMigrationFile(paperDir, reviewPath, REVIEW_TEMPLATE, transaction);
      wrote.push('.codex-paper/reasoning-review.md');
    }
    scaffoldedReasoning = true;
    wrote.push('reasoning-analysis.json');
  }

  const nextMeta = {
    ...meta,
    title: meta.title || paperDataForMigration.title || paperSlug,
    slug: paperSlug,
    packageVersion: PACKAGE_VERSION,
    evidenceSchemaVersion: PACKAGE_VERSION,
    reasoningSchemaVersion: PACKAGE_VERSION,
    contextMode,
    requestedPaperProfile: profile,
    migrationStatus: scaffoldedReasoning ? 'reasoning-draft' : (meta.migrationStatus || 'reasoning-draft'),
    migratedAt: new Date().toISOString()
  };
  writeJsonAtomic(paperDir, metaPath, nextMeta, transaction);
  wrote.push('meta.json');

  return {
    paperDir,
    paperSlug,
    contextMode,
    profile,
    wrote,
    next: 'Fill reasoning-analysis.json from evidence-ledger.json, change status to complete, then run validate-reasoning.js. Use --strict only as an explicit warning-blocking policy.'
  };
}

export async function migratePackage(input, options = {}) {
  const { paperDir, lockKey } = resolveMigrationTarget(input, options);
  return withStorageLocks([lockKey], (lockHandle) => migratePackageLocked(paperDir, options, { lockKey, lockHandle }), {
    libraryRoot: LIBRARY_ROOT,
    timeoutMs: 10_000,
  });
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
