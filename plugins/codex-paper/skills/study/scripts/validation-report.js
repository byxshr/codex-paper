import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  classifyInvalidPackageArtifacts,
  classifyPackageCompatibility,
  resolveEvidenceRefs
} from '../../../src/shared/package-compatibility.mjs';
import { resolveLibraryPaper } from '../../../src/shared/paper-library.mjs';
import { isFrontMatterNoise } from './extract-facts.js';
import {
  IDENTITY_RELATIVE_PATH,
  assertIdentityProjection,
  readPaperIdentity,
  sha256File
} from './paper-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_SCHEMA_PATH = path.resolve(__dirname, '../schemas/validation-report-1.0.schema.json');
const LEDGER_SCHEMA_PATH = path.resolve(__dirname, '../schemas/evidence-ledger.schema.json');
const FACTS_SCHEMA_PATH = path.resolve(__dirname, '../schemas/facts-2.1.schema.json');
const REPORT_PATH = '.codex-paper/validation-report.json';
const REPORT_VERSION = '1.0.0';
const VALIDATOR = Object.freeze({
  name: 'codex-paper-validation',
  version: REPORT_VERSION,
  pluginBaseVersion: '2.0.0'
});
const MAX_FINDINGS = 500;
const MAX_MESSAGE_LENGTH = 500;
const MAX_REFS = 16;
const ACTIVE_METRIC = String.raw`(?:BLEU|accuracy|F1(?:[- ]score)?|ROUGE(?:-[12L])?|perplexity|PPL|AUC|AUROC|mAP|precision|recall|exact match|EM)`;
const CONFLICT_DISCLOSURE = /\b(?:conflict(?:ing)?|discrepanc(?:y|ies)|inconsisten(?:t|cy)|contradict(?:s|ion)?|unresolved)\b|冲突|不一致|矛盾|差异未解决/i;
const PARSER_LIMITED = new Set([
  'partial_sections',
  'noisy_reading_order',
  'noisy_table_extraction',
  'weak_quantitative_evidence',
  'severely_limited'
]);
const VISIBLE_FILES = [
  'README.md',
  'visual-assets.md',
  'summary.md',
  'insights.md',
  'method.md',
  'mental-model.md',
  'reflection.md',
  'qa.md',
  'index.html'
];

const reportAjv = new Ajv2020({ allErrors: true, strict: true });
const validateReport = reportAjv.compile(JSON.parse(fs.readFileSync(REPORT_SCHEMA_PATH, 'utf8')));
const artifactAjv = new Ajv2020({ allErrors: true, strict: false });
const validateLedger = artifactAjv.compile(JSON.parse(fs.readFileSync(LEDGER_SCHEMA_PATH, 'utf8')));
const validateFacts21 = artifactAjv.compile(JSON.parse(fs.readFileSync(FACTS_SCHEMA_PATH, 'utf8')));

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function relativeArtifact(value) {
  const normalized = String(value || 'package').replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return path.posix.basename(normalized);
  return normalized.replace(/^\.\/+/, '') || 'package';
}

function boundedMessage(value) {
  const message = String(value || 'Validation finding').replace(/\s+/g, ' ').trim();
  return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}

function normalizeLocations(locations = []) {
  return locations.slice(0, MAX_REFS).map((location) => ({
    evidenceRef: typeof location?.evidenceRef === 'string' ? location.evidenceRef : null,
    page: Number.isInteger(location?.page) && location.page >= 1 ? location.page : null,
    table: Number.isInteger(location?.table) && location.table >= 1 ? location.table : null
  }));
}

export function makeFinding({
  severity = 'error',
  code,
  category = 'package',
  artifact = 'package',
  path: pathValue = '/',
  message,
  evidenceRefs = [],
  locations = []
}) {
  const core = {
    severity: severity === 'warning' ? 'warning' : 'error',
    code: String(code || 'VALIDATION_ERROR').toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    category,
    artifact: relativeArtifact(artifact),
    path: String(pathValue || '/').replaceAll('\\', '/'),
    message: boundedMessage(message),
    evidenceRefs: Array.from(new Set(evidenceRefs.filter((ref) => typeof ref === 'string' && ref))).slice(0, MAX_REFS),
    locations: normalizeLocations(locations)
  };
  return {
    id: `finding-${sha256(stableJson(core)).slice(0, 16)}`,
    ...core
  };
}

export function adaptLegacyFinding(finding, severity, artifact = 'reasoning-analysis.json') {
  if (finding?.id && finding?.severity) return finding;
  return makeFinding({
    severity,
    code: finding?.code || 'VALIDATION_ERROR',
    category: String(finding?.code || '').includes('PARSER') ? 'parser' : 'evidence',
    artifact,
    path: finding?.path || '/',
    message: finding?.message || String(finding || 'Validation finding')
  });
}

function normalizeFindings(input) {
  const byId = new Map();
  for (const finding of input.filter(Boolean)) {
    const normalized = finding?.id ? finding : makeFinding(finding);
    if (!byId.has(normalized.id)) byId.set(normalized.id, normalized);
  }
  let findings = Array.from(byId.values()).sort((left, right) =>
    left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code)
    || left.artifact.localeCompare(right.artifact)
    || left.path.localeCompare(right.path)
    || left.id.localeCompare(right.id));
  if (findings.length > MAX_FINDINGS) {
    findings = findings.slice(0, MAX_FINDINGS - 1);
    findings.push(makeFinding({
      severity: 'error',
      code: 'VALIDATION_FINDINGS_TRUNCATED',
      category: 'package',
      artifact: REPORT_PATH,
      path: 'findings',
      message: `Validation produced more than ${MAX_FINDINGS} findings; the report is fail-closed and truncated.`
    }));
    findings.sort((left, right) => left.id.localeCompare(right.id));
  }
  return findings;
}

export function defaultScope(phase) {
  const common = [
    { artifact: 'meta.json', reason: 'Package version and identity declarations.' },
    { artifact: 'paper-data.json', reason: 'Parser output and abstract contamination signals.' },
    { artifact: 'evidence-ledger.json', reason: 'Paper evidence authority and reference targets.' },
    { artifact: 'facts.json', reason: 'Typed facts, ResultClaims, and compatibility projection.' },
    { artifact: 'analysis.json', reason: 'Low-level projection consistency and references.' },
    { artifact: 'reasoning-analysis.json', reason: 'Final research reasoning authority and references.' }
  ];
  const included = phase === 'complete'
    ? [...common, { artifact: 'user-visible materials', reason: 'Metric-bound numeric claims and conflict disclosure.' }]
    : common;
  const excluded = [
    { artifact: 'code/** execution', reason: 'Generated code execution requires the independent Docker sandbox authorization flow.' },
    { artifact: 'scientific truth outside supplied evidence', reason: 'The validator checks traceability and consistency, not external scientific truth.' },
    { artifact: 'complex table-grid reconstruction', reason: 'Advanced layout reconstruction remains P1-1.' },
    { artifact: 'directly opened exported index.html', reason: 'Viewer isolation is enforced by P0-A2; direct browser execution of exports is outside this report.' }
  ];
  if (phase === 'draft') {
    excluded.unshift({ artifact: 'user-visible materials', reason: 'Final study materials have not entered the reasoning-stage validation scope.' });
  }
  return { included, excluded };
}

export function emptyReferenceCoverage() {
  return { total: 0, valid: 0, invalid: 0, ratio: 1, byArtifact: [] };
}

export function buildReferenceCoverage(refGroups, validRefs) {
  const byArtifact = refGroups.map(({ artifact, refs }) => {
    const total = refs.length;
    const valid = refs.filter((ref) => validRefs.has(ref)).length;
    const invalid = total - valid;
    return { artifact, total, valid, invalid, ratio: total === 0 ? 1 : Number((valid / total).toFixed(4)) };
  });
  const total = byArtifact.reduce((sum, item) => sum + item.total, 0);
  const valid = byArtifact.reduce((sum, item) => sum + item.valid, 0);
  return {
    total,
    valid,
    invalid: total - valid,
    ratio: total === 0 ? 1 : Number((valid / total).toFixed(4)),
    byArtifact
  };
}

export function createValidationReport({
  findings = [],
  phase = 'draft',
  strict = false,
  scope = defaultScope(phase),
  referenceCoverage = emptyReferenceCoverage(),
  generatedAt = new Date().toISOString()
}) {
  const normalized = normalizeFindings(findings);
  const errors = normalized.filter((finding) => finding.severity === 'error');
  const warnings = normalized.filter((finding) => finding.severity === 'warning');
  const status = errors.length > 0 ? 'fail' : (warnings.length > 0 ? 'pass_with_warnings' : 'pass');
  const publishable = phase === 'complete' && status !== 'fail';
  const blocking = errors.length > 0 ? errors : (strict ? warnings : []);
  const outcome = blocking.length > 0
    ? 'block'
    : (phase === 'complete' ? 'allow_publish' : 'allow_authoring');
  const intrinsic = {
    schemaVersion: REPORT_VERSION,
    status,
    phase,
    publishable,
    scope,
    validator: VALIDATOR,
    findings: normalized,
    referenceCoverage
  };
  const report = {
    ...intrinsic,
    gate: {
      policy: strict ? 'strict' : 'standard',
      outcome,
      blockingFindingCodes: Array.from(new Set(blocking.map((finding) => finding.code))).sort()
    },
    generatedAt,
    reportHash: {
      algorithm: 'sha256',
      value: sha256(stableJson(intrinsic))
    },
    errors,
    warnings
  };
  if (!validateReport(report)) {
    const details = (validateReport.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Validation Report 1.0 schema failure: ${details}`);
  }
  return report;
}

function ensureSafeReportDirectory(paperDir) {
  const paperStats = fs.lstatSync(paperDir);
  if (!paperStats.isDirectory() || paperStats.isSymbolicLink()) throw new Error('Paper directory must be a non-symlink directory.');
  const codexDir = path.join(paperDir, '.codex-paper');
  try {
    fs.mkdirSync(codexDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const codexStats = fs.lstatSync(codexDir);
  if (!codexStats.isDirectory() || codexStats.isSymbolicLink()) throw new Error('.codex-paper must be a non-symlink directory.');
  const target = path.join(codexDir, 'validation-report.json');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('validation-report.json symlinks are not allowed.');
  }
  return { codexDir, target };
}

export function writeValidationReportAtomic(paperDir, report) {
  if (!canWriteValidationReport(paperDir)) {
    throw new Error('LEGACY_LAYOUT_READ_ONLY: validation reports cannot be written to a flat-layout package; migrate explicitly first.');
  }
  const { codexDir, target } = ensureSafeReportDirectory(paperDir);
  const temporary = path.join(codexDir, `.validation-report.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    const directoryDescriptor = fs.openSync(codexDir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
  return target;
}

export function canWriteValidationReport(paperDir) {
  const libraryRoot = path.resolve(process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'));
  const legacyRoot = path.join(libraryRoot, 'papers');
  const canonicalLegacyRoot = fs.existsSync(legacyRoot) ? fs.realpathSync(legacyRoot) : legacyRoot;
  const canonicalPaperDir = fs.existsSync(paperDir) ? fs.realpathSync(paperDir) : path.resolve(paperDir);
  const relativeToLegacy = path.relative(canonicalLegacyRoot, canonicalPaperDir);
  return !(relativeToLegacy && !path.isAbsolute(relativeToLegacy) && relativeToLegacy !== '..' && !relativeToLegacy.startsWith(`..${path.sep}`));
}

function readJsonArtifact(paperDir, name, findings, invalidArtifacts) {
  const filePath = path.join(paperDir, name);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('artifact is not a regular file');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    invalidArtifacts.push(name);
    findings.push(makeFinding({
      severity: 'error',
      code: 'PACKAGE_ARTIFACT_INVALID',
      category: 'schema',
      artifact: name,
      path: '/',
      message: `${name} is missing, unsafe, or invalid JSON.`
    }));
    return null;
  }
}

function validateArtifactSchema(value, validator, artifact, findings) {
  if (!value || validator(value)) return;
  for (const error of (validator.errors || []).slice(0, 25)) {
    findings.push(makeFinding({
      severity: 'error',
      code: 'PACKAGE_ARTIFACT_SCHEMA_INVALID',
      category: 'schema',
      artifact,
      path: error.instancePath || '/',
      message: `${artifact} ${error.instancePath || '/'} ${error.message}`
    }));
  }
}

function collectRefs(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, output));
    return output;
  }
  if (Array.isArray(value.evidenceRefs)) output.push(...value.evidenceRefs.filter((ref) => typeof ref === 'string'));
  Object.values(value).forEach((child) => collectRefs(child, output));
  return output;
}

function locationsForRefs(refs, evidenceIndex) {
  return refs.map((ref) => {
    const evidence = evidenceIndex.get(ref);
    const table = Number(String(evidence?.labels?.tableNumber || '').match(/\d+/)?.[0]);
    return {
      evidenceRef: ref,
      page: Number(evidence?.location?.page) || null,
      table: Number.isInteger(table) && table >= 1 ? table : null
    };
  });
}

function normalizedMetric(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numericValue(value) {
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function containsExactNumericValue(text, expected) {
  if (!Number.isFinite(expected)) return false;
  const value = String(text || '');
  const numericToken = /(?<![A-Za-z0-9_.])[-+]?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g;
  return Array.from(value.matchAll(numericToken)).some((match) => Number(match[0]) === expected);
}

function compatibleContext(left, right) {
  // Comparator wording describes the claimed relation, not the identity of the
  // evaluated result. It must not hide two values for the same task/dataset pair.
  const fields = ['task', 'dataset', 'split', 'languagePair', 'model'];
  if (!fields.every((field) => !left[field] || !right[field] || left[field] === right[field])) return false;
  return fields.some((field) => left[field] && right[field] && left[field] === right[field]);
}

function conflictPairs(resultClaims = []) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < resultClaims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < resultClaims.length; rightIndex += 1) {
      const left = resultClaims[leftIndex];
      const right = resultClaims[rightIndex];
      if (normalizedMetric(left.metric) !== normalizedMetric(right.metric)) continue;
      if (left.unit !== right.unit || left.direction !== right.direction || left.value === right.value) continue;
      if (!compatibleContext(left, right)) continue;
      pairs.push({ left, right, leftIndex, rightIndex });
    }
  }
  return pairs;
}

function stripMarkup(filename, value) {
  if (/\.html?$/i.test(filename)) {
    return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return String(value).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

function readVisibleMaterials(paperDir) {
  const materials = [];
  for (const filename of VISIBLE_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) continue;
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024) continue;
    materials.push({ filename, text: stripMarkup(filename, fs.readFileSync(filePath, 'utf8')) });
  }
  return materials;
}

function extractVisibleMetricClaims(text) {
  const claims = [];
  const valueBefore = new RegExp(`(?<![A-Za-z0-9_.-])(-?\\d+(?:\\.\\d+)?)(?:\\s*%\\s*|\\s+)(${ACTIVE_METRIC})\\b`, 'gi');
  const metricBefore = new RegExp(`\\b(${ACTIVE_METRIC})(?:\\s+(?:score|value))?(?:\\s+of|\\s*[:=])?\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?`, 'gi');
  for (const match of text.matchAll(valueBefore)) {
    const prefix = text.slice(Math.max(0, match.index - 24), match.index);
    if (/(?:section|page|table|figure|question|chapter)\s*$|\[\s*$/i.test(prefix)) continue;
    claims.push({ value: Number(match[1]), metric: match[2] });
  }
  for (const match of text.matchAll(metricBefore)) claims.push({ value: Number(match[2]), metric: match[1] });
  return claims;
}

function projectionFindings(facts, evidenceIndex) {
  const findings = [];
  const resultClaims = Array.isArray(facts?.resultClaims) ? facts.resultClaims : [];
  const keyResults = Array.isArray(facts?.keyResults) ? facts.keyResults : [];
  if (resultClaims.length !== keyResults.length) {
    findings.push(makeFinding({
      severity: 'error',
      code: 'KEY_RESULTS_PROJECTION_MISMATCH',
      category: 'cross_artifact',
      artifact: 'facts.json',
      path: 'keyResults',
      message: 'keyResults must contain exactly one compatibility projection per ResultClaim.'
    }));
    return findings;
  }
  resultClaims.forEach((claim, index) => {
    const projected = keyResults[index] || {};
    const projectedValue = numericValue(projected.value);
    const refsEqual = stableJson(Array.from(new Set(claim.evidenceRefs || [])).sort())
      === stableJson(Array.from(new Set(projected.evidenceRefs || [])).sort());
    if (normalizedMetric(projected.label) !== normalizedMetric(claim.metric)
      || projectedValue !== claim.value
      || !refsEqual) {
      findings.push(makeFinding({
        severity: 'error',
        code: 'KEY_RESULTS_PROJECTION_MISMATCH',
        category: 'cross_artifact',
        artifact: 'facts.json',
        path: `keyResults[${index}]`,
        message: `keyResults[${index}] does not match resultClaims[${index}].`,
        evidenceRefs: claim.evidenceRefs || [],
        locations: locationsForRefs(claim.evidenceRefs || [], evidenceIndex)
      }));
    }
  });
  return findings;
}

function paperIdentityFindings(paperDir, meta, paperData) {
  const findings = [];
  const identityPath = path.join(paperDir, IDENTITY_RELATIVE_PATH);
  const declaresIdentity = Boolean(meta?.identitySchemaVersion || meta?.paperId || meta?.generationId);
  if (!fs.existsSync(identityPath)) {
    if (declaresIdentity) {
      findings.push(makeFinding({
        severity: 'error', code: 'IDENTITY_MISSING', category: 'identity',
        artifact: IDENTITY_RELATIVE_PATH, path: '/',
        message: 'The package declares Paper Identity 1.0 but its identity record is missing.'
      }));
    }
    return findings;
  }
  let identity;
  try { identity = readPaperIdentity(identityPath); } catch {
    findings.push(makeFinding({
      severity: 'error', code: 'IDENTITY_SCHEMA_INVALID', category: 'identity',
      artifact: IDENTITY_RELATIVE_PATH, path: '/', message: 'The Paper Identity 1.0 record is invalid.'
    }));
    return findings;
  }
  for (const [artifact, value] of [['meta.json', meta], ['paper-data.json', paperData]]) {
    try { assertIdentityProjection(value, identity, artifact); } catch {
      findings.push(makeFinding({
        severity: 'error', code: 'IDENTITY_PROJECTION_MISMATCH', category: 'identity',
        artifact, path: 'identity', message: `${artifact} does not match the Paper Identity 1.0 record.`
      }));
    }
  }
  try {
    if (sha256File(path.join(paperDir, 'paper.pdf')) !== identity.source.sha256) throw new Error('hash mismatch');
  } catch {
    findings.push(makeFinding({
      severity: 'error', code: 'SOURCE_HASH_MISMATCH', category: 'identity',
      artifact: 'paper.pdf', path: '/', message: 'The stored PDF does not match the source revision in Paper Identity 1.0.'
    }));
  }
  const libraryRoot = path.resolve(process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'));
  try {
    const descriptor = resolveLibraryPaper(identity.slug, { libraryRoot });
    if (descriptor.mode === 'managed_v1' && path.resolve(paperDir) === descriptor.packageDir) {
      const rawIndex = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8'));
      const entries = Array.isArray(rawIndex) ? rawIndex : rawIndex.papers;
      const matches = Array.isArray(entries) ? entries.filter((entry) => entry?.storageKey === descriptor.paperKey) : [];
      if (matches.length !== 1
        || matches[0].sourceRevisionId !== identity.sourceRevisionId
        || matches[0].generationId !== identity.generationId) throw new Error('identity entry mismatch');
    }
  } catch (error) {
    if (error?.code !== 'PAPER_NOT_FOUND') {
      findings.push(makeFinding({
        severity: 'error', code: 'IDENTITY_PROJECTION_MISMATCH', category: 'identity',
        artifact: 'index.json', path: identity.slug,
        message: 'The managed library index does not match the authoritative current generation.'
      }));
    }
  }
  return findings;
}

export function inspectPackageArtifacts(paperDir, { reasoning = null, ledger = null, externalEvidence = null, phase = 'draft' } = {}) {
  const findings = [];
  const invalidArtifacts = [];
  const meta = readJsonArtifact(paperDir, 'meta.json', findings, invalidArtifacts);
  const paperData = readJsonArtifact(paperDir, 'paper-data.json', findings, invalidArtifacts);
  const facts = readJsonArtifact(paperDir, 'facts.json', findings, invalidArtifacts);
  const analysis = readJsonArtifact(paperDir, 'analysis.json', findings, invalidArtifacts);
  findings.push(...paperIdentityFindings(paperDir, meta, paperData));
  const resolvedLedger = ledger || readJsonArtifact(paperDir, 'evidence-ledger.json', findings, invalidArtifacts);
  const resolvedReasoning = reasoning || readJsonArtifact(paperDir, 'reasoning-analysis.json', findings, invalidArtifacts);
  const compatibility = invalidArtifacts.includes('meta.json')
    ? classifyInvalidPackageArtifacts(['meta.json'])
    : classifyPackageCompatibility({ meta, reasoning: resolvedReasoning, ledger: resolvedLedger });
  validateArtifactSchema(resolvedLedger, validateLedger, 'evidence-ledger.json', findings);
  if (compatibility.mode === 'native_2_1') {
    validateArtifactSchema(facts, validateFacts21, 'facts.json', findings);
  }
  const canWriteReport = ['native_2_1', 'compatible_2_0'].includes(compatibility.mode)
    && !invalidArtifacts.includes('meta.json');
  if (compatibility.mode === 'compatible_2_0') {
    findings.push(makeFinding({
      severity: 'warning',
      code: 'PACKAGE_COMPATIBILITY_LIMITED',
      category: 'compatibility',
      artifact: 'meta.json',
      path: 'packageVersion',
      message: 'Package 2.0.0 is validated through the read-only compatibility layer; no package artifacts are migrated.'
    }));
  } else if (compatibility.mode === 'unknown_read_only') {
    const diagnostic = compatibility.diagnostics?.[0];
    findings.push(makeFinding({
      severity: 'error',
      code: diagnostic?.code || 'PACKAGE_VERSION_UNSUPPORTED',
      category: 'compatibility',
      artifact: 'meta.json',
      path: 'packageVersion',
      message: diagnostic?.message || 'Package version is unsupported and report writes are disabled.'
    }));
  }

  const paperEvidence = new Map((resolvedLedger?.evidence || []).map((item) => [item.id, item]));
  const externalIndex = new Map((externalEvidence?.evidence || []).map((item) => [item.id, item]));
  const validRefs = new Set([...paperEvidence.keys(), ...externalIndex.keys()]);
  const factRefs = collectRefs(facts);
  const analysisRefs = collectRefs(analysis);
  const reasoningRefs = collectRefs(resolvedReasoning);
  const refGroups = [
    { artifact: 'facts.json', refs: factRefs },
    { artifact: 'analysis.json', refs: analysisRefs },
    { artifact: 'reasoning-analysis.json', refs: reasoningRefs }
  ];
  for (const { artifact, refs } of refGroups) {
    refs.forEach((ref, index) => {
      const resolved = resolveEvidenceRefs([ref], facts, resolvedLedger);
      const exists = validRefs.has(ref) || resolved.some((candidate) => validRefs.has(candidate));
      if (!exists) {
        findings.push(makeFinding({
          severity: 'error',
          code: 'EVIDENCE_REF_NOT_FOUND',
          category: 'evidence',
          artifact,
          path: `evidenceRefs[${index}]`,
          message: `Evidence reference does not resolve within this package: ${ref}`
        }));
      }
    });
  }
  const coverageRefs = refGroups.map((group) => ({
    artifact: group.artifact,
    refs: group.refs.map((ref) => resolveEvidenceRefs([ref], facts, resolvedLedger)[0] || ref)
  }));
  const referenceCoverage = buildReferenceCoverage(coverageRefs, validRefs);
  const hasNativeResultClaims = compatibility.mode === 'native_2_1' && facts?.schemaVersion === '2.1.0';
  if (hasNativeResultClaims) {
    findings.push(...projectionFindings(facts, paperEvidence));

    const materials = phase === 'complete' ? readVisibleMaterials(paperDir) : [];
    const visibleText = materials.map((item) => item.text).join('\n');
    const reasoningDisclosure = JSON.stringify(resolvedReasoning?.uncertaintyZones || []);
    const resultClaims = Array.isArray(facts?.resultClaims) ? facts.resultClaims : [];
    const supported = new Map(resultClaims.map((claim) => [
      `${normalizedMetric(claim.metric)}:${claim.value}`,
      claim
    ]));
    for (const [index, row] of (analysis?.resultsTable || []).entries()) {
      const value = numericValue(row?.value);
      if (!Number.isFinite(value) || !row?.metric) continue;
      const claim = supported.get(`${normalizedMetric(row.metric)}:${value}`);
      if (!claim) {
        findings.push(makeFinding({
          severity: 'error',
          code: 'ANALYSIS_RESULT_UNGROUNDED',
          category: 'cross_artifact',
          artifact: 'analysis.json',
          path: `resultsTable[${index}]`,
          message: `analysis.json contains ${value} ${row.metric}, which is not present in evidence-backed ResultClaims.`
        }));
        continue;
      }
      const analysisRefs = new Set(resolveEvidenceRefs(row.evidenceRefs || [], facts, resolvedLedger));
      const citesClaimEvidence = claim.evidenceRefs.some((ref) => analysisRefs.has(ref));
      const citesCorroboratingEvidence = Array.from(analysisRefs).some((ref) => {
        const text = String(paperEvidence.get(ref)?.text || '');
        return containsExactNumericValue(text, value)
          && new RegExp(`\\b${String(row.metric).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
      });
      if (!citesClaimEvidence && !citesCorroboratingEvidence) {
        findings.push(makeFinding({
          severity: 'error',
          code: 'ANALYSIS_RESULT_EVIDENCE_MISMATCH',
          category: 'cross_artifact',
          artifact: 'analysis.json',
          path: `resultsTable[${index}].evidenceRefs`,
          message: `analysis.json result ${value} ${row.metric} does not cite the corresponding ResultClaim evidence.`,
          evidenceRefs: claim.evidenceRefs,
          locations: locationsForRefs(claim.evidenceRefs, paperEvidence)
        }));
      }
    }
    for (const claim of extractVisibleMetricClaims(JSON.stringify(resolvedReasoning || {}))) {
      if (!supported.has(`${normalizedMetric(claim.metric)}:${claim.value}`)) {
        findings.push(makeFinding({
          severity: 'error',
          code: 'REASONING_RESULT_UNGROUNDED',
          category: 'cross_artifact',
          artifact: 'reasoning-analysis.json',
          path: '/',
          message: `reasoning-analysis.json contains ${claim.value} ${claim.metric}, which is not present in evidence-backed ResultClaims.`
        }));
      }
    }
    for (const pair of conflictPairs(resultClaims)) {
      const refs = Array.from(new Set([...(pair.left.evidenceRefs || []), ...(pair.right.evidenceRefs || [])]));
      findings.push(makeFinding({
        severity: 'warning',
        code: 'RESULT_VALUE_CONFLICT',
        category: 'cross_artifact',
        artifact: 'facts.json',
        path: `resultClaims[${pair.leftIndex}],resultClaims[${pair.rightIndex}]`,
        message: `${pair.left.metric} has conflicting supported values ${pair.left.value} and ${pair.right.value} in a compatible context.`,
        evidenceRefs: refs,
        locations: locationsForRefs(refs, paperEvidence)
      }));
      if (phase === 'complete') {
        const reasoningDisclosed = containsExactNumericValue(reasoningDisclosure, pair.left.value)
          && containsExactNumericValue(reasoningDisclosure, pair.right.value)
          && CONFLICT_DISCLOSURE.test(reasoningDisclosure);
        const visibleDisclosed = containsExactNumericValue(visibleText, pair.left.value)
          && containsExactNumericValue(visibleText, pair.right.value)
          && CONFLICT_DISCLOSURE.test(visibleText);
        if (!reasoningDisclosed || !visibleDisclosed) {
          findings.push(makeFinding({
            severity: 'error',
            code: 'RESULT_CONFLICT_UNDISCLOSED',
            category: 'cross_artifact',
            artifact: 'user-visible materials',
            path: '/',
            message: `The ${pair.left.value}/${pair.right.value} ${pair.left.metric} conflict must be explicit in both reasoning uncertainty and user-visible materials.`,
            evidenceRefs: refs,
            locations: locationsForRefs(refs, paperEvidence)
          }));
        }
      }
    }

    if (phase === 'complete') {
      for (const material of materials) {
        for (const claim of extractVisibleMetricClaims(material.text)) {
          if (!supported.has(`${normalizedMetric(claim.metric)}:${claim.value}`)) {
            findings.push(makeFinding({
              severity: 'error',
              code: 'VISIBLE_RESULT_UNGROUNDED',
              category: 'cross_artifact',
              artifact: material.filename,
              path: '/',
              message: `${material.filename} contains ${claim.value} ${claim.metric}, which is not present in evidence-backed ResultClaims.`
            }));
          }
        }
      }
    }
  }

  const abstract = String(paperData?.abstract || '');
  const noisePatterns = [
    /\bequal contributions?\b/i,
    /\bcopyright\b|©|all rights reserved/i,
    /\bconference\s+(?:on|at|20\d{2}|19\d{2})\b/i
  ];
  const contaminated = noisePatterns.some((pattern) => pattern.test(abstract));
  if (contaminated) {
    const noiseEvidence = (resolvedLedger?.evidence || []).filter((item) =>
      isFrontMatterNoise(item, new Map((resolvedLedger?.sections || []).map((section) => [section.id, section.canonicalRole])))
      && noisePatterns.some((pattern) => pattern.test(String(item.text || ''))));
    const refs = noiseEvidence.map((item) => item.id);
    findings.push(makeFinding({
      severity: 'warning',
      code: 'PARSER_FRONT_MATTER_CONTAMINATION',
      category: 'parser',
      artifact: 'paper-data.json',
      path: 'abstract',
      message: 'The parsed abstract contains front-matter footnote, copyright, or conference text.',
      evidenceRefs: refs,
      locations: locationsForRefs(refs, paperEvidence)
    }));
  }
  if ((resolvedLedger?.quality?.warnings || []).length > 0 || PARSER_LIMITED.has(resolvedReasoning?.evidenceQuality)) {
    findings.push(makeFinding({
      severity: 'warning',
      code: 'PARSER_QUALITY_LIMITED',
      category: 'parser',
      artifact: 'evidence-ledger.json',
      path: 'quality',
      message: 'The parser or authored reasoning explicitly reports limited evidence quality.'
    }));
  }

  return {
    findings,
    referenceCoverage,
    compatibility,
    canWriteReport,
    artifacts: { meta, paperData, facts, analysis, ledger: resolvedLedger, reasoning: resolvedReasoning },
    scope: defaultScope(phase)
  };
}

export {
  REPORT_PATH,
  REPORT_SCHEMA_PATH,
  REPORT_VERSION,
  VALIDATOR,
  validateReport
};
