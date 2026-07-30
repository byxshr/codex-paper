import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const REQUIRED_LICENSE_FIELDS = [
  'id', 'kind', 'origin', 'copyright', 'spdx', 'license', 'redistributable', 'sha256', 'generator'
];

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function parseProjectedResultValue(value) {
  const normalized = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d+)?%?$/.test(normalized)) return Number.NaN;
  return Number(normalized.endsWith('%') ? normalized.slice(0, -1) : normalized);
}

function isSafeRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function readJson(filePath, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

export function validateReservedTargets(gold, evidenceText = '') {
  const errors = [];
  const resultTarget = gold?.requiredAssertions?.resultClaims2_1;
  const reportTarget = gold?.requiredAssertions?.validationReport1_0;
  if (!resultTarget || !Array.isArray(resultTarget.required) || resultTarget.required.length === 0) {
    errors.push('requiredAssertions.resultClaims2_1.required must be non-empty');
  } else if (evidenceText) {
    for (const claim of resultTarget.required) {
      const value = claim?.value;
      if (!evidenceText.includes(String(value))) {
        errors.push(`required ResultClaim value is not supported by fixture evidence: ${value}`);
      }
    }
  }
  if (!Array.isArray(resultTarget?.forbiddenValues)) {
    errors.push('requiredAssertions.resultClaims2_1.forbiddenValues must be an array');
  }
  if (resultTarget?.requiresDirectEvidenceRefs !== true) {
    errors.push('requiredAssertions.resultClaims2_1.requiresDirectEvidenceRefs must be true');
  }
  if (reportTarget?.expectedStatus !== 'pass_with_warnings') {
    errors.push('requiredAssertions.validationReport1_0.expectedStatus must be pass_with_warnings');
  }
  if (!Array.isArray(reportTarget?.expectedFindingCodes) || reportTarget.expectedFindingCodes.length === 0) {
    errors.push('requiredAssertions.validationReport1_0.expectedFindingCodes must be non-empty');
  }
  return errors;
}

export function validateMandatoryManifest({ repoRoot, manifest }) {
  const errors = [];
  if (manifest?.schemaVersion !== '1.0.0') errors.push('mandatory manifest schemaVersion must be 1.0.0');
  if (!Array.isArray(manifest?.fixtures) || manifest.fixtures.length === 0) {
    errors.push('mandatory manifest must declare at least one fixture');
    return { errors, fixtures: [] };
  }

  const ids = new Set();
  const fixtures = [];
  for (const entry of manifest.fixtures) {
    if (typeof entry?.id !== 'string' || !entry.id) {
      errors.push('mandatory fixture id must be a non-empty string');
      continue;
    }
    if (ids.has(entry.id)) errors.push(`duplicate mandatory fixture id: ${entry.id}`);
    ids.add(entry.id);

    for (const field of ['pdf', 'licenseManifest', 'gold']) {
      if (!isSafeRepositoryPath(entry[field])) {
        errors.push(`mandatory fixture ${entry.id} has unsafe ${field} path`);
      }
    }
    if (errors.some((error) => error.includes(`fixture ${entry.id} has unsafe`))) continue;

    const pdfPath = path.join(repoRoot, entry.pdf);
    const licensePath = path.join(repoRoot, entry.licenseManifest);
    const goldPath = path.join(repoRoot, entry.gold);
    for (const [label, filePath] of [['PDF', pdfPath], ['license manifest', licensePath], ['gold', goldPath]]) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        errors.push(`mandatory fixture ${entry.id} ${label} is missing`);
      } else if (fs.lstatSync(filePath).isSymbolicLink()) {
        errors.push(`mandatory fixture ${entry.id} ${label} must not be a symlink`);
      }
    }
    if (![pdfPath, licensePath, goldPath].every((filePath) => fs.existsSync(filePath))) continue;

    const license = readJson(licensePath, `${entry.id} license manifest`, errors);
    const gold = readJson(goldPath, `${entry.id} gold`, errors);
    if (!license || !gold) continue;

    for (const field of REQUIRED_LICENSE_FIELDS) {
      if (field === 'redistributable') continue;
      if (typeof license[field] !== 'string' || !license[field]) {
        errors.push(`mandatory fixture ${entry.id} license field ${field} must be non-empty`);
      }
    }
    if (license.id !== entry.id) errors.push(`mandatory fixture ${entry.id} license id mismatch`);
    if (license.kind !== 'pdf') errors.push(`mandatory fixture ${entry.id} license kind must be pdf`);
    if (license.origin !== 'original-synthetic') errors.push(`mandatory fixture ${entry.id} must be original-synthetic`);
    if (license.redistributable !== true) errors.push(`mandatory fixture ${entry.id} must be redistributable`);
    if (license.sha256 !== sha256File(pdfPath)) errors.push(`mandatory fixture ${entry.id} sha256 mismatch`);
    const expectedGenerator = `bash plugins/codex-paper/scripts/runtime-python.sh benchmarks/fixtures/generate-pdf-fixtures.py --fixture ${entry.id}`;
    if (license.generator !== expectedGenerator) errors.push(`mandatory fixture ${entry.id} generator mismatch`);

    if (gold.schemaVersion !== '1.2.0') errors.push(`mandatory fixture ${entry.id} gold schemaVersion must be 1.2.0`);
    if (gold.fixtureId !== entry.id) errors.push(`mandatory fixture ${entry.id} gold fixtureId mismatch`);
    if (!gold.requiredAssertions || !gold.authoring) errors.push(`mandatory fixture ${entry.id} gold is missing required assertions or authoring`);
    errors.push(...validateReservedTargets(gold).map((error) => `mandatory fixture ${entry.id} ${error}`));
    fixtures.push({ entry, pdfPath, licensePath, goldPath, license, gold });
  }
  return { errors, fixtures };
}

export function validateValidationReportTarget(report, target, { strictReport = null } = {}) {
  const errors = [];
  const codes = new Set((report?.findings || []).map((finding) => finding.code));
  if (report?.schemaVersion !== '1.0.0') errors.push('validation report schemaVersion must be 1.0.0');
  if (report?.status !== target?.expectedStatus) errors.push(`validation report status must be ${target?.expectedStatus}`);
  if (report?.phase !== 'complete') errors.push('validation report phase must be complete');
  if (report?.publishable !== true) errors.push('standard validation report must be intrinsically publishable');
  if (report?.gate?.policy !== 'standard' || report?.gate?.outcome !== 'allow_publish') {
    errors.push('standard validation gate must allow_publish');
  }
  for (const code of target?.expectedFindingCodes || []) {
    if (!codes.has(code)) errors.push(`validation report is missing finding ${code}`);
  }
  if (strictReport) {
    if (strictReport.gate?.policy !== 'strict' || strictReport.gate?.outcome !== 'block') {
      errors.push('strict validation gate must block warnings');
    }
    for (const field of ['status', 'phase', 'publishable']) {
      if (strictReport[field] !== report?.[field]) errors.push(`strict validation changed intrinsic ${field}`);
    }
    if (strictReport.reportHash?.value !== report?.reportHash?.value) errors.push('strict validation changed reportHash');
    if (JSON.stringify(strictReport.findings) !== JSON.stringify(report?.findings)) errors.push('strict validation changed findings');
  }
  return errors;
}

export function mandatoryTotalsPass(totals) {
  return totals.declared > 0
    && totals.executed === totals.declared
    && totals.completed === totals.declared
    && totals.failed === 0
    && totals.passed === totals.declared;
}
