import { writeWorkspaceAuthoring } from '../../plugins/codex-paper/src/shared/generation-workspace.mjs';

async function write(workspace, relativePath, content) {
  return writeWorkspaceAuthoring(workspace, relativePath, content, { expectAbsent: true });
}

async function writeJson(workspace, relativePath, value) {
  return write(workspace, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveEvidenceRefs(ledger, selectors) {
  return selectors.map((selector) => {
    const matches = (ledger.evidence || []).filter((item) => String(item.text || '').includes(selector));
    if (matches.length !== 1) {
      throw new Error(`Evidence selector must match exactly once: ${JSON.stringify(selector)} matched ${matches.length}`);
    }
    return matches[0].id;
  });
}

function buildReasoning({ fixtureId, gold, evidenceRefs }) {
  const statement = gold.authoring.summary;
  const conflict = gold.authoring.visibleConflict;
  const observation = conflict ? `${statement} ${conflict}` : statement;
  const node = (id, text, sourceType = 'paper_claim') => ({
    id,
    statement: text,
    sourceType,
    confidence: sourceType === 'speculation' ? 'low' : sourceType === 'inference' ? 'medium' : 'high',
    evidenceRefs
  });

  return {
    schemaVersion: '2.0.0',
    status: 'complete',
    paperSlug: gold.requiredAssertions.paperSlug,
    generatedAt: '2026-07-13T00:00:00.000Z',
    contextMode: 'paper-only',
    paperType: 'empirical',
    difficulty: 'advanced',
    evidenceQuality: 'complete_enough',
    centralClaims: [{
      ...node('claim-core-01', statement),
      scope: 'The claims apply only to this deterministic synthetic fixture.'
    }],
    researchQuestion: {
      question: node('rq-01', 'Can the synthetic method support the reported translation result?'),
      importance: node('rq-importance-01', 'The fixture tests whether evidence-backed numerical claims remain stable.', 'inference')
    },
    priorWorkGap: {
      existingApproaches: [node('prior-01', 'The fixture describes a controlled translation comparison.')],
      gap: node('gap-01', 'Unstructured extraction can confuse years with result values.', 'inference'),
      noveltyBoundary: node('novelty-01', 'This is a regression fixture rather than a scientific novelty claim.', 'inference')
    },
    authorReasoningPath: [
      { ...node('reason-01', 'The paper states a controlled translation question.'), type: 'observation', dependsOn: [], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-02', 'The reported metric is used as the validation signal.', 'inference'), type: 'hypothesis', dependsOn: ['reason-01'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-03', observation), type: 'validation', dependsOn: ['reason-02'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-04', 'The conclusion must remain bounded by the cited synthetic evidence.', 'inference'), type: 'boundary', dependsOn: ['reason-03'], supportsClaimIds: ['claim-core-01'] }
    ],
    coreIntuition: {
      ...node('intuition-01', 'Bind the result statement to the evidence that contains the metric.', 'inference'),
      analogy: 'A typed label attached to one measured value',
      whyItMayWork: 'The metric and value remain adjacent in the cited evidence.',
      whereItMayFail: 'The current heuristic can select unrelated years.'
    },
    methodModel: {
      inputs: ['synthetic translation text'],
      components: [{ id: 'component-01', name: 'result binding', purpose: 'preserve the reported metric', mechanism: 'evidence-backed selection', dependsOn: [], evidenceRefs }],
      pipeline: ['read the source', 'locate the metric', 'preserve the evidence boundary'],
      outputs: ['a scoped numerical claim'],
      equations: []
    },
    validations: [{
      id: 'validation-01',
      kind: 'benchmark',
      question: 'Does the authored boundary preserve the supported result?',
      design: 'Compare the authored claim with the cited page-one evidence.',
      observation,
      conclusion: 'The authored boundary uses the source-supported result and discloses any conflict.',
      scope: 'This one-page synthetic fixture.',
      supportsClaimIds: ['claim-core-01'],
      alternativeExplanation: 'A heuristic could select a nearby year or conflicting prose value.',
      sourceType: 'paper_claim',
      confidence: 'high',
      evidenceRefs
    }],
    takeaways: [node('takeaway-01', 'Keep numerical conclusions tied to their source evidence.', 'inference')],
    weakestAssumption: {
      statement: 'The selected evidence is the intended result-bearing passage.',
      targetClaimId: 'claim-core-01',
      whyCritical: 'A wrong passage can turn a year into a metric value.',
      paperSupport: observation,
      missingEvidence: 'The synthetic fixture does not model complex layouts.',
      failureConditions: ['The selected value is not adjacent to the intended metric.'],
      observableFailure: 'A year replaces the BLEU score.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs
    },
    minimalReproduction: {
      targetClaimId: 'claim-core-01',
      scope: `Deterministic fixture ${fixtureId}`,
      data: ['the committed synthetic PDF'],
      implementation: ['run the bounded prepare pipeline'],
      baseline: ['the frozen P0-B1 expected finding contract'],
      controls: ['fixed PDF bytes', 'fixed authoring boundary'],
      metrics: ['required assertions', 'expected findings'],
      supportCriteria: ['all required assertions pass'],
      falsificationCriteria: ['a required expected finding is not observed'],
      artifacts: ['code/deterministic-contract-probe.py'],
      knownGaps: ['advanced layout parsing is excluded'],
      evidenceRefs
    },
    strongestCounterexample: {
      targetClaimId: 'claim-core-01',
      attackType: 'wrong_numeric_binding',
      setup: 'Select the first number in a result-bearing sentence.',
      controlledVariables: ['source bytes', 'metric wording'],
      predictedObservation: 'A dataset or publication year is selected instead of the BLEU score.',
      whyStrong: 'It reproduces the audited failure mode directly.',
      alternativeExplanation: 'Reading order may also contribute to contamination.',
      interpretation: 'Narrow the claim and require direct evidence binding.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs
    },
    followUpIdea: {
      motivation: 'The current fixture freezes a defect before its typed replacement exists.',
      adjacentField: 'schema-driven extraction',
      novelFraming: 'Treat numerical extraction as an evidence-linked typed claim.',
      firstExperiment: 'Migrate the expected defect to a ResultClaim assertion in P0-B2.',
      successSignal: 'The correct metric value passes while year values are rejected.',
      failureSignal: 'The extractor still selects an unrelated number.',
      whyNonIncremental: 'It changes the output contract from a loose value to a typed evidence relation.',
      existingWorkBoundary: 'P0-B1 only reserves the future target.',
      sourceType: 'speculation',
      confidence: 'low',
      evidenceRefs
    },
    limitations: [node('limitation-01', 'The fixture intentionally excludes multi-column and table-grid reconstruction.', 'inference')],
    uncertaintyZones: [
      {
        topic: 'layout generalization',
        reason: 'The fixture has a simple one-page layout.',
        impact: 'It cannot calibrate advanced reading order.',
        neededEvidence: 'Dedicated P1-1 layout fixtures.',
        evidenceRefs
      },
      ...(conflict ? [{
        topic: 'result value conflict',
        reason: conflict,
        impact: 'The 41.8 and 41.0 BLEU values remain inconsistent until the source discrepancy is resolved.',
        neededEvidence: 'An authoritative correction or table provenance that resolves the conflict.',
        evidenceRefs
      }] : [])
    ]
  };
}

function buildQa(primaryResult, conflict) {
  const conflictAnswer = conflict || 'No source conflict is present in this fixture.';
  return `# Q&A

## Basic
### 1. What is the central result?
The central result is ${primaryResult}. [paper p.1]
### 2. Why is the fixture deterministic?
Its PDF bytes and authored boundary are fixed.
### 3. What is the source boundary?
Only the committed synthetic PDF is used.
### 4. Which file should be read first?
Read the summary first.
### 5. Is model generation involved?
No model-generated material is part of this gate.

## Intermediate
### 6. Reconstruct the author reasoning path.
Read the claim, identify the metric, inspect the evidence, and keep the conclusion scoped.
### 7. Distinguish paper claim and analysis inference.
The reported value is a paper claim; the extraction-risk explanation is an analysis inference.
### 8. What is the weakest assumption?
The selected passage is the intended result-bearing evidence.
### 9. What is the falsification test?
Show that the selected number is unrelated to the metric.
### 10. What evidence supports the result?
The page-one sentence containing the metric and value supports it.

## Advanced
### 11. Does the conclusion exceed the evidence boundary?
No, it remains limited to the synthetic fixture.
### 12. What is the strongest counterexample?
A first-number heuristic selects a year rather than the score.
### 13. What is the disclosed conflict?
${conflictAnswer}
### 14. Why is the follow-up non-incremental?
It changes the result representation to a typed evidence relation.
### 15. What uncertainty remains?
Advanced layout behavior remains outside this fixture.
`;
}

export async function writeAuthoringBoundary({ paperDir, fixtureId, gold, ledger }) {
  const selectors = gold.authoring.supportingEvidenceSelectors || [gold.authoring.primaryEvidenceSelector];
  const evidenceRefs = resolveEvidenceRefs(ledger, selectors);
  const reasoning = buildReasoning({ fixtureId, gold, evidenceRefs });
  const primary = gold.authoring.primaryResult;
  const conflict = gold.authoring.visibleConflict;
  const conflictParagraph = conflict ? `\n\n${conflict} [paper p.1]` : '';

  await writeJson(paperDir, 'reasoning-analysis.json', reasoning);
  await write(paperDir, 'README.md', `# ${gold.requiredAssertions.title}\n\nThis deterministic package verifies the PDF-to-validation path. The primary result is ${primary}. [paper p.1]\n\nRead the summary, method, reflection, and Q&A in order.\n`);
  await write(paperDir, 'visual-assets.md', '# Visual Assets\n\nNo useful high-value visual assets are present in this deliberately text-only synthetic fixture. The package uses a deterministic method diagram and table instead of paper figures.\n');
  await write(paperDir, 'summary.md', `# Summary\n\n${gold.authoring.summary} [paper p.1]${conflictParagraph}\n\nThe conclusion is limited to the one-page synthetic benchmark.\n`);
  await write(paperDir, 'insights.md', `# Insights\n\nThe paper claim is ${primary}. [paper p.1]\n\nAs an analysis inference, a first-number heuristic can confuse a year with the intended metric value.\n`);
  await write(paperDir, 'method.md', `# Method\n\nThe pipeline reads the fixed PDF, locates the result-bearing evidence, and preserves the scoped claim.\n\n| Stage | Purpose |\n|---|---|\n| Source | Fixed synthetic PDF |\n| Evidence | Locate the metric and value |\n| Boundary | Author the scoped conclusion |\n\n## Minimal Reproduction\n\nSupport criteria: ${primary} remains attached to its page-one evidence. [paper p.1]\n\nFalsification criteria: a year or unrelated value replaces the metric result.\n`);
  await write(paperDir, 'mental-model.md', '# Mental Model\n\nTreat each result as a link between a scoped statement, a metric value, and a source passage. The regression gate observes current defects without silently claiming they are fixed.\n');
  await write(paperDir, 'reflection.md', `# Reflection\n\n## 最弱假设\nThe selected source passage is the intended result-bearing evidence.\n\n## 最强反例\nA first-number heuristic selects a nearby year instead of ${primary}.\n\n## 非增量后续研究\nReplace loose result values with typed evidence-linked claims rather than tuning the same heuristic.\n`);
  await write(paperDir, 'qa.md', buildQa(primary, conflict));
  await write(paperDir, 'index.html', '<!doctype html><html><body><h1>Method dashboard</h1><button type="button" onclick="document.getElementById(\'view\').textContent=\'Paper claims, analysis inferences, research speculations, weakest assumption, strongest counterexample\';">Toggle evidence audit</button><p id="view">Paper claims. Analysis inferences. Research speculations. Weakest assumption. Strongest counterexample.</p><script>function fixtureToggle(){return true}</script></body></html>');
  await write(paperDir, 'code/deterministic-contract-probe.py', 'print("deterministic contract fixture; execution is not part of validation")\n');

  return { evidenceRefs, reasoning };
}
