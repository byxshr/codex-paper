import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateReasoningPackage } from '../validate-reasoning.js';

const EVIDENCE_ID = 'ev-p001-par-aaaaaaaaaa';

function makeLedger() {
  return {
    schemaVersion: '2.0.0',
    paperSlug: 'valid-paper',
    parserVersion: '2.0.0',
    generatedAt: '2026-06-23T00:00:00.000Z',
    document: {
      title: 'Valid Paper',
      authors: ['A. Author'],
      pageCount: 1,
      language: 'en',
      sourceUrl: null,
      sha256: 'abc'
    },
    sections: [],
    pages: [{
      page: 1,
      text: 'The method reports a 3% improvement on the benchmark.',
      rawTextStart: 0,
      rawTextEnd: 56,
      blockCount: 1
    }],
    evidence: [{
      id: EVIDENCE_ID,
      kind: 'paragraph',
      roles: ['claim_candidate', 'result'],
      text: 'The method reports a 3% improvement on the benchmark.',
      quote: 'The method reports a 3% improvement on the benchmark.',
      location: {
        page: 1,
        sectionId: null,
        charStart: 0,
        charEnd: 56,
        blockIndex: null,
        bbox: null
      },
      labels: {
        figureNumber: null,
        tableNumber: null,
        equationNumber: null
      },
      source: 'paper',
      confidence: 'high'
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

function node(id, statement, sourceType = 'paper_claim') {
  return {
    id,
    statement,
    sourceType,
    confidence: sourceType === 'speculation' ? 'low' : 'high',
    evidenceRefs: sourceType === 'speculation' ? [] : [EVIDENCE_ID]
  };
}

function makeReasoning(overrides = {}) {
  const reasoning = {
    schemaVersion: '2.0.0',
    status: 'complete',
    paperSlug: 'valid-paper',
    generatedAt: '2026-06-23T00:00:00.000Z',
    contextMode: 'paper-only',
    paperType: 'empirical',
    difficulty: 'advanced',
    evidenceQuality: 'complete_enough',
    centralClaims: [{
      ...node('claim-core-01', 'The method reports a 3% improvement on the benchmark.'),
      scope: 'Within the benchmark setting reported by the paper.'
    }],
    researchQuestion: {
      question: node('rq-01', 'Can the method improve the benchmark result?'),
      importance: node('rq-importance-01', 'The result matters because it tests the target benchmark.', 'inference')
    },
    priorWorkGap: {
      existingApproaches: [node('prior-01', 'The paper compares against existing approaches.')],
      gap: node('gap-01', 'Existing approaches leave room on this benchmark.'),
      noveltyBoundary: node('novelty-01', 'The novelty boundary is the reported method within this benchmark.', 'inference')
    },
    authorReasoningPath: [
      { ...node('reason-01', 'The authors observe a benchmark gap.'), type: 'observation', dependsOn: [], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-02', 'The gap motivates the method design.', 'inference'), type: 'hypothesis', dependsOn: ['reason-01'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-03', 'The method is evaluated against the benchmark.'), type: 'validation', dependsOn: ['reason-02'], supportsClaimIds: ['claim-core-01'] },
      { ...node('reason-04', 'The reported observation supports the scoped claim.'), type: 'boundary', dependsOn: ['reason-03'], supportsClaimIds: ['claim-core-01'] }
    ],
    coreIntuition: {
      ...node('intuition-01', 'The mechanism may help by targeting the benchmark weakness.', 'inference'),
      analogy: 'A focused correction rather than a broad replacement.',
      whyItMayWork: 'It addresses the evidenced benchmark gap.',
      whereItMayFail: 'It may fail outside the reported benchmark.'
    },
    methodModel: {
      inputs: ['Benchmark input'],
      components: [{
        id: 'component-01',
        name: 'Core method',
        purpose: 'Improve the benchmark result',
        mechanism: 'Apply the paper method',
        dependsOn: [],
        evidenceRefs: [EVIDENCE_ID]
      }],
      pipeline: ['Run the method', 'Compare the metric'],
      outputs: ['Benchmark score'],
      equations: []
    },
    validations: [{
      id: 'validation-01',
      kind: 'experiment',
      question: 'Does the method improve the benchmark?',
      design: 'Compare against the benchmark baseline.',
      observation: 'The paper reports a 3% improvement.',
      conclusion: 'The scoped claim is supported in the reported setting.',
      scope: 'Reported benchmark only.',
      supportsClaimIds: ['claim-core-01'],
      alternativeExplanation: 'A hidden baseline mismatch could also explain the gain.',
      sourceType: 'paper_claim',
      confidence: 'high',
      evidenceRefs: [EVIDENCE_ID]
    }],
    takeaways: [node('takeaway-01', 'The claim should stay scoped to the benchmark.', 'inference')],
    weakestAssumption: {
      statement: 'The comparison budget is fair.',
      targetClaimId: 'claim-core-01',
      whyCritical: 'If unfair, the gain may not come from the method.',
      paperSupport: 'The evidence reports the benchmark result.',
      missingEvidence: 'The fixture does not include all budget details.',
      failureConditions: ['Equalized budget removes the gain.'],
      observableFailure: 'The 3% improvement disappears under equalized controls.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs: [EVIDENCE_ID]
    },
    minimalReproduction: {
      targetClaimId: 'claim-core-01',
      scope: 'Reproduce the benchmark direction, not full system quality.',
      data: ['Benchmark sample'],
      implementation: ['Implement the method'],
      baseline: ['Reported baseline'],
      controls: ['Same budget'],
      metrics: ['Benchmark score'],
      supportCriteria: ['Improvement remains positive across repeated runs.'],
      falsificationCriteria: ['Improvement vanishes after equalizing controls.'],
      artifacts: ['code/core-concept-demo.py'],
      knownGaps: ['Fixture does not include real training code.'],
      evidenceRefs: [EVIDENCE_ID]
    },
    strongestCounterexample: {
      targetClaimId: 'claim-core-01',
      attackType: 'control_mismatch',
      setup: 'Equalize all comparison controls.',
      controlledVariables: ['Budget', 'data', 'metric'],
      predictedObservation: 'The 3% gain should disappear if the mechanism is not causal.',
      whyStrong: 'It attacks the core benchmark claim directly.',
      alternativeExplanation: 'The reported gain might reflect setup differences.',
      interpretation: 'If true, narrow the claim to the original setup.',
      sourceType: 'inference',
      confidence: 'medium',
      evidenceRefs: [EVIDENCE_ID]
    },
    followUpIdea: {
      motivation: 'The limitation is the narrow benchmark setting.',
      adjacentField: 'causal evaluation',
      novelFraming: 'Turn the evaluation into a controlled causal attribution test.',
      firstExperiment: 'Run matched-control counterfactual comparisons.',
      successSignal: 'The mechanism remains positive after control matching.',
      failureSignal: 'The gain disappears after control matching.',
      whyNonIncremental: 'It changes the evaluation question from score chasing to attribution.',
      existingWorkBoundary: 'paper-only mode cannot confirm nearby work.',
      sourceType: 'speculation',
      confidence: 'low',
      evidenceRefs: []
    },
    limitations: [node('limitation-01', 'The evidence is limited to the benchmark setting.', 'inference')],
    uncertaintyZones: [{
      topic: 'Control details',
      reason: 'The fixture only contains a short evidence line.',
      impact: 'It limits confidence in the causal explanation.',
      neededEvidence: 'Full experiment setup.',
      evidenceRefs: [EVIDENCE_ID]
    }]
  };

  return {
    ...reasoning,
    ...overrides
  };
}

function writePackage(reasoning, externalEvidence = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-reasoning-test-'));
  fs.writeFileSync(path.join(dir, 'evidence-ledger.json'), `${JSON.stringify(makeLedger(), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'reasoning-analysis.json'), `${JSON.stringify(reasoning, null, 2)}\n`);
  if (externalEvidence) {
    fs.mkdirSync(path.join(dir, '.codex-paper'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-paper', 'external-evidence.json'), `${JSON.stringify(externalEvidence, null, 2)}\n`);
  }
  return dir;
}

test('validateReasoningPackage accepts a complete evidence-grounded reasoning file', () => {
  const dir = writePackage(makeReasoning());
  try {
    const result = validateReasoningPackage(dir);
    assert.equal(result.report.status, 'pass', JSON.stringify(result.report, null, 2));
    assert.equal(fs.existsSync(path.join(dir, '.codex-paper', 'validation-report.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReasoningPackage reports missing refs and paper-only literature facts', () => {
  const reasoning = makeReasoning({
    centralClaims: [{
      id: 'claim-core-01',
      statement: 'The method reports a 3% improvement on the benchmark.',
      scope: 'Reported benchmark only.',
      sourceType: 'literature_fact',
      confidence: 'high',
      evidenceRefs: ['ev-p999-par-bbbbbbbbbb']
    }]
  });
  const dir = writePackage(reasoning);
  try {
    const result = validateReasoningPackage(dir);
    const codes = result.report.errors.map((error) => error.code);
    assert.ok(codes.includes('EVIDENCE_REF_NOT_FOUND'));
    assert.ok(codes.includes('LITERATURE_FACT_WITHOUT_EXTERNAL_EVIDENCE'));
    assert.ok(codes.includes('LITERATURE_FACT_IN_PAPER_ONLY_MODE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReasoningPackage rejects non-canonical evidence refs and profile mismatches', () => {
  const reasoning = makeReasoning({
    centralClaims: [{
      id: 'claim-core-01',
      statement: 'The method reports a 3% improvement on the benchmark.',
      scope: 'Reported benchmark only.',
      sourceType: 'paper_claim',
      confidence: 'high',
      evidenceRefs: ['ev-fake']
    }],
    paperType: 'survey',
    validations: [{
      id: 'validation-01',
      kind: 'experiment',
      question: 'Does the method improve?',
      design: 'Compare against the benchmark baseline.',
      observation: 'The paper reports a 3% improvement.',
      conclusion: 'The scoped claim is supported in the reported setting.',
      scope: 'Reported benchmark only.',
      supportsClaimIds: ['claim-core-01'],
      alternativeExplanation: 'A hidden baseline mismatch could also explain the gain.',
      sourceType: 'paper_claim',
      confidence: 'high',
      evidenceRefs: [EVIDENCE_ID]
    }]
  });
  const dir = writePackage(reasoning);
  try {
    const result = validateReasoningPackage(dir);
    const codes = result.report.errors.map((error) => error.code);
    assert.ok(codes.includes('EVIDENCE_REF_INVALID'));
    assert.ok(codes.includes('PAPER_CLAIM_WITHOUT_EVIDENCE'));
    assert.ok(codes.includes('VALIDATION_KIND_PROFILE_MISMATCH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReasoningPackage can acknowledge draft skeletons without full schema noise', () => {
  const reasoning = {
    schemaVersion: '2.0.0',
    status: 'draft',
    paperSlug: 'valid-paper',
    generatedAt: '2026-06-23T00:00:00.000Z',
    contextMode: 'paper-only',
    paperType: 'empirical',
    difficulty: 'advanced',
    evidenceQuality: 'complete_enough',
    centralClaims: [],
    researchQuestion: {},
    priorWorkGap: {},
    authorReasoningPath: [],
    coreIntuition: {},
    methodModel: { inputs: [], components: [], pipeline: [], outputs: [], equations: [] },
    validations: [],
    takeaways: [],
    weakestAssumption: {},
    minimalReproduction: {},
    strongestCounterexample: {},
    followUpIdea: {},
    limitations: [],
    uncertaintyZones: []
  };
  const dir = writePackage(reasoning);
  try {
    const result = validateReasoningPackage(dir, { allowDraft: true });
    assert.equal(result.report.status, 'draft');
    assert.equal(result.report.errors.length, 0);
    assert.equal(result.report.warnings[0].code, 'REASONING_DRAFT_NOT_VALIDATED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReasoningPackage accepts external evidence only through ext refs in non-paper-only mode', () => {
  const externalId = 'ext-canonical-paper-1234567890';
  const reasoning = makeReasoning({
    contextMode: 'canonical',
    priorWorkGap: {
      existingApproaches: [{
        id: 'prior-ext-01',
        statement: 'The canonical project page reports a related release.',
        sourceType: 'literature_fact',
        confidence: 'medium',
        evidenceRefs: [externalId]
      }],
      gap: node('gap-01', 'Existing approaches leave room on this benchmark.'),
      noveltyBoundary: node('novelty-01', 'The novelty boundary is the reported method within this benchmark.', 'inference')
    }
  });
  const externalEvidence = {
    schemaVersion: '2.0.0',
    paperSlug: 'valid-paper',
    contextMode: 'canonical',
    generatedAt: '2026-06-23T00:00:00.000Z',
    policy: {
      paperOnlyDefault: false,
      storedSeparatelyFromEvidenceLedger: true,
      note: 'External evidence is stored separately.'
    },
    sources: [{
      id: 'source-canonical',
      kind: 'canonical_paper_page',
      title: 'Canonical project page',
      url: 'https://example.com/project',
      accessedAt: '2026-06-23T00:00:00.000Z'
    }],
    evidence: [{
      id: externalId,
      sourceId: 'source-canonical',
      statement: 'The canonical project page reports a related release.',
      naturalLocation: 'Canonical project page, release note section',
      sourceType: 'literature_fact',
      confidence: 'medium'
    }]
  };
  const dir = writePackage(reasoning, externalEvidence);
  try {
    const result = validateReasoningPackage(dir);
    assert.equal(result.report.status, 'pass', JSON.stringify(result.report, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReasoningPackage detects reasoning DAG cycles and numeric mismatch', () => {
  const reasoning = makeReasoning();
  reasoning.authorReasoningPath[0].dependsOn = ['reason-04'];
  reasoning.validations[0].observation = 'The paper reports a 9% improvement.';
  const dir = writePackage(reasoning);
  try {
    const result = validateReasoningPackage(dir);
    const codes = result.report.errors.map((error) => error.code);
    assert.ok(codes.includes('REASONING_PATH_CYCLE'));
    assert.ok(codes.includes('NUMERIC_CLAIM_WITHOUT_MATCHING_EVIDENCE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
