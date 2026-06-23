import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateReasoningPackage } from '../../plugins/codex-paper/skills/study/scripts/validate-reasoning.js';

const reportPath = process.env.REASONING_BENCHMARK_REPORT_FILE || '/tmp/codex-paper-reasoning-benchmark.json';
const EVIDENCE_ID = 'ev-p001-par-aaaaaaaaaa';

function node(id, statement, sourceType = 'paper_claim', refs = [EVIDENCE_ID]) {
  return {
    id,
    statement,
    sourceType,
    confidence: sourceType === 'speculation' ? 'low' : 'high',
    evidenceRefs: refs
  };
}

function ledger(text = 'The method reports a 3% improvement on the benchmark.') {
  return {
    evidence: [{
      id: EVIDENCE_ID,
      text,
      quote: text,
      location: { page: 1 },
      labels: {}
    }],
    quality: {
      parser: 'pymupdf',
      readingOrder: 'high',
      sectionCoverage: 'high',
      tableExtraction: 'text-only',
      warnings: []
    }
  };
}

function baseReasoning(paperType = 'empirical') {
  const validationKind = paperType === 'theoretical'
    ? 'proof'
    : (paperType === 'survey' ? 'survey_synthesis' : 'experiment');
  return {
    schemaVersion: '2.0.0',
    status: 'complete',
    paperSlug: `${paperType}-fixture`,
    generatedAt: '2026-06-23T00:00:00.000Z',
    contextMode: 'paper-only',
    paperType,
    difficulty: paperType === 'theoretical' ? 'highly_theoretical' : 'advanced',
    evidenceQuality: 'complete_enough',
    centralClaims: [{ ...node('claim-core-01', 'The method reports a 3% improvement on the benchmark.'), scope: 'Reported benchmark only.' }],
    researchQuestion: {
      question: node('rq-01', 'Can the method improve the benchmark?'),
      importance: node('rq-importance-01', 'The question matters for the evaluated setting.', 'inference')
    },
    priorWorkGap: {
      existingApproaches: [node('prior-01', 'The paper compares against existing approaches.')],
      gap: node('gap-01', 'The paper identifies a benchmark gap.'),
      noveltyBoundary: node('novelty-01', 'The novelty is bounded by the reported setting.', 'inference')
    },
    authorReasoningPath: [
      { ...node('reason-01', 'The authors observe a benchmark gap.'), type: 'observation', dependsOn: [], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-02', 'The gap motivates the method.', 'inference'), type: 'hypothesis', dependsOn: ['reason-01'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-03', 'The method is evaluated in the reported setting.'), type: 'validation', dependsOn: ['reason-02'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-04', 'The result supports only the scoped claim.', 'inference'), type: 'boundary', dependsOn: ['reason-03'], supportsClaimIds: ['claim-core-01'] }
    ],
    coreIntuition: {
      ...node('intuition-01', 'The mechanism targets the reported weakness.', 'inference'),
      analogy: 'A focused correction.',
      whyItMayWork: 'It addresses the evidenced gap.',
      whereItMayFail: 'It may fail outside the reported scope.'
    },
    methodModel: {
      inputs: ['input'],
      components: [{ id: 'component-01', name: 'component', purpose: 'test the idea', mechanism: 'minimal mechanism', dependsOn: [], evidenceRefs: [EVIDENCE_ID] }],
      pipeline: ['run method', 'measure result'],
      outputs: ['score'],
      equations: []
    },
    validations: [{
      id: 'validation-01',
      kind: validationKind,
      question: 'Does the support address the claim?',
      design: validationKind === 'proof' ? 'Check proof dependency.' : 'Compare against baseline.',
      observation: 'The paper reports a 3% improvement.',
      conclusion: 'The scoped claim is supported.',
      scope: 'Reported scope only.',
      supportsClaimIds: ['claim-core-01'],
      alternativeExplanation: 'A setup confound could also explain the result.',
      sourceType: 'paper_claim',
      confidence: 'high',
      evidenceRefs: [EVIDENCE_ID]
    }],
    takeaways: [node('takeaway-01', 'Keep the conclusion scoped.', 'inference')],
    weakestAssumption: {
      statement: 'The comparison is fair.',
      targetClaimId: 'claim-core-01',
      whyCritical: 'Unfair comparison would undermine the claim.',
      paperSupport: 'The paper reports the result.',
      missingEvidence: 'Full controls are not present in this fixture.',
      failureConditions: ['Matched controls remove the gain.'],
      observableFailure: 'The 3% improvement disappears.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs: [EVIDENCE_ID]
    },
    minimalReproduction: {
      targetClaimId: 'claim-core-01',
      scope: 'Check the directional effect.',
      data: ['sample'],
      implementation: ['minimal method'],
      baseline: ['baseline'],
      controls: ['same budget'],
      metrics: ['score'],
      supportCriteria: ['Positive direction under controls.'],
      falsificationCriteria: ['Gain disappears under controls.'],
      artifacts: ['code/core-concept-demo.py'],
      knownGaps: ['toy fixture'],
      evidenceRefs: [EVIDENCE_ID]
    },
    strongestCounterexample: {
      targetClaimId: 'claim-core-01',
      attackType: 'control_mismatch',
      setup: 'Equalize controls.',
      controlledVariables: ['budget'],
      predictedObservation: 'The 3% improvement disappears.',
      whyStrong: 'It directly attacks the benchmark claim.',
      alternativeExplanation: 'The gain may come from setup differences.',
      interpretation: 'Narrow the claim to the original setup.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs: [EVIDENCE_ID]
    },
    followUpIdea: {
      motivation: 'The scope is narrow.',
      adjacentField: 'causal evaluation',
      novelFraming: 'Evaluate attribution instead of only final score.',
      firstExperiment: 'Run matched-control counterfactual comparisons.',
      successSignal: 'The effect remains after matching.',
      failureSignal: 'The effect disappears after matching.',
      whyNonIncremental: 'It changes the evaluation question.',
      existingWorkBoundary: 'paper-only mode cannot confirm nearby work.',
      sourceType: 'speculation',
      confidence: 'low',
      evidenceRefs: []
    },
    limitations: [node('limitation-01', 'The result is scoped to the benchmark.', 'inference')],
    uncertaintyZones: [{ topic: 'controls', reason: 'fixture is short', impact: 'limits causal confidence', neededEvidence: 'full setup', evidenceRefs: [EVIDENCE_ID] }]
  };
}

function makePackage(reasoning) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-reasoning-bench-'));
  fs.writeFileSync(path.join(dir, 'evidence-ledger.json'), JSON.stringify(ledger(), null, 2));
  fs.writeFileSync(path.join(dir, 'reasoning-analysis.json'), JSON.stringify(reasoning, null, 2));
  return dir;
}

const fixtures = [
  { name: 'valid-empirical', reasoning: baseReasoning('empirical'), expect: { status: 'pass' } },
  { name: 'valid-theoretical', reasoning: baseReasoning('theoretical'), expect: { status: 'pass' } },
  { name: 'valid-survey', reasoning: baseReasoning('survey'), expect: { status: 'pass' } },
  { name: 'missing-evidence-ref', mutate: (r) => { r.centralClaims[0].evidenceRefs = ['ev-p999-par-bbbbbbbbbb']; }, expectCode: 'EVIDENCE_REF_NOT_FOUND' },
  { name: 'literature-in-paper-only', mutate: (r) => { r.centralClaims[0].sourceType = 'literature_fact'; }, expectCode: 'LITERATURE_FACT_WITHOUT_EXTERNAL_EVIDENCE' },
  { name: 'speculation-high', mutate: (r) => { r.followUpIdea.confidence = 'high'; }, expectCode: 'SPECULATION_MARKED_HIGH_CONFIDENCE' },
  { name: 'dag-cycle', mutate: (r) => { r.authorReasoningPath[0].dependsOn = ['reason-04']; }, expectCode: 'REASONING_PATH_CYCLE' },
  { name: 'numeric-mismatch', mutate: (r) => { r.validations[0].observation = 'The paper reports a 9% improvement.'; }, expectCode: 'NUMERIC_CLAIM_WITHOUT_MATCHING_EVIDENCE' },
  { name: 'min-repro-no-falsification', mutate: (r) => { r.minimalReproduction.falsificationCriteria = []; }, expectCode: 'MIN_REPRO_WITHOUT_FALSIFICATION_CRITERIA' },
  { name: 'counterexample-no-target', mutate: (r) => { r.strongestCounterexample.targetClaimId = 'missing'; }, expectCode: 'COUNTEREXAMPLE_WITHOUT_TARGET_CLAIM' },
  { name: 'followup-incremental', mutate: (r) => { r.followUpIdea.whyNonIncremental = 'Use more data and a larger model.'; }, expectCode: 'FOLLOWUP_MAY_BE_INCREMENTAL', strict: true },
  { name: 'template-residue', mutate: (r) => { r.coreIntuition.statement = 'TODO fill me'; }, expectCode: 'TEMPLATE_RESIDUE_FOUND' }
];

const results = [];
for (const fixture of fixtures) {
  const reasoning = fixture.reasoning || baseReasoning('empirical');
  fixture.mutate?.(reasoning);
  const dir = makePackage(reasoning);
  try {
    const result = validateReasoningPackage(dir, { strict: fixture.strict });
    const codes = result.report.errors.map((error) => error.code);
    const pass = fixture.expect?.status === 'pass'
      ? result.report.status === 'pass'
      : codes.includes(fixture.expectCode);
    results.push({ name: fixture.name, pass, status: result.report.status, expected: fixture.expectCode || fixture.expect?.status, codes });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const totals = {
  fixtures: results.length,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length
};
const report = { generatedAt: new Date().toISOString(), totals, results };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`Reasoning benchmark report: ${reportPath}`);
console.log(`Passed: ${totals.passed}/${totals.fixtures}`);
for (const result of results) {
  console.log(`- ${result.name}: ${result.pass ? 'PASS' : 'FAIL'}${result.expected ? ` expected=${result.expected}` : ''}`);
  if (!result.pass) console.log(`  codes=${result.codes.join(', ')}`);
}

process.exit(totals.failed === 0 ? 0 : 1);
