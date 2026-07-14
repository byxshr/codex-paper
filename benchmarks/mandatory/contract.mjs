import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const KNOWN_FINDING_CODES = new Set([
  'FRONT_MATTER_FOOTNOTE_IN_ABSTRACT',
  'FRONT_MATTER_COPYRIGHT_IN_ABSTRACT',
  'CONFERENCE_YEAR_AS_KEY_RESULT',
  'COPYRIGHT_YEAR_AS_KEY_RESULT',
  'FRONT_MATTER_NOISE_IN_ANALYSIS',
  'DATASET_YEAR_AS_KEY_RESULT',
  'EXPECTED_RESULT_41_8_NOT_SELECTED',
  'CONFLICTING_RESULT_41_0_SELECTED',
  'CROSS_ARTIFACT_RESULT_MISMATCH_UNGATED',
  'RESULT_CONFLICT_HAS_NO_VALIDATION_WARNING'
]);

const REQUIRED_LICENSE_FIELDS = [
  'id', 'kind', 'origin', 'copyright', 'spdx', 'license', 'redistributable', 'sha256', 'generator'
];

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  const resultTarget = gold?.reservedTargets?.resultClaims2_1;
  const reportTarget = gold?.reservedTargets?.validationReport1_0;
  if (!resultTarget || !Array.isArray(resultTarget.requiredValues) || resultTarget.requiredValues.length === 0) {
    errors.push('reservedTargets.resultClaims2_1.requiredValues must be non-empty');
  } else if (evidenceText) {
    for (const value of resultTarget.requiredValues) {
      if (!evidenceText.includes(String(value))) {
        errors.push(`reserved ResultClaim value is not supported by fixture evidence: ${value}`);
      }
    }
  }
  if (!Array.isArray(resultTarget?.forbiddenValues)) {
    errors.push('reservedTargets.resultClaims2_1.forbiddenValues must be an array');
  }
  if (resultTarget?.requiresDirectEvidenceRefs !== true) {
    errors.push('reservedTargets.resultClaims2_1.requiresDirectEvidenceRefs must be true');
  }
  if (reportTarget?.expectedStatus !== 'pass_with_warnings') {
    errors.push('reservedTargets.validationReport1_0.expectedStatus must be pass_with_warnings');
  }
  if (!Array.isArray(reportTarget?.expectedFindingCodes) || reportTarget.expectedFindingCodes.length === 0) {
    errors.push('reservedTargets.validationReport1_0.expectedFindingCodes must be non-empty');
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
    const expectedGenerator = `python3 benchmarks/fixtures/generate-pdf-fixtures.py --fixture ${entry.id}`;
    if (license.generator !== expectedGenerator) errors.push(`mandatory fixture ${entry.id} generator mismatch`);

    if (gold.schemaVersion !== '1.0.0') errors.push(`mandatory fixture ${entry.id} gold schemaVersion must be 1.0.0`);
    if (gold.fixtureId !== entry.id) errors.push(`mandatory fixture ${entry.id} gold fixtureId mismatch`);
    if (!gold.requiredAssertions || !gold.authoring) errors.push(`mandatory fixture ${entry.id} gold is missing required assertions or authoring`);
    if (!Array.isArray(gold.expectedFindings) || gold.expectedFindings.length === 0) {
      errors.push(`mandatory fixture ${entry.id} expectedFindings must be non-empty`);
    } else {
      const findingIds = new Set();
      for (const finding of gold.expectedFindings) {
        if (!KNOWN_FINDING_CODES.has(finding)) errors.push(`mandatory fixture ${entry.id} has unknown finding code: ${finding}`);
        if (findingIds.has(finding)) errors.push(`mandatory fixture ${entry.id} repeats finding code: ${finding}`);
        findingIds.add(finding);
      }
    }
    errors.push(...validateReservedTargets(gold).map((error) => `mandatory fixture ${entry.id} ${error}`));
    fixtures.push({ entry, pdfPath, licensePath, goldPath, license, gold });
  }
  return { errors, fixtures };
}

function valuesFromFacts(facts) {
  return (facts?.keyResults || []).map((item) => String(item.value));
}

function analysisContentText(analysis) {
  const content = {
    oneSentence: analysis?.oneSentence,
    problem: analysis?.problem,
    coreIdea: analysis?.coreIdea,
    contributions: analysis?.contributions,
    resultsTable: analysis?.resultsTable,
    limitations: analysis?.limitations,
    openQuestions: analysis?.openQuestions
  };
  return JSON.stringify(content);
}

export function detectExpectedFindings({ fixtureId, paperData, facts, analysis, reasoningReport, reservedTargets, validatorsPassed }) {
  const detected = [];
  const abstract = String(paperData?.abstract || '');
  const values = valuesFromFacts(facts);
  const analysisText = analysisContentText(analysis);
  if (fixtureId === 'front-matter-noise') {
    if (abstract.includes('Equal contribution')) detected.push('FRONT_MATTER_FOOTNOTE_IN_ABSTRACT');
    if (abstract.includes('Copyright 2026')) detected.push('FRONT_MATTER_COPYRIGHT_IN_ABSTRACT');
    if (values.includes('2017')) detected.push('CONFERENCE_YEAR_AS_KEY_RESULT');
    if (values.includes('2026')) detected.push('COPYRIGHT_YEAR_AS_KEY_RESULT');
    if (/Equal contribution|2017|2026/.test(analysisText)) detected.push('FRONT_MATTER_NOISE_IN_ANALYSIS');
  }
  if (fixtureId === 'result-conflict') {
    if (values.includes('2014')) detected.push('DATASET_YEAR_AS_KEY_RESULT');
    if (!values.includes('41.8')) detected.push('EXPECTED_RESULT_41_8_NOT_SELECTED');
    if (values.includes('41.0')) detected.push('CONFLICTING_RESULT_41_0_SELECTED');
    const required = (reservedTargets?.resultClaims2_1?.requiredValues || []).map(String);
    if (validatorsPassed && required.some((value) => !values.includes(value))) {
      detected.push('CROSS_ARTIFACT_RESULT_MISMATCH_UNGATED');
    }
    const warnings = reasoningReport?.warnings || [];
    if (!warnings.some((warning) => /conflict/i.test(`${warning.code || ''} ${warning.message || ''}`))) {
      detected.push('RESULT_CONFLICT_HAS_NO_VALIDATION_WARNING');
    }
  }
  return detected;
}

export function compareFindingContract(expected, observed) {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  return {
    missingExpected: expected.filter((code) => !observedSet.has(code)),
    unexpected: observed.filter((code) => !expectedSet.has(code))
  };
}

export function mandatoryTotalsPass(totals) {
  return totals.declared > 0
    && totals.executed === totals.declared
    && totals.completed === totals.declared
    && totals.failed === 0
    && totals.passed === totals.declared;
}
