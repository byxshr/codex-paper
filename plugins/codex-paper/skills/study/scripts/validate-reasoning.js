#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { collectEvidenceRefs } from './evidence-utils.js';
import { profileForType } from '../profiles/profile-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
const SCHEMA_PATH = path.join(__dirname, '../schemas/reasoning-analysis.schema.json');
const EXTERNAL_SCHEMA_PATH = path.join(__dirname, '../schemas/external-evidence.schema.json');

const PAPER_EVIDENCE_ID_PATTERN = /^ev-p\d{3,}-[a-z]+-[a-f0-9]{10}$/;
const EXTERNAL_EVIDENCE_ID_PATTERN = /^ext-[a-z0-9][a-z0-9-]*-[a-f0-9]{10}$/;
const TEMPLATE_RESIDUE = /\b(?:TODO|TBD|placeholder|fill me|lorem ipsum|待填写|占位|这里填写)\b/i;
const INCREMENTAL_FOLLOWUP = /\b(?:more data|larger model|bigger model|more parameters|scale up|tune hyperparameters|更多数据|更大模型|更多参数|调参)\b/i;

function usage() {
  console.error('Usage: node validate-reasoning.js <paper-dir-or-slug> [--json] [--strict] [--allow-draft]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    json: false,
    strict: false,
    allowDraft: false
  };

  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg === '--allow-draft') {
      args.allowDraft = true;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error('Missing paper directory or slug');
  }

  return args;
}

function resolvePaperDir(input) {
  const expanded = String(input || '').replace(/^~(?=$|\/)/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    return fs.statSync(direct).isDirectory() ? direct : path.dirname(direct);
  }
  return path.join(PAPERS_ROOT, input);
}

function addFinding(target, code, pathValue, message) {
  target.push({ code, path: pathValue, message });
}

function readJsonSafe(filePath) {
  try {
    return {
      ok: true,
      value: JSON.parse(fs.readFileSync(filePath, 'utf8'))
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

function compileSchema(schemaPath = SCHEMA_PATH) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

export function validateSchema(reasoning) {
  const errors = [];
  const validate = compileSchema();
  if (!validate(reasoning)) {
    for (const error of validate.errors || []) {
      addFinding(
        errors,
        'REASONING_SCHEMA_INVALID',
        error.instancePath || '/',
        `${error.instancePath || '/'} ${error.message}`
      );
    }
  }
  return errors;
}

function traverse(value, visitor, pathValue = '') {
  if (!value || typeof value !== 'object') return;
  visitor(value, pathValue || '/');
  if (Array.isArray(value)) {
    value.forEach((item, index) => traverse(item, visitor, `${pathValue}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = pathValue ? `${pathValue}.${key}` : key;
    traverse(child, visitor, childPath);
  }
}

function evidenceTextForRefs(refs, evidenceIndex, externalIndex) {
  return refs
    .map((ref) => evidenceIndex.get(ref)?.text || evidenceIndex.get(ref)?.quote || externalIndex.get(ref)?.statement || '')
    .join('\n')
    .toLowerCase();
}

export function validateEvidenceRefs(reasoning, ledger, externalEvidence) {
  const errors = [];
  const ledgerRefs = new Set((ledger?.evidence || []).map((item) => item.id));
  const externalRefs = new Set((externalEvidence?.evidence || []).map((item) => item.id));

  traverse(reasoning, (node, nodePath) => {
    if (!Array.isArray(node.evidenceRefs)) return;
    node.evidenceRefs.forEach((ref, index) => {
      const isPaperRef = PAPER_EVIDENCE_ID_PATTERN.test(ref);
      const isExternalRef = EXTERNAL_EVIDENCE_ID_PATTERN.test(ref);
      if (!isPaperRef && !isExternalRef) {
        addFinding(
          errors,
          'EVIDENCE_REF_INVALID',
          `${nodePath}.evidenceRefs[${index}]`,
          `Evidence ref has an invalid format: ${ref}`
        );
        return;
      }
      const found = isExternalRef ? externalRefs.has(ref) : ledgerRefs.has(ref);
      if (!found) {
        addFinding(
          errors,
          'EVIDENCE_REF_NOT_FOUND',
          `${nodePath}.evidenceRefs[${index}]`,
          `Evidence ref not found: ${ref}`
        );
      }
    });
  });

  return errors;
}

export function validateExternalEvidence(reasoning, externalEvidence) {
  const errors = [];
  const warnings = [];
  if (!externalEvidence) {
    return { errors, warnings };
  }

  const validate = compileSchema(EXTERNAL_SCHEMA_PATH);
  if (!validate(externalEvidence)) {
    for (const error of validate.errors || []) {
      addFinding(
        errors,
        'EXTERNAL_EVIDENCE_SCHEMA_INVALID',
        error.instancePath || '/',
        `${error.instancePath || '/'} ${error.message}`
      );
    }
  }

  if ((reasoning?.contextMode || 'paper-only') === 'paper-only' && (externalEvidence.evidence || []).length > 0) {
    addFinding(
      errors,
      'EXTERNAL_EVIDENCE_IN_PAPER_ONLY_MODE',
      '.codex-paper/external-evidence.json',
      'paper-only mode cannot include external evidence entries'
    );
  }

  const sourceIds = new Set((externalEvidence.sources || []).map((source) => source.id));
  (externalEvidence.evidence || []).forEach((item, index) => {
    if (item.sourceId && !sourceIds.has(item.sourceId)) {
      addFinding(
        errors,
        'EXTERNAL_EVIDENCE_SOURCE_NOT_FOUND',
        `.codex-paper/external-evidence.json.evidence[${index}].sourceId`,
        `External source not found: ${item.sourceId}`
      );
    }
  });

  return { errors, warnings };
}

export function validateSourceTypes(reasoning, contextMode) {
  const errors = [];
  const warnings = [];

  traverse(reasoning, (node, nodePath) => {
    const looksLikeAnalysisNode = typeof node.statement === 'string' || Object.hasOwn(node, 'sourceType') || Object.hasOwn(node, 'confidence');
    if (!looksLikeAnalysisNode) return;

    if (!node.sourceType) {
      addFinding(errors, 'SOURCE_TYPE_REQUIRED', `${nodePath}.sourceType`, 'Analysis node is missing sourceType');
      return;
    }

    if (!node.confidence) {
      addFinding(errors, 'CONFIDENCE_REQUIRED', `${nodePath}.confidence`, 'Analysis node is missing confidence');
    }

    const refs = Array.isArray(node.evidenceRefs) ? node.evidenceRefs : [];
    if (node.sourceType === 'paper_claim' && !refs.some((ref) => PAPER_EVIDENCE_ID_PATTERN.test(ref))) {
      addFinding(errors, 'PAPER_CLAIM_WITHOUT_EVIDENCE', `${nodePath}.evidenceRefs`, 'paper_claim must cite at least one paper evidence ref');
    }

    if (node.sourceType === 'literature_fact' && !refs.some((ref) => EXTERNAL_EVIDENCE_ID_PATTERN.test(ref))) {
      addFinding(errors, 'LITERATURE_FACT_WITHOUT_EXTERNAL_EVIDENCE', `${nodePath}.evidenceRefs`, 'literature_fact must cite external evidence');
    }

    if (contextMode === 'paper-only' && node.sourceType === 'literature_fact') {
      addFinding(errors, 'LITERATURE_FACT_IN_PAPER_ONLY_MODE', `${nodePath}.sourceType`, 'paper-only mode cannot use literature_fact');
    }

    if (node.sourceType === 'speculation' && node.confidence === 'high') {
      addFinding(errors, 'SPECULATION_MARKED_HIGH_CONFIDENCE', `${nodePath}.confidence`, 'speculation cannot be high confidence');
    }

    if (node.sourceType === 'inference' && refs.length === 0) {
      addFinding(warnings, 'INFERENCE_WITHOUT_EVIDENCE', `${nodePath}.evidenceRefs`, 'inference should cite supporting evidence when possible');
    }
  });

  return { errors, warnings };
}

function normalizeNumberToken(token) {
  return String(token || '').toLowerCase().replace(/\s+/g, '');
}

function extractNumericTokens(text) {
  const value = String(text || '');
  const tokens = [];
  const tokenPatterns = [
    /\b\d+(?:\.\d+)?\s?%/g,
    /\b\d+(?:\.\d+)?\s?(?:x|×|ms|s|sec|secs|seconds?|hours?|gb|mb|kb|tokens?|parameters?|params?|billion|million|bleu|points?)\b/gi,
    /\b\d+\.\d+\b/g
  ];

  for (const pattern of tokenPatterns) {
    for (const match of value.matchAll(pattern)) {
      tokens.push(match[0]);
    }
  }

  const pureIntegers = [];
  for (const match of value.matchAll(/\b\d{2,}\b/g)) {
    const number = Number(match[0]);
    if (number >= 1900 && number <= 2100) continue;
    if (tokens.some((token) => token.includes(match[0]))) continue;
    pureIntegers.push(match[0]);
  }

  return {
    strong: Array.from(new Set(tokens.map(normalizeNumberToken))),
    weak: Array.from(new Set(pureIntegers.map(normalizeNumberToken)))
  };
}

function paperClaimTexts(reasoning) {
  const nodes = [];
  traverse(reasoning, (node, nodePath) => {
    if (node.sourceType !== 'paper_claim') return;
    const text = [node.statement, node.observation, node.conclusion]
      .filter((value) => typeof value === 'string')
      .join(' ');
    nodes.push({ node, nodePath, text });
  });
  return nodes;
}

export function validateNumericGrounding(reasoning, evidenceIndex, externalIndex) {
  const errors = [];
  const warnings = [];

  for (const item of paperClaimTexts(reasoning)) {
    const refs = Array.isArray(item.node.evidenceRefs) ? item.node.evidenceRefs : [];
    const evidenceText = normalizeNumberToken(evidenceTextForRefs(refs, evidenceIndex, externalIndex));
    const { strong, weak } = extractNumericTokens(item.text);

    for (const token of strong) {
      if (!evidenceText.includes(token)) {
        addFinding(
          errors,
          'NUMERIC_CLAIM_WITHOUT_MATCHING_EVIDENCE',
          `${item.nodePath}.evidenceRefs`,
          `Numeric paper_claim token "${token}" is not present in cited evidence`
        );
      }
    }

    for (const token of weak) {
      if (!evidenceText.includes(token)) {
        addFinding(
          warnings,
          'NUMERIC_CLAIM_WITHOUT_MATCHING_EVIDENCE',
          `${item.nodePath}.evidenceRefs`,
          `Pure integer token "${token}" could not be conservatively matched in cited evidence`
        );
      }
    }
  }

  return { errors, warnings };
}

function centralClaimIds(reasoning) {
  return new Set((reasoning?.centralClaims || []).map((claim) => claim.id).filter(Boolean));
}

export function validateReasoningGraph(reasoning) {
  const errors = [];
  const warnings = [];
  const nodes = Array.isArray(reasoning.authorReasoningPath) ? reasoning.authorReasoningPath : [];
  const nodeIds = new Set(nodes.map((node) => node.id).filter(Boolean));

  if (nodes.length < 3) {
    addFinding(errors, 'REASONING_PATH_TOO_SHORT', 'authorReasoningPath', 'authorReasoningPath must contain at least 3 nodes');
  } else if (nodes.length === 3) {
    addFinding(warnings, 'REASONING_PATH_SHALLOW', 'authorReasoningPath', 'authorReasoningPath has the minimum 3 nodes and may be shallow');
  }

  nodes.forEach((node, index) => {
    (node.dependsOn || []).forEach((dependency) => {
      if (!nodeIds.has(dependency)) {
        addFinding(errors, 'REASONING_DEPENDENCY_INVALID', `authorReasoningPath[${index}].dependsOn`, `Dependency not found: ${dependency}`);
      }
    });
  });

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = byId.get(id);
    for (const dependency of node?.dependsOn || []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const id of nodeIds) {
    if (visit(id)) {
      addFinding(errors, 'REASONING_PATH_CYCLE', 'authorReasoningPath', 'authorReasoningPath dependsOn graph contains a cycle');
      break;
    }
  }

  return { errors, warnings };
}

export function validateCriticalAnalysis(reasoning) {
  const errors = [];
  const warnings = [];
  const claimIds = centralClaimIds(reasoning);
  const profile = profileForType(reasoning?.paperType);
  const allowedValidationKinds = new Set(profile.validationKinds || []);

  (reasoning.centralClaims || []).forEach((claim, index) => {
    if (!claim.scope) {
      addFinding(warnings, 'CLAIM_SCOPE_MISSING', `centralClaims[${index}].scope`, 'Core claim should include a scope boundary');
    }
  });

  traverse(reasoning, (node, nodePath) => {
    if (typeof node.id === 'string') {
      return;
    }
    if (typeof node.statement === 'string' && !node.sourceType) {
      addFinding(errors, 'SOURCE_TYPE_REQUIRED', `${nodePath}.sourceType`, 'Analysis node is missing sourceType');
    }
  });

  const ids = new Map();
  traverse(reasoning, (node, nodePath) => {
    if (typeof node.id !== 'string' || !node.id) return;
    if (ids.has(node.id)) {
      addFinding(errors, 'DUPLICATE_ANALYSIS_ID', nodePath, `Duplicate analysis id: ${node.id}`);
    } else {
      ids.set(node.id, nodePath);
    }
  });

  (reasoning.authorReasoningPath || []).forEach((node, index) => {
    (node.supportsClaimIds || []).forEach((claimId) => {
      if (!claimIds.has(claimId)) {
        addFinding(errors, 'CORE_CLAIM_TARGET_NOT_FOUND', `authorReasoningPath[${index}].supportsClaimIds`, `Unknown core claim: ${claimId}`);
      }
    });
  });

  (reasoning.validations || []).forEach((validation, index) => {
    if (validation.kind && allowedValidationKinds.size > 0 && !allowedValidationKinds.has(validation.kind)) {
      addFinding(errors, 'VALIDATION_KIND_PROFILE_MISMATCH', `validations[${index}].kind`, `${validation.kind} is not expected for ${reasoning.paperType || 'other'} papers`);
    }
    if (!validation.question) addFinding(errors, 'VALIDATION_WITHOUT_QUESTION', `validations[${index}].question`, 'Validation unit must ask a question');
    if (!validation.design) addFinding(errors, 'VALIDATION_WITHOUT_DESIGN', `validations[${index}].design`, 'Validation unit must include a design');
    if (!validation.observation) addFinding(errors, 'VALIDATION_WITHOUT_OBSERVATION', `validations[${index}].observation`, 'Validation unit must include an observation');
    if (!validation.conclusion) addFinding(errors, 'VALIDATION_WITHOUT_CONCLUSION', `validations[${index}].conclusion`, 'Validation unit must include a conclusion');
    (validation.supportsClaimIds || []).forEach((claimId) => {
      if (!claimIds.has(claimId)) {
        addFinding(errors, 'CORE_CLAIM_TARGET_NOT_FOUND', `validations[${index}].supportsClaimIds`, `Unknown core claim: ${claimId}`);
      }
    });
    if (['experiment', 'ablation', 'benchmark', 'case_study', 'user_study'].includes(validation.kind) && !validation.alternativeExplanation) {
      addFinding(warnings, 'VALIDATION_ALTERNATIVE_EXPLANATION_MISSING', `validations[${index}].alternativeExplanation`, 'Empirical validation should consider alternative explanations');
    }
  });

  const assumption = reasoning.weakestAssumption || {};
  if (!claimIds.has(assumption.targetClaimId)) {
    addFinding(errors, 'ASSUMPTION_WITHOUT_TARGET_CLAIM', 'weakestAssumption.targetClaimId', 'Weakest assumption must target a core claim');
  }
  if (!Array.isArray(assumption.failureConditions) || assumption.failureConditions.length === 0 || !assumption.observableFailure) {
    addFinding(errors, 'ASSUMPTION_WITHOUT_FAILURE_CONDITION', 'weakestAssumption.failureConditions', 'Weakest assumption needs failure conditions and observable failure');
  }

  const reproduction = reasoning.minimalReproduction || {};
  if (!claimIds.has(reproduction.targetClaimId)) {
    addFinding(errors, 'CORE_CLAIM_TARGET_NOT_FOUND', 'minimalReproduction.targetClaimId', 'Minimal reproduction must target a core claim');
  }
  if (!Array.isArray(reproduction.supportCriteria) || reproduction.supportCriteria.length === 0) {
    addFinding(errors, 'MIN_REPRO_WITHOUT_SUPPORT_CRITERIA', 'minimalReproduction.supportCriteria', 'Minimal reproduction needs support criteria');
  }
  if (!Array.isArray(reproduction.falsificationCriteria) || reproduction.falsificationCriteria.length === 0) {
    addFinding(errors, 'MIN_REPRO_WITHOUT_FALSIFICATION_CRITERIA', 'minimalReproduction.falsificationCriteria', 'Minimal reproduction needs falsification criteria');
  }

  const counterexample = reasoning.strongestCounterexample || {};
  if (!claimIds.has(counterexample.targetClaimId)) {
    addFinding(errors, 'COUNTEREXAMPLE_WITHOUT_TARGET_CLAIM', 'strongestCounterexample.targetClaimId', 'Strongest counterexample must target a core claim');
  }
  if (!counterexample.predictedObservation) {
    addFinding(errors, 'COUNTEREXAMPLE_WITHOUT_PREDICTED_OBSERVATION', 'strongestCounterexample.predictedObservation', 'Counterexample needs an observable predicted result');
  }

  const followUp = reasoning.followUpIdea || {};
  if (!followUp.whyNonIncremental) {
    addFinding(errors, 'FOLLOWUP_WITHOUT_NON_INCREMENTAL_RATIONALE', 'followUpIdea.whyNonIncremental', 'Follow-up idea must explain why it is non-incremental');
  } else if (INCREMENTAL_FOLLOWUP.test(`${followUp.motivation || ''} ${followUp.novelFraming || ''} ${followUp.whyNonIncremental || ''}`)) {
    addFinding(warnings, 'FOLLOWUP_MAY_BE_INCREMENTAL', 'followUpIdea.whyNonIncremental', 'Follow-up idea appears to rely on scaling data/model/parameters or tuning');
  }

  traverse(reasoning, (node, nodePath) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && TEMPLATE_RESIDUE.test(value)) {
        addFinding(errors, 'TEMPLATE_RESIDUE_FOUND', `${nodePath}.${key}`, 'Template residue found');
      }
    }
  });

  return { errors, warnings };
}

export function calculateCoverageStats(reasoning) {
  const stats = {
    paperClaims: 0,
    inferences: 0,
    speculations: 0,
    evidenceCoverage: 0
  };
  let nodes = 0;
  let covered = 0;

  traverse(reasoning, (node) => {
    if (!node.sourceType) return;
    nodes += 1;
    if (node.sourceType === 'paper_claim') stats.paperClaims += 1;
    if (node.sourceType === 'inference') stats.inferences += 1;
    if (node.sourceType === 'speculation') stats.speculations += 1;
    if (Array.isArray(node.evidenceRefs) && node.evidenceRefs.length > 0) covered += 1;
  });

  stats.evidenceCoverage = nodes === 0 ? 0 : Number((covered / nodes).toFixed(2));
  return stats;
}

export function mergeFindings(...groups) {
  return groups.flat().filter(Boolean);
}

function loadExternalEvidence(paperDir) {
  const externalPath = path.join(paperDir, '.codex-paper', 'external-evidence.json');
  if (!fs.existsSync(externalPath)) return null;
  const read = readJsonSafe(externalPath);
  return read.ok ? read.value : null;
}

function writeReport(paperDir, report) {
  const codexDir = path.join(paperDir, '.codex-paper');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

export function validateReasoningPackage(input, options = {}) {
  const paperDir = resolvePaperDir(input);
  const errors = [];
  const warnings = [];
  let reasoning = null;
  let ledger = null;
  let externalEvidence = null;

  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    addFinding(errors, 'REASONING_FILE_MISSING', 'paperDir', `Paper directory not found: ${paperDir}`);
    const report = { status: 'fail', errors, warnings, stats: calculateCoverageStats(null) };
    return { paperDir, report };
  }

  const reasoningPath = path.join(paperDir, 'reasoning-analysis.json');
  if (!fs.existsSync(reasoningPath)) {
    addFinding(errors, 'REASONING_FILE_MISSING', 'reasoning-analysis.json', 'v2 package is missing reasoning-analysis.json');
  } else {
    const read = readJsonSafe(reasoningPath);
    if (read.ok) {
      reasoning = read.value;
    } else {
      addFinding(errors, 'REASONING_SCHEMA_INVALID', 'reasoning-analysis.json', `Invalid JSON: ${read.error.message}`);
    }
  }

  const ledgerPath = path.join(paperDir, 'evidence-ledger.json');
  if (!fs.existsSync(ledgerPath)) {
    addFinding(errors, 'EVIDENCE_LEDGER_MISSING', 'evidence-ledger.json', 'v2 package is missing evidence-ledger.json');
  } else {
    const read = readJsonSafe(ledgerPath);
    if (read.ok) {
      ledger = read.value;
    } else {
      addFinding(errors, 'EVIDENCE_LEDGER_MISSING', 'evidence-ledger.json', `Invalid evidence ledger JSON: ${read.error.message}`);
    }
  }

  externalEvidence = loadExternalEvidence(paperDir);

  if (reasoning) {
    if (options.allowDraft && reasoning.status === 'draft' && errors.length === 0) {
      const report = {
        status: 'draft',
        errors: [],
        warnings: [{
          code: 'REASONING_DRAFT_NOT_VALIDATED',
          path: 'reasoning-analysis.json',
          message: 'Draft reasoning skeleton was accepted because --allow-draft was provided; fill it and run strict validation before publishing.'
        }],
        stats: calculateCoverageStats(reasoning)
      };
      writeReport(paperDir, report);
      return { paperDir, report };
    }

    errors.push(...validateSchema(reasoning));
    const sourceFindings = validateSourceTypes(reasoning, reasoning.contextMode || 'paper-only');
    errors.push(...sourceFindings.errors);
    warnings.push(...sourceFindings.warnings);

    const evidenceIndex = new Map((ledger?.evidence || []).map((item) => [item.id, item]));
    const externalIndex = new Map((externalEvidence?.evidence || []).map((item) => [item.id, item]));
    const externalFindings = validateExternalEvidence(reasoning, externalEvidence);
    errors.push(...externalFindings.errors);
    warnings.push(...externalFindings.warnings);
    errors.push(...validateEvidenceRefs(reasoning, ledger || {}, externalEvidence || {}));

    const numericFindings = validateNumericGrounding(reasoning, evidenceIndex, externalIndex);
    errors.push(...numericFindings.errors);
    warnings.push(...numericFindings.warnings);

    const graphFindings = validateReasoningGraph(reasoning);
    errors.push(...graphFindings.errors);
    warnings.push(...graphFindings.warnings);

    const criticalFindings = validateCriticalAnalysis(reasoning);
    errors.push(...criticalFindings.errors);
    warnings.push(...criticalFindings.warnings);

    const refs = collectEvidenceRefs(reasoning);
    const coverage = refs.length === 0 ? 0 : refs.filter((ref) => evidenceIndex.has(ref) || externalIndex.has(ref)).length / refs.length;
    if (coverage < 0.75) {
      addFinding(warnings, 'LOW_EVIDENCE_COVERAGE', 'evidenceRefs', `Evidence ref coverage is ${coverage.toFixed(2)}`);
    }

    const lowConfidenceNodes = [];
    traverse(reasoning, (node) => {
      if (node.confidence) lowConfidenceNodes.push(node.confidence === 'low');
    });
    if (lowConfidenceNodes.length > 0 && lowConfidenceNodes.filter(Boolean).length > lowConfidenceNodes.length / 2) {
      addFinding(warnings, 'LOW_CONFIDENCE_DOMINATES', 'confidence', 'Most reasoning nodes are low confidence');
    }

    if (['partial_sections', 'noisy_reading_order', 'noisy_table_extraction', 'weak_quantitative_evidence', 'severely_limited'].includes(reasoning.evidenceQuality)) {
      addFinding(warnings, 'PARSER_QUALITY_LIMITED', 'evidenceQuality', `Evidence quality is ${reasoning.evidenceQuality}`);
    }
  }

  let finalErrors = errors;
  let finalWarnings = warnings;
  if (options.strict && warnings.length > 0) {
    finalErrors = errors.concat(warnings.map((warning) => ({
      ...warning,
      code: warning.code,
      message: `[strict] ${warning.message}`
    })));
    finalWarnings = [];
  }

  const report = {
    status: finalErrors.length === 0 ? 'pass' : 'fail',
    errors: finalErrors,
    warnings: finalWarnings,
    stats: calculateCoverageStats(reasoning)
  };

  writeReport(paperDir, report);
  return { paperDir, report };
}

function printHuman(result) {
  const { paperDir, report } = result;
  console.log(`Reasoning validation: ${report.status.toUpperCase()}`);
  console.log(`Paper directory: ${paperDir}`);
  if (report.errors.length > 0) {
    console.log('\nErrors:');
    report.errors.forEach((finding) => console.log(`- ${finding.code} ${finding.path}: ${finding.message}`));
  }
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    report.warnings.forEach((finding) => console.log(`- ${finding.code} ${finding.path}: ${finding.message}`));
  }
  console.log(`\nStats: ${JSON.stringify(report.stats)}`);
}

async function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = validateReasoningPackage(args.input, { strict: args.strict, allowDraft: args.allowDraft });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      printHuman(result);
    }
    process.exit(result.report.errors.length === 0 ? 0 : 1);
  } catch (error) {
    usage();
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] === __filename) {
  runCli();
}
