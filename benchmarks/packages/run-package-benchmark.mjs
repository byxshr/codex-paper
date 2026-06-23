import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const validatorPath = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts/validate-study-package.js');
const reportPath = process.env.PACKAGE_BENCHMARK_REPORT_FILE || '/tmp/codex-paper-package-benchmark.json';
const EVIDENCE_ID = 'ev-p001-par-aaaaaaaaaa';

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function qaText() {
  return `# Q&A

## Basic
### 1. What is the paper's central claim?
The paper claim is scoped to the benchmark.
### 2. What problem motivates the method?
The benchmark gap motivates it.
### 3. What does the main number mean?
It reports a 3% improvement.
### 4. Which file should you read first?
Read the summary first.
### 5. What is the main boundary?
The result is benchmark-scoped.

## Intermediate
### 6. Reconstruct the author reasoning path.
Observation, design, validation, boundary.
### 7. Distinguish paper claim and analysis inference.
The 3% result is a paper claim; the causal interpretation is an analysis inference.
### 8. Explain the weakest assumption.
The weakest assumption is fair comparison.
### 9. Design a falsification test.
Equalize controls and check whether the gain disappears.
### 10. What evidence supports the result?
The result line in the paper supports it.

## Advanced
### 11. Does the conclusion go beyond the evidence boundary?
No, it stays in the reported benchmark scope.
### 12. What is the strongest counterexample?
An equal-control baseline that removes the gain.
### 13. What is non-incremental about the follow-up?
It changes attribution, not scale.
### 14. What uncertainty remains?
Control details remain uncertain.
### 15. What would change your confidence?
Full setup evidence and repeated runs.
`;
}

function reasoning() {
  const node = (id, statement, sourceType = 'paper_claim', refs = [EVIDENCE_ID]) => ({
    id,
    statement,
    sourceType,
    confidence: sourceType === 'speculation' ? 'low' : 'high',
    evidenceRefs: refs
  });
  return {
    schemaVersion: '2.0.0',
    status: 'complete',
    paperSlug: 'package-fixture',
    generatedAt: '2026-06-23T00:00:00.000Z',
    contextMode: 'paper-only',
    paperType: 'empirical',
    difficulty: 'advanced',
    evidenceQuality: 'complete_enough',
    centralClaims: [{ ...node('claim-core-01', 'The paper reports a 3% improvement on the benchmark.'), scope: 'Reported benchmark only.' }],
    researchQuestion: { question: node('rq-01', 'Can the method improve the benchmark?'), importance: node('rq-importance-01', 'The benchmark question is important.', 'inference') },
    priorWorkGap: { existingApproaches: [node('prior-01', 'The paper compares prior approaches.')], gap: node('gap-01', 'A benchmark gap remains.'), noveltyBoundary: node('novelty-01', 'The novelty is benchmark-scoped.', 'inference') },
    authorReasoningPath: [
      { ...node('reason-01', 'The authors observe a benchmark gap.'), type: 'observation', dependsOn: [], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-02', 'The gap motivates the method.', 'inference'), type: 'hypothesis', dependsOn: ['reason-01'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-03', 'The method is evaluated on the benchmark.'), type: 'validation', dependsOn: ['reason-02'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-04', 'The result supports the scoped claim.', 'inference'), type: 'boundary', dependsOn: ['reason-03'], supportsClaimIds: ['claim-core-01'] }
    ],
    coreIntuition: { ...node('intuition-01', 'The mechanism targets the observed gap.', 'inference'), analogy: 'focused correction', whyItMayWork: 'It addresses the evidenced gap.', whereItMayFail: 'outside the benchmark' },
    methodModel: { inputs: ['input'], components: [{ id: 'component-01', name: 'component', purpose: 'test idea', mechanism: 'minimal', dependsOn: [], evidenceRefs: [EVIDENCE_ID] }], pipeline: ['run', 'measure'], outputs: ['score'], equations: [] },
    validations: [{ id: 'validation-01', kind: 'experiment', question: 'Does it improve?', design: 'Compare to baseline.', observation: 'The paper reports a 3% improvement.', conclusion: 'The scoped claim is supported.', scope: 'reported benchmark', supportsClaimIds: ['claim-core-01'], alternativeExplanation: 'setup confound', sourceType: 'paper_claim', confidence: 'high', evidenceRefs: [EVIDENCE_ID] }],
    takeaways: [node('takeaway-01', 'Keep the claim scoped.', 'inference')],
    weakestAssumption: { statement: 'The comparison is fair.', targetClaimId: 'claim-core-01', whyCritical: 'Fairness controls attribution.', paperSupport: 'The result is reported.', missingEvidence: 'Full controls are absent.', failureConditions: ['Matched controls remove gain.'], observableFailure: 'The 3% improvement disappears.', sourceType: 'inference', confidence: 'medium', evidenceRefs: [EVIDENCE_ID] },
    minimalReproduction: { targetClaimId: 'claim-core-01', scope: 'directional check', data: ['sample'], implementation: ['minimal method'], baseline: ['baseline'], controls: ['same budget'], metrics: ['score'], supportCriteria: ['positive direction'], falsificationCriteria: ['gain disappears'], artifacts: ['code/core-concept-demo.py'], knownGaps: ['toy'], evidenceRefs: [EVIDENCE_ID] },
    strongestCounterexample: { targetClaimId: 'claim-core-01', attackType: 'control_mismatch', setup: 'Equalize controls.', controlledVariables: ['budget'], predictedObservation: 'The 3% improvement disappears.', whyStrong: 'It attacks the core claim.', alternativeExplanation: 'setup differences', interpretation: 'narrow the claim', sourceType: 'inference', confidence: 'medium', evidenceRefs: [EVIDENCE_ID] },
    followUpIdea: { motivation: 'scope is narrow', adjacentField: 'causal evaluation', novelFraming: 'evaluate attribution', firstExperiment: 'matched controls', successSignal: 'effect remains', failureSignal: 'effect disappears', whyNonIncremental: 'changes the evaluation question', existingWorkBoundary: 'paper-only unknown', sourceType: 'speculation', confidence: 'low', evidenceRefs: [] },
    limitations: [node('limitation-01', 'The result is scoped.', 'inference')],
    uncertaintyZones: [{ topic: 'controls', reason: 'short fixture', impact: 'limits attribution', neededEvidence: 'full setup', evidenceRefs: [EVIDENCE_ID] }]
  };
}

function createV2Package() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-package-bench-'));
  writeJson(path.join(dir, 'meta.json'), { slug: 'package-fixture', packageVersion: '2.0.0', learningArtifacts: [{ type: 'code', path: 'code/core-concept-demo.py', runCommand: 'python3 core-concept-demo.py', purpose: 'minimal behavior' }] });
  writeJson(path.join(dir, 'evidence-ledger.json'), { evidence: [{ id: EVIDENCE_ID, text: 'The method reports a 3% improvement on the benchmark.', quote: 'The method reports a 3% improvement on the benchmark.' }], quality: { parser: 'pymupdf', readingOrder: 'high', sectionCoverage: 'high', tableExtraction: 'text-only', warnings: [] } });
  writeJson(path.join(dir, 'reasoning-analysis.json'), reasoning());
  write(path.join(dir, 'paper.pdf'), 'pdf fixture');
  write(path.join(dir, 'README.md'), '# Package Fixture\n\nEmpirical paper, advanced difficulty, complete enough evidence. Read summary first. The main conclusion is scoped to the reported benchmark. Minimal reproduction starts in `code/core-concept-demo.py`.\n');
  write(path.join(dir, 'visual-assets.md'), '# Visual Assets\n\nNo useful high-value visual assets were available in this synthetic fixture, so the package uses text and a small interactive method explorer instead of paper figures.\n');
  write(path.join(dir, 'summary.md'), '# Summary\n\nThe paper asks whether the method improves the benchmark. It reports a 3% improvement, scoped to the reported benchmark setting. [paper p.1]\n\nThe validation chain is question, design, observation, and conclusion: compare to the baseline, observe the reported improvement, and keep the conclusion scoped.\n');
  write(path.join(dir, 'insights.md'), '# Insights\n\nThe core intuition is a focused correction. As an analysis inference, the gain may reflect the mechanism only if controls are fair. [paper p.1]\n');
  write(path.join(dir, 'method.md'), '# Method\n\nInputs, component, pipeline, and output are represented by the small demo.\n\n## Minimal Reproduction\n\nSupport criteria: the direction remains positive under matched controls.\n\nFalsification criteria: the gain disappears under matched controls.\n');
  write(path.join(dir, 'mental-model.md'), '# Mental Model\n\nThe author reasoning path is observation, design hypothesis, validation, and scoped boundary.\n');
  write(path.join(dir, 'reflection.md'), '# Reflection\n\n## 最弱假设\nThe comparison is fair.\n\n## 最强反例\nAn equal-control baseline removes the gain.\n\n## 非增量后续研究\nReframe evaluation around attribution rather than score chasing.\n');
  write(path.join(dir, 'qa.md'), qaText());
  write(path.join(dir, 'index.html'), '<!doctype html><html><body><h1>Method dashboard</h1><button onclick="document.getElementById(\'view\').textContent=\'Paper claims, analysis inferences, research speculations, weakest assumption, strongest counterexample\';">Toggle evidence audit</button><p id="view">Paper claims. Analysis inferences. Research speculations. Weakest assumption. Strongest counterexample.</p><script>function noop(){return true}</script></body></html>');
  write(path.join(dir, 'code/core-concept-demo.py'), 'print("core concept demo ok")\n');
  return dir;
}

function createV1Package() {
  const dir = createV2Package();
  fs.rmSync(path.join(dir, 'meta.json'), { force: true });
  fs.rmSync(path.join(dir, 'evidence-ledger.json'), { force: true });
  fs.rmSync(path.join(dir, 'reasoning-analysis.json'), { force: true });
  return dir;
}

function runValidator(dir, args = ['--run-code']) {
  const result = spawnSync(process.execPath, [validatorPath, dir, ...args], {
    encoding: 'utf8'
  });
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`
  };
}

const fixtures = [
  { name: 'valid-v2-package', make: createV2Package, expectPass: true },
  { name: 'legacy-v1-ok', make: createV1Package, args: ['--legacy-ok', '--run-code'], expectPass: true },
  { name: 'missing-reflection-heading', make: createV2Package, mutate: (dir) => write(path.join(dir, 'reflection.md'), '# Reflection\n\n## 最弱假设\nOnly one section.\n'), expectText: 'reflection.md is missing required v2 heading' },
  { name: 'method-no-falsification', make: createV2Package, mutate: (dir) => write(path.join(dir, 'method.md'), '# Method\n\nSupport criteria: positive direction.\n'), expectText: 'method.md must include minimal reproduction falsification criteria' },
  { name: 'visible-leaks-evidenceRefs', make: createV2Package, mutate: (dir) => fs.appendFileSync(path.join(dir, 'summary.md'), '\nevidenceRefs leak\n'), expectText: 'contains machine residue' },
  { name: 'natural-result-phrase-ok', make: createV2Package, mutate: (dir) => fs.appendFileSync(path.join(dir, 'README.md'), '\nResult 1 is a natural experiment label. See evidence in Figure 2 for the supporting discussion.\n'), expectPass: true },
  { name: 'markdown-json-example-ok', make: createV2Package, mutate: (dir) => fs.appendFileSync(path.join(dir, 'README.md'), '\n```json\n{\"example\": true}\n```\n'), expectPass: true },
  { name: 'numeric-without-location', make: createV2Package, mutate: (dir) => write(path.join(dir, 'summary.md'), '# Summary\n\nThe method reports a 3% improvement on the benchmark.\n'), expectText: 'numeric conclusion without a natural paper location' },
  { name: 'v2-missing-reasoning', make: createV2Package, mutate: (dir) => fs.rmSync(path.join(dir, 'reasoning-analysis.json')), expectText: 'REASONING_FILE_MISSING' },
  { name: 'html-no-interaction', make: createV2Package, mutate: (dir) => write(path.join(dir, 'index.html'), '<html><body><h1>Method overview</h1><p>Paper claims. Inferences. Speculations. Weakest assumption. Counterexample.</p></body></html>'), expectText: 'index.html has no visible interactive control' }
];

const results = [];
for (const fixture of fixtures) {
  const dir = fixture.make();
  try {
    fixture.mutate?.(dir);
    const result = runValidator(dir, fixture.args);
    const pass = fixture.expectPass ? result.status === 0 : result.status !== 0 && result.output.includes(fixture.expectText);
    results.push({ name: fixture.name, pass, exitCode: result.status, expected: fixture.expectPass ? 'PASS' : fixture.expectText });
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

console.log(`Package benchmark report: ${reportPath}`);
console.log(`Passed: ${totals.passed}/${totals.fixtures}`);
for (const result of results) {
  console.log(`- ${result.name}: ${result.pass ? 'PASS' : 'FAIL'} expected=${result.expected}`);
}

process.exit(totals.failed === 0 ? 0 : 1);
