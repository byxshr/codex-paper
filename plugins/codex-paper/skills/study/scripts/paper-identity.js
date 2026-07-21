import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PLUGIN_ROOT = path.resolve(__dirname, '../../..');
export const IDENTITY_SCHEMA_VERSION = '1.0.0';
export const GENERATION_CONTRACT_VERSION = '1.0.0';
export const PACKAGE_VERSION = '2.1.0';
export const PLUGIN_BASE_VERSION = '2.0.0';
export const PARSER_CONTRACT_VERSION = '2.0.0';
export const EVIDENCE_SCHEMA_VERSION = '2.0.0';
export const FACTS_SCHEMA_VERSION = '2.1.0';
export const REASONING_SCHEMA_VERSION = '2.0.0';
export const IDENTITY_RELATIVE_PATH = '.codex-paper/paper-identity.json';

const IDENTITY_SCHEMA_PATH = path.resolve(__dirname, '../schemas/paper-identity-1.0.schema.json');
const GENERATION_CONTRACT_PATH = path.resolve(__dirname, '../generation-contract-1.0.json');
const validateIdentitySchema = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(fs.readFileSync(IDENTITY_SCHEMA_PATH, 'utf8')));

export class PaperIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaperIdentityError';
    this.code = code;
    this.details = details;
  }
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function normalizeDoi(value) {
  if (typeof value !== 'string') return null;
  let normalized = value.trim();
  normalized = normalized.replace(/^doi\s*:\s*/i, '');
  normalized = normalized.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  try { normalized = decodeURIComponent(normalized); } catch { return null; }
  normalized = normalized.trim().replace(/[\s>.,;:}\]]+$/g, '');
  while (normalized.endsWith(')') && (normalized.match(/\(/g) || []).length < (normalized.match(/\)/g) || []).length) {
    normalized = normalized.slice(0, -1);
  }
  normalized = normalized.toLowerCase();
  if (normalized.length > 255 || !/^10\.\d{4,9}\/[a-z0-9][a-z0-9._;()/:+-]*$/i.test(normalized)) return null;
  return normalized;
}

export function normalizeArxiv(value) {
  if (typeof value !== 'string') return null;
  let normalized = value.trim();
  normalized = normalized.replace(/^arxiv\s*:\s*/i, '');
  normalized = normalized.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '');
  normalized = normalized.replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
  const modern = /^\d{4}\.\d{4,5}$/;
  const legacy = /^[a-z][a-z0-9.-]+(?:\.[a-z]{2})?\/\d{7}$/;
  return modern.test(normalized) || legacy.test(normalized) ? normalized : null;
}

function addCandidate(target, kind, value, source) {
  if (!value) return;
  const key = `${kind}:${value}`;
  const existing = target.get(key) || { kind, value, sources: new Set(), confidence: 'high' };
  existing.sources.add(source);
  target.set(key, existing);
}

function candidatesFromInputUrl(inputUrl, target) {
  if (typeof inputUrl !== 'string' || !/^https:\/\//i.test(inputUrl)) return;
  let parsed;
  try { parsed = new URL(inputUrl); } catch { return; }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return;
  const hostname = parsed.hostname.toLowerCase();
  const authority = inputUrl.match(/^https:\/\/([^/]+)\//i)?.[1]?.toLowerCase();
  if (authority !== hostname) return;
  if (hostname === 'arxiv.org') {
    const match = parsed.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i);
    addCandidate(target, 'arxiv', normalizeArxiv(match?.[1] || ''), 'input_url');
  } else if (hostname === 'doi.org') {
    addCandidate(target, 'doi', normalizeDoi(parsed.pathname.replace(/^\//, '')), 'input_url');
  }
}

function candidatesFromFrontMatter(pages, target) {
  for (const [index, page] of (Array.isArray(pages) ? pages.slice(0, 2) : []).entries()) {
    const source = `pdf_front_matter_page_${index + 1}`;
    const lines = String(page?.text || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const doiMatch = line.match(/^(?:doi\s*:\s*|https:\/\/doi\.org\/)(10\.\d{4,9}\/[a-z0-9][a-z0-9._;()/:+\-]*)(?:\s*)$/i);
      if (doiMatch) addCandidate(target, 'doi', normalizeDoi(doiMatch[1]), source);
      const arxivMatch = line.match(/^arxiv\s*:\s*((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)(?:\s+\[[^\]]+\])?(?:\s+.*)?$/i);
      if (arxivMatch) addCandidate(target, 'arxiv', normalizeArxiv(arxivMatch[1]), source);
    }
  }
}

export function resolveCanonicalIdentity({ inputUrl = null, pages = [], sourceSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(String(sourceSha256 || ''))) {
    throw new PaperIdentityError('SOURCE_HASH_INVALID', 'Source SHA-256 is invalid.');
  }
  const candidateMap = new Map();
  candidatesFromInputUrl(inputUrl, candidateMap);
  candidatesFromFrontMatter(pages, candidateMap);
  const candidates = [...candidateMap.values()]
    .map((item) => ({ ...item, sources: [...item.sources].sort() }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
  const diagnostics = [];
  for (const kind of ['doi', 'arxiv']) {
    const values = candidates.filter((item) => item.kind === kind).map((item) => item.value);
    if (values.length > 1) diagnostics.push({ code: 'CANONICAL_ID_CONFLICT', kind, values: [...values].sort() });
  }
  if (diagnostics.length > 0) {
    return {
      paperId: `source:sha256:${sourceSha256}`,
      canonical: { resolution: 'source_fallback', primary: null, aliases: [], candidates, diagnostics }
    };
  }
  const doi = candidates.find((item) => item.kind === 'doi') || null;
  const arxiv = candidates.find((item) => item.kind === 'arxiv') || null;
  const primary = doi || arxiv;
  return {
    paperId: primary ? `${primary.kind}:${primary.value}` : `source:sha256:${sourceSha256}`,
    canonical: {
      resolution: primary ? 'canonical' : 'source_fallback',
      primary,
      aliases: [doi, arxiv].filter((item) => item && item !== primary),
      candidates,
      diagnostics: []
    }
  };
}

export function normalizeExternalSourceLocator(sourceUrl) {
  if (typeof sourceUrl !== 'string' || !/^https:\/\//i.test(sourceUrl)) return null;
  try {
    const url = new URL(sourceUrl);
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function assertContractRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new PaperIdentityError('GENERATION_CONTRACT_INVALID', 'Generation contract contains an invalid path.');
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== relativePath) {
    throw new PaperIdentityError('GENERATION_CONTRACT_INVALID', 'Generation contract escapes the plugin root.');
  }
  return normalized;
}

export function buildContentContract(workflow, options = {}) {
  if (!['study', 'summary'].includes(workflow)) throw new PaperIdentityError('WORKFLOW_INVALID', 'Workflow must be study or summary.');
  const pluginRoot = options.pluginRoot || PLUGIN_ROOT;
  const manifestPath = options.manifestPath || path.join(pluginRoot, 'skills/study/generation-contract-1.0.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== GENERATION_CONTRACT_VERSION || !Array.isArray(manifest.common) || !Array.isArray(manifest.workflows?.[workflow])) {
    throw new PaperIdentityError('GENERATION_CONTRACT_INVALID', 'Generation contract manifest is invalid.');
  }
  const relativePaths = [...new Set([...manifest.common, ...manifest.workflows[workflow]].map(assertContractRelativePath))].sort();
  const files = relativePaths.map((relativePath) => {
    const filePath = path.join(pluginRoot, relativePath);
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new PaperIdentityError('GENERATION_CONTRACT_INVALID', 'Generation contract file is not a regular file.');
    return { path: relativePath, sha256: sha256File(filePath) };
  });
  return {
    version: manifest.version,
    sha256: sha256(canonicalStringify({ version: manifest.version, files })),
    files
  };
}

export function readPluginBuildVersion(pluginRoot = PLUGIN_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  return String(manifest.version || PLUGIN_BASE_VERSION);
}

export function buildPaperIdentity({
  slug,
  sourceSha256,
  sourceUrl = null,
  pages = [],
  workflow = 'study',
  language = 'en',
  contextMode = 'paper-only',
  requestedPaperProfile = 'auto',
  parserBackend,
  parserBackendVersion,
  parserContractVersion = PARSER_CONTRACT_VERSION,
  contentContract = null,
  pluginBuildVersion = readPluginBuildVersion(),
  platform = `${process.platform}-${process.arch}`,
  createdAt = new Date().toISOString()
}) {
  const resolved = resolveCanonicalIdentity({ inputUrl: sourceUrl, pages, sourceSha256 });
  const generationInputs = {
    sourceSha256,
    identityPolicyVersion: IDENTITY_SCHEMA_VERSION,
    generationContractVersion: GENERATION_CONTRACT_VERSION,
    packageVersion: PACKAGE_VERSION,
    pluginBaseVersion: PLUGIN_BASE_VERSION,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
    reasoningSchemaVersion: REASONING_SCHEMA_VERSION,
    workflow,
    language,
    contextMode,
    requestedPaperProfile,
    parser: {
      backend: String(parserBackend || 'unknown'),
      backendVersion: String(parserBackendVersion || 'unknown'),
      contractVersion: parserContractVersion
    },
    externalSourceLocator: contextMode === 'paper-only' ? null : normalizeExternalSourceLocator(sourceUrl),
    contentContract: contentContract || buildContentContract(workflow)
  };
  const fingerprint = sha256(canonicalStringify(generationInputs));
  const identity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    slug,
    paperId: resolved.paperId,
    sourceRevisionId: `sha256:${sourceSha256}`,
    generationId: `gen:sha256:${fingerprint}`,
    source: { sha256: sourceSha256 },
    canonical: resolved.canonical,
    generation: { fingerprint: { algorithm: 'sha256', value: fingerprint }, inputs: generationInputs },
    provenance: { createdAt, pluginBuildVersion, platform }
  };
  const validation = validatePaperIdentity(identity);
  if (!validation.valid) throw new PaperIdentityError('IDENTITY_SCHEMA_INVALID', validation.errors.join('; '));
  return identity;
}

export function identityProjection(identity) {
  return {
    identitySchemaVersion: identity.schemaVersion,
    paperId: identity.paperId,
    sourceRevisionId: identity.sourceRevisionId,
    generationId: identity.generationId,
    sourceSha256: identity.source.sha256
  };
}

export function validatePaperIdentity(identity) {
  const errors = [];
  if (!validateIdentitySchema(identity)) {
    errors.push(...(validateIdentitySchema.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`));
    return { valid: false, errors };
  }
  const expectedFingerprint = sha256(canonicalStringify(identity.generation.inputs));
  const contentContract = identity.generation.inputs.contentContract;
  const expectedContractHash = sha256(canonicalStringify({ version: contentContract.version, files: contentContract.files }));
  if (contentContract.sha256 !== expectedContractHash) errors.push('content contract hash does not match its file hashes');
  const contractPaths = contentContract.files.map((file) => file.path);
  if (new Set(contractPaths).size !== contractPaths.length) errors.push('content contract contains duplicate file paths');
  if (JSON.stringify(contractPaths) !== JSON.stringify([...contractPaths].sort())) errors.push('content contract file paths are not stably sorted');
  if (identity.generation.fingerprint.value !== expectedFingerprint) errors.push('generation fingerprint does not match canonical inputs');
  if (identity.generationId !== `gen:sha256:${expectedFingerprint}`) errors.push('generationId does not match generation fingerprint');
  if (identity.sourceRevisionId !== `sha256:${identity.source.sha256}`) errors.push('sourceRevisionId does not match source SHA-256');
  const expectedPaperId = identity.canonical.resolution === 'canonical' && identity.canonical.primary
    ? `${identity.canonical.primary.kind}:${identity.canonical.primary.value}`
    : `source:sha256:${identity.source.sha256}`;
  if (identity.paperId !== expectedPaperId) errors.push('paperId does not match canonical resolution');
  return { valid: errors.length === 0, errors };
}

export function readPaperIdentity(identityPath) {
  let identity;
  try {
    const stats = fs.lstatSync(identityPath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('not a regular file');
    identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new PaperIdentityError('IDENTITY_INVALID', 'Paper identity record is missing or invalid.');
  }
  const validation = validatePaperIdentity(identity);
  if (!validation.valid) throw new PaperIdentityError('IDENTITY_INVALID', 'Paper identity record is invalid.', { errors: validation.errors });
  return identity;
}

export function assertIdentityProjection(container, identity, label) {
  const projection = identityProjection(identity);
  for (const [key, value] of Object.entries(projection)) {
    if (container?.[key] !== value) throw new PaperIdentityError('IDENTITY_PROJECTION_MISMATCH', `${label} identity projection does not match the identity record.`);
  }
}

export function platformProvenance() {
  return `${os.platform()}-${os.arch()}`;
}
