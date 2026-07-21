import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeAuthoringBoundary } from './authoring-boundary.mjs';
import {
  parseProjectedResultValue,
  sha256File,
  validateReservedTargets,
  validateValidationReportTarget
} from './contract.mjs';
import { PAPER_EVIDENCE_ID_PATTERN } from '../../plugins/codex-paper/src/shared/package-compatibility.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const pluginScripts = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts');

function includesNormalized(value, phrase) {
  return String(value || '').toLowerCase().includes(String(phrase || '').toLowerCase());
}

function runValidator(script, paperDir, args = []) {
  const result = spawnSync(process.execPath, [path.join(pluginScripts, script), paperDir, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout || '').replaceAll(paperDir, '<temp-paper-dir>'),
    stderr: String(result.stderr || '').replaceAll(paperDir, '<temp-paper-dir>')
  };
}

function claimMatches(actual, expected) {
  return actual.metric === expected.metric
    && Number(actual.value) === Number(expected.value)
    && (!('languagePair' in expected) || actual.languagePair === expected.languagePair)
    && (!('dataset' in expected) || actual.dataset === expected.dataset)
    && (!('table' in expected) || actual.location?.table === expected.table);
}

function collectEvidenceRefs(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node.evidenceRefs)) output.push(...node.evidenceRefs);
  for (const value of Object.values(node)) collectEvidenceRefs(value, output);
  return output;
}

function resultClaimChecks(result, required) {
  const target = required.resultClaims2_1 || {};
  const claims = result.facts.resultClaims || [];
  const ledgerIds = new Set((result.ledger.evidence || []).map((item) => item.id));
  const projection = result.facts.keyResults || [];
  const analysisRefs = collectEvidenceRefs(result.analysis);
  const coreText = JSON.stringify(result.facts.coreClaims || []);
  const analysisText = JSON.stringify({
    oneSentence: result.analysis?.oneSentence,
    problem: result.analysis?.problem,
    coreIdea: result.analysis?.coreIdea,
    contributions: result.analysis?.contributions,
    resultsTable: result.analysis?.resultsTable,
    limitations: result.analysis?.limitations,
    openQuestions: result.analysis?.openQuestions
  });
  return {
    packageVersion2_1: result.meta?.packageVersion === '2.1.0',
    factsVersion2_1: result.facts?.schemaVersion === '2.1.0',
    requiredResultClaims: (target.required || []).every((expected) => claims.some((claim) => claimMatches(claim, expected))),
    forbiddenResultValues: (target.forbiddenValues || []).every((value) => !claims.some((claim) => Number(claim.value) === Number(value))),
    directResultEvidenceRefs: target.requiresDirectEvidenceRefs !== true || claims.every((claim) =>
      Array.isArray(claim.evidenceRefs) && claim.evidenceRefs.length > 0
      && claim.evidenceRefs.every((ref) => PAPER_EVIDENCE_ID_PATTERN.test(ref) && ledgerIds.has(ref))),
    directAnalysisEvidenceRefs: target.requiresDirectEvidenceRefs !== true || (
      analysisRefs.length > 0
      && analysisRefs.every((ref) => PAPER_EVIDENCE_ID_PATTERN.test(ref) && ledgerIds.has(ref))
    ),
    keyResultsProjection: target.requiresKeyResultsProjection !== true || (
      projection.length === claims.length
      && claims.every((claim, index) => parseProjectedResultValue(projection[index]?.value) === Number(claim.value)
        && projection[index]?.label === claim.metric
        && JSON.stringify(projection[index]?.evidenceRefs) === JSON.stringify(claim.evidenceRefs))
    ),
    coreNoiseFiltered: (target.forbiddenCorePhrases || []).every((phrase) => !includesNormalized(coreText, phrase)),
    analysisNoiseFiltered: (target.forbiddenAnalysisPhrases || []).every((phrase) => !includesNormalized(analysisText, phrase))
  };
}

function requiredChecks({ result, gold, license, pdfPath, validators, targetErrors }) {
  const required = gold.requiredAssertions;
  const evidenceText = (result.ledger.evidence || []).map((item) => item.text).join('\n');
  const checks = {
    sourceHash: sha256File(pdfPath) === license.sha256,
    title: result.paperData.title === required.title,
    paperSlug: result.paperSlug === required.paperSlug,
    pageCount: Number(result.paperData.pageCount) === Number(required.pageCount),
    authors: (required.authors || []).every((author) => (result.paperData.authors || []).includes(author)),
    abstractPhrases: (required.abstractPhrases || []).every((phrase) => includesNormalized(result.paperData.abstract, phrase)),
    sectionPhrases: Object.entries(required.sectionPhrases || {}).every(([section, phrases]) =>
      phrases.every((phrase) => includesNormalized(result.paperData.sections?.[section], phrase))),
    evidencePhrases: (required.evidencePhrases || []).every((phrase) => includesNormalized(evidenceText, phrase)),
    parserBackend: result.ledger.quality?.parser === required.parserBackend,
    preparedFiles: ['paper-data.json', 'evidence-ledger.json', 'facts.json', 'analysis.json', 'meta.json', 'paper.pdf', '.codex-paper/paper-identity.json']
      .every((name) => fs.existsSync(path.join(result.paperDir, name))),
    authoringFiles: ['reasoning-analysis.json', 'README.md', 'visual-assets.md', 'summary.md', 'insights.md', 'method.md', 'mental-model.md', 'reflection.md', 'qa.md', 'index.html', 'code/deterministic-contract-probe.py']
      .every((name) => fs.existsSync(path.join(result.paperDir, name))),
    reasoningDraft: validators.reasoningDraft.exitCode === 0,
    studyValidatorStandard: validators.studyStandard.exitCode === 0,
    studyValidatorStrictBlocks: validators.studyStrict.exitCode === 1,
    validationReport1_0: targetErrors.length === 0,
    ...resultClaimChecks(result, required)
  };
  return checks;
}

async function main() {
  const [fixtureId, pdfPath, licensePath, goldPath] = process.argv.slice(2);
  const license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  let executed = false;
  try {
    const { preparePaper } = await import('../../plugins/codex-paper/skills/study/scripts/prepare-paper.js');
    executed = true;
    const result = await preparePaper(pdfPath, { contextMode: 'paper-only', profile: 'empirical', workflow: 'study', language: 'en' });
    writeAuthoringBoundary({ paperDir: result.paperDir, fixtureId, gold, ledger: result.ledger });

    const reasoningDraft = runValidator('validate-reasoning.js', result.paperDir, ['--json']);
    const studyStrict = runValidator('validate-study-package.js', result.paperDir, ['--lang', 'en', '--json', '--strict']);
    const studyStandard = runValidator('validate-study-package.js', result.paperDir, ['--lang', 'en', '--json']);
    let strictReport = null;
    let standardReport = null;
    try { strictReport = JSON.parse(studyStrict.stdout); } catch {}
    try { standardReport = JSON.parse(studyStandard.stdout); } catch {}
    const evidenceText = (result.ledger.evidence || []).map((item) => item.text).join('\n');
    const targetErrors = [
      ...validateReservedTargets(gold, evidenceText),
      ...validateValidationReportTarget(standardReport, gold.requiredAssertions.validationReport1_0, { strictReport })
    ];
    const validators = { reasoningDraft, studyStrict, studyStandard };
    const checks = requiredChecks({ result, gold, license, pdfPath, validators, targetErrors });
    const failedChecks = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    const pass = failedChecks.length === 0;

    process.stdout.write(`${JSON.stringify({
      fixtureId,
      executed,
      completed: true,
      pass,
      checks,
      failedChecks,
      expectedFindingCodes: gold.requiredAssertions.validationReport1_0.expectedFindingCodes,
      observedFindingCodes: (standardReport?.findings || []).map((finding) => finding.code),
      activeContractIds: ['paperIdentity1_0', 'resultClaims2_1', 'validationReport1_0'],
      reservedTargetIds: [],
      packageVersion: result.meta?.packageVersion,
      factsSchemaVersion: result.facts?.schemaVersion,
      resultClaimCount: result.facts?.resultClaims?.length || 0,
      validators: {
        reasoningDraft: reasoningDraft.exitCode,
        studyStrict: studyStrict.exitCode,
        studyStandard: studyStandard.exitCode
      },
      diagnostics: pass ? [] : [
        ...targetErrors,
        ...(reasoningDraft.exitCode === 0 ? [] : [reasoningDraft.stdout || reasoningDraft.stderr]),
        ...(studyStrict.exitCode === 1 ? [] : [studyStrict.stdout || studyStrict.stderr]),
        ...(studyStandard.exitCode === 0 ? [] : [studyStandard.stdout || studyStandard.stderr])
      ].filter(Boolean)
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      fixtureId,
      executed,
      completed: false,
      pass: false,
      error: String(error?.message || error).replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '<local-path>')
    })}\n`);
  }
}

main();
