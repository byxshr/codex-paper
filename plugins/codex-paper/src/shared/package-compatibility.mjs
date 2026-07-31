export const PACKAGE_CONTRACT_VERSION = '2.1.0';
export const PREVIOUS_PACKAGE_VERSION = '2.0.0';
export const PAPER_EVIDENCE_ID_PATTERN = /^ev-p\d{3,}-[a-z]+-[a-f0-9]{10}$/;
export const EVIDENCE_ALIAS_MAP_VERSION = '1.0.0';

function diagnostic(code, message) {
  return { code, message };
}

export function isLegacyMigrationSourceVersion(version) {
  return typeof version === 'string' && /^1(?:\.|$)/.test(version.trim());
}

export function classifyInvalidPackageArtifacts(labels = []) {
  const invalid = Array.from(new Set(labels.filter((label) => typeof label === 'string' && label.trim()).map((label) => label.trim())));
  return {
    packageVersion: 'unknown',
    mode: 'unknown_read_only',
    readOnly: true,
    diagnostics: [diagnostic(
      'PACKAGE_ARTIFACT_INVALID',
      `${invalid.length > 0 ? invalid.join(', ') : 'Package compatibility artifact'} is not valid JSON; package compatibility cannot be established and writes are disabled.`
    )]
  };
}

export function classifyPackageCompatibility({ meta = null, reasoning = null, ledger = null } = {}) {
  const declared = typeof meta?.packageVersion === 'string' && meta.packageVersion.trim()
    ? meta.packageVersion.trim()
    : null;

  if (declared === PACKAGE_CONTRACT_VERSION) {
    return { packageVersion: declared, mode: 'native_2_1', readOnly: false, diagnostics: [] };
  }
  if (declared === PREVIOUS_PACKAGE_VERSION) {
    return { packageVersion: declared, mode: 'compatible_2_0', readOnly: true, diagnostics: [] };
  }
  if (declared) {
    return {
      packageVersion: declared,
      mode: 'unknown_read_only',
      readOnly: true,
      diagnostics: [diagnostic('PACKAGE_VERSION_UNSUPPORTED', `Package version ${declared} is not supported for validation or writes.`)]
    };
  }

  const artifacts = [reasoning, ledger].filter((artifact) => artifact !== null);
  const artifactVersions = artifacts
    .map((artifact) => typeof artifact?.schemaVersion === 'string' ? artifact.schemaVersion.trim() : '')
    .filter(Boolean);
  const hasVersionedArtifacts = artifacts.length > 0;

  if (artifacts.length > 0 && artifacts.every((artifact) => typeof artifact?.schemaVersion === 'string'
    && artifact.schemaVersion.trim() === PREVIOUS_PACKAGE_VERSION)) {
    return {
      packageVersion: PREVIOUS_PACKAGE_VERSION,
      mode: 'compatible_2_0',
      readOnly: true,
      diagnostics: [diagnostic('PACKAGE_VERSION_INFERRED', 'Package version 2.0.0 was inferred from frozen reasoning/evidence artifacts.')]
    };
  }

  if (hasVersionedArtifacts) {
    const unsupportedVersions = Array.from(new Set(artifactVersions.filter((version) => version !== PREVIOUS_PACKAGE_VERSION)));
    const missingVersionCount = artifacts.length - artifactVersions.length;
    const offendingVersions = [
      ...unsupportedVersions,
      ...(missingVersionCount > 0 ? [`missing (${missingVersionCount} artifact${missingVersionCount === 1 ? '' : 's'})`] : [])
    ];
    const artifactVersion = unsupportedVersions[0] || 'unknown';
    return {
      packageVersion: artifactVersion,
      mode: 'unknown_read_only',
      readOnly: true,
      diagnostics: [diagnostic('PACKAGE_VERSION_UNSUPPORTED', `Package artifacts declare unsupported or missing version: ${offendingVersions.join(', ') || 'unknown'}; validation and writes are disabled.`)]
    };
  }

  return {
    packageVersion: 'legacy',
    mode: 'legacy_v1',
    readOnly: true,
    diagnostics: []
  };
}

export function assertWritablePackage(compatibility) {
  if (!compatibility?.readOnly) return;
  const unsupported = compatibility.diagnostics?.find((item) => item.code === 'PACKAGE_VERSION_UNSUPPORTED');
  if (unsupported) throw new Error(`${unsupported.code}: ${unsupported.message}`);
  throw new Error(`PACKAGE_VERSION_READ_ONLY: Package version ${compatibility.packageVersion || 'legacy'} is read-only; use an explicit migration workflow before writing.`);
}

const LEGACY_REF = /^(claim|result|limitation):(\d+)$/;
const FACT_KEYS = { claim: 'coreClaims', result: 'keyResults', limitation: 'limitations' };

function evidenceRefExists(ref, ledger) {
  if (ledger == null) return true;
  return Array.isArray(ledger?.evidence) && ledger.evidence.some((item) => item?.id === ref);
}

export function resolveLegacyEvidenceRef(ref, facts, ledger = null) {
  if (typeof ref !== 'string') return [];
  if (PAPER_EVIDENCE_ID_PATTERN.test(ref)) return evidenceRefExists(ref, ledger) ? [ref] : [];
  const match = ref.match(LEGACY_REF);
  if (!match) return [];
  const item = facts?.[FACT_KEYS[match[1]]]?.[Number(match[2])];
  return Array.isArray(item?.evidenceRefs)
    ? item.evidenceRefs.filter((candidate) => typeof candidate === 'string'
      && PAPER_EVIDENCE_ID_PATTERN.test(candidate)
      && evidenceRefExists(candidate, ledger))
    : [];
}

export function validateEvidenceAliasMap(aliasMap, ledger = null) {
  if (aliasMap == null) return null;
  const aliases = aliasMap?.aliases;
  if (aliasMap?.schemaVersion !== EVIDENCE_ALIAS_MAP_VERSION
    || !Array.isArray(aliases)
    || aliases.length > 20000
    || new Set(aliases.map((item) => item?.sourceRef)).size !== aliases.length) {
    const error = new Error('Evidence alias map is invalid.');
    error.code = 'EVIDENCE_ALIAS_MAP_INVALID';
    error.statusCode = 422;
    throw error;
  }
  const ledgerIds = ledger == null ? null : new Set((ledger?.evidence || []).map((item) => item?.id));
  for (const item of aliases) {
    if (!(PAPER_EVIDENCE_ID_PATTERN.test(String(item?.sourceRef || '')) || LEGACY_REF.test(String(item?.sourceRef || '')))
      || !Array.isArray(item?.targetRefs) || item.targetRefs.length === 0 || item.targetRefs.length > 32
      || new Set(item.targetRefs).size !== item.targetRefs.length
      || item.targetRefs.some((ref) => !PAPER_EVIDENCE_ID_PATTERN.test(String(ref)) || (ledgerIds && !ledgerIds.has(ref)))
      || !['identity', 'fact_projection', 'content_hash'].includes(item?.method)
      || !/^[a-f0-9]{64}$/.test(String(item?.sourceArtifactSha256 || ''))) {
      const error = new Error('Evidence alias map contains an invalid or unbound alias.');
      error.code = 'EVIDENCE_ALIAS_MAP_INVALID';
      error.statusCode = 422;
      throw error;
    }
  }
  const coverage = aliasMap?.coverage;
  if (!coverage || !Number.isInteger(coverage.referenced) || !Number.isInteger(coverage.resolved)
    || !Number.isInteger(coverage.unresolved) || coverage.referenced !== coverage.resolved + coverage.unresolved
    || coverage.ratio !== (coverage.referenced === 0 ? 1 : coverage.resolved / coverage.referenced)) {
    const error = new Error('Evidence alias coverage is invalid.');
    error.code = 'EVIDENCE_ALIAS_MAP_INVALID';
    error.statusCode = 422;
    throw error;
  }
  return aliasMap;
}

export function resolveEvidenceRefs(refs, facts, ledger = null, aliasMap = null) {
  const aliases = validateEvidenceAliasMap(aliasMap, ledger);
  const bySource = new Map((aliases?.aliases || []).map((item) => [item.sourceRef, item.targetRefs]));
  return Array.from(new Set((refs || []).flatMap((ref) => {
    if (PAPER_EVIDENCE_ID_PATTERN.test(String(ref)) && evidenceRefExists(ref, ledger)) return [ref];
    if (bySource.has(ref)) return bySource.get(ref);
    return resolveLegacyEvidenceRef(ref, facts, ledger);
  })));
}

export function isLegacyFactRef(ref) {
  return typeof ref === 'string' && LEGACY_REF.test(ref);
}
