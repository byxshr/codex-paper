import { PAPER_EVIDENCE_ID_PATTERN } from '../../../src/shared/package-compatibility.mjs';

const FACTS_SCHEMA_VERSION = '2.1.0';

const METRICS = [
  { metric: 'BLEU', pattern: /\bBLEU\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'Accuracy', pattern: /\baccuracy\b/gi, unit: 'percent', direction: 'higher_is_better' },
  { metric: 'F1', pattern: /\bF1(?:[- ]score)?\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'ROUGE', pattern: /\bROUGE(?:-[12L])?\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'Perplexity', pattern: /\bperplexity\b|\bPPL\b/gi, unit: 'score', direction: 'lower_is_better' },
  { metric: 'AUROC', pattern: /\b(?:AUROC|AUC)\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'mAP', pattern: /\bmAP\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'Precision', pattern: /\bprecision\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'Recall', pattern: /\brecall\b/gi, unit: 'score', direction: 'higher_is_better' },
  { metric: 'Exact Match', pattern: /\b(?:exact match|EM)\b/gi, unit: 'score', direction: 'higher_is_better' }
];

const NOISE_PATTERNS = [
  /^\s*[*†‡]\s*/, /\bequal contributions?\b/i, /\bcorresponding author\b/i,
  /\bcopyright\b|©|\ball rights reserved\b/i,
  /\b(?:presented|accepted) at\b.*\bconference\b/i,
  /\bconference\s+(?:on|at|20\d{2}|19\d{2})\b/i,
  /\barxiv\s*:\s*\d{4}\.\d+/i, /\bpreprint\s+version\b/i
];

const CLAIM_PATTERN = /\b(?:introduce|propose|present|show|demonstrate|develop|our approach|this paper)\b/i;
const LIMITATION_PATTERN = /\b(?:however|limitation|future work|remain|challenge|unstable|risk)\b/i;
const RESULT_PREDICATE = /\b(?:achiev|reach|report|obtain|score|result|outperform|improv|state[- ]of[- ]the[- ]art)\w*\b/i;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\u0000/g, ' ').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function sectionMap(ledger) {
  return new Map((ledger.sections || []).map((section) => [section.id, section.canonicalRole || 'unknown']));
}

function sectionFor(item, sections) {
  return sections.get(item.location?.sectionId) || (item.kind === 'abstract' ? 'abstract' : 'unknown');
}

export function isFrontMatterNoise(item, sections = new Map()) {
  const text = normalizeWhitespace(item?.text);
  const section = sectionFor(item || {}, sections);
  if (!text) return true;
  if (item?.kind === 'reference' || item?.kind === 'footnote' || section === 'references') return true;
  if (/^(?:abstract|introduction|results?|conclusions?|references)$/i.test(text.replace(/^\d+(?:\.\d+)*\s*/, ''))) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function evidenceShape(item, sections) {
  return {
    section: sectionFor(item, sections),
    quote: normalizeWhitespace(item.quote || item.text)
  };
}

function factItem(item, sections, bodyField = 'text') {
  return {
    [bodyField]: normalizeWhitespace(item.text),
    evidence: evidenceShape(item, sections),
    evidenceRefs: [item.id]
  };
}

function selectFactEvidence(ledger, predicate, limit = 3) {
  const sections = sectionMap(ledger);
  const selected = [];
  for (const item of ledger.evidence || []) {
    const section = sectionFor(item, sections);
    if (!['abstract', 'introduction', 'conclusion', 'limitations', 'results', 'unknown'].includes(section)) continue;
    if (isFrontMatterNoise(item, sections) || !predicate(normalizeWhitespace(item.text), item, section)) continue;
    selected.push(factItem(item, sections));
    if (selected.length >= limit) break;
  }
  return selected;
}

function splitClauses(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9])/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function metricOccurrences(text) {
  const occurrences = [];
  for (const definition of METRICS) {
    definition.pattern.lastIndex = 0;
    let match;
    while ((match = definition.pattern.exec(text))) {
      occurrences.push({ ...definition, index: match.index, length: match[0].length, matched: match[0] });
    }
  }
  return occurrences;
}

function isExcludedNumber(clause, match) {
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return true;
  if (Number.isInteger(value) && value >= 1900 && value <= 2099) return true;
  const before = clause.slice(Math.max(0, match.index - 24), match.index);
  const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 28);
  if (/\b(?:table|figure|fig\.?|page|section|equation|eq\.?|version|v)\s*$/i.test(before)) return true;
  if (/\b(?:WSJ|CIFAR|ImageNet)\s*$/i.test(before) && /^\s+(?:F1|accuracy|score)\b/i.test(after)) return true;
  if (/^\s*(?:GPUs?|TPUs?|days?|hours?|minutes?|seconds?|parameters?|params?|million|billion|tokens?|tasks?|heads?|layers?|rows?|cases?)\b/i.test(after)) return true;
  if (/\[[^\]]*$/.test(before) && /^[^\]]*\]/.test(after)) return true;
  return false;
}

function isMetricBound(clause, number, metric) {
  const numberStart = number.index;
  const numberEnd = number.index + number[0].length;
  const metricStart = metric.index;
  const metricEnd = metric.index + metric.length;
  const distance = Math.max(metricStart - numberEnd, numberStart - metricEnd, 0);
  if (distance > 48) return false;
  const between = clause.slice(Math.min(numberEnd, metricEnd), Math.max(numberStart, metricStart));
  if (/[.!?;]/.test(between)) return false;
  if (distance <= 12) return true;
  return RESULT_PREDICATE.test(clause) && distance <= 48;
}

function extractDataset(text) {
  const wmt = text.match(/\bWMT\s*[- ]?\d{4}\b/i);
  return wmt ? wmt[0].replace(/^WMT\s*[- ]?/i, 'WMT ').toUpperCase() : null;
}

function extractSplit(text) {
  return text.match(/\bnewstest\d{4}\b/i)?.[0].toLowerCase() || null;
}

function extractLanguagePair(text) {
  const abbreviated = text.match(/\b(?:EN|DE|FR|ES|ZH|CS|RO|RU|JA|KO|IT|NL|PT)[-–](?:EN|DE|FR|ES|ZH|CS|RO|RU|JA|KO|IT|NL|PT)\b/i);
  if (abbreviated) return abbreviated[0].replace('–', '-').toUpperCase();
  const named = text.match(/\bEnglish[- ]to[- ](?:German|French)\b/i)?.[0].toLowerCase();
  if (named?.includes('german')) return 'EN-DE';
  if (named?.includes('french')) return 'EN-FR';
  return null;
}

function extractModel(text) {
  const model = text.match(/\bTransformer\s*(?:\(\s*(?:big|base)\s*\)|big|base)?\b/i)?.[0];
  return model ? normalizeWhitespace(model).replace(/\(\s*/g, '(').replace(/\s*\)/g, ')') : null;
}

function extractComparator(text) {
  const comparator = text.match(/\b(?:single[- ]model\s+)?state[- ]of[- ]the[- ]art\b/i)?.[0];
  return comparator ? normalizeWhitespace(comparator).toLowerCase() : null;
}

function taskFor(text) {
  return /\b(?:translation|WMT|EN[-–](?:DE|FR))\b/i.test(text) ? 'machine translation' : null;
}

function parseTableNumber(item) {
  if (item.kind !== 'table' && !/^\s*Table\s*\d+\b/i.test(item.text || '')) return null;
  const label = item.labels?.tableNumber || item.text?.match(/\bTable\s*(\d+)\b/i)?.[0];
  const match = String(label || '').match(/\d+/);
  const table = match ? Number(match[0]) : null;
  return Number.isInteger(table) && table >= 1 ? table : null;
}

function fieldsCompatible(left, right) {
  const fields = ['task', 'dataset', 'split', 'languagePair', 'model', 'comparator'];
  if (!fields.every((field) => !left[field] || !right[field] || left[field] === right[field])) return false;
  if (left.evidenceRefs.some((ref) => right.evidenceRefs.includes(ref))) return true;
  return ['dataset', 'split', 'languagePair', 'model', 'comparator']
    .some((field) => left[field] && left[field] === right[field]);
}

function candidateSpecificity(candidate) {
  return ['dataset', 'split', 'languagePair', 'model', 'comparator']
    .filter((field) => candidate[field]).length;
}

function compareText(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function compareCandidatesForMerge(left, right) {
  const specificity = candidateSpecificity(right) - candidateSpecificity(left);
  if (specificity !== 0) return specificity;
  const semanticLeft = ['task', 'dataset', 'split', 'languagePair', 'model', 'comparator']
    .map((field) => left[field] || '').join('\u0000');
  const semanticRight = ['task', 'dataset', 'split', 'languagePair', 'model', 'comparator']
    .map((field) => right[field] || '').join('\u0000');
  return compareText(semanticLeft, semanticRight)
    || left.location.page - right.location.page
    || left._charStart - right._charStart
    || compareText(left.evidenceRefs[0] || '', right.evidenceRefs[0] || '');
}

function mergeCandidates(candidates) {
  const merged = [];
  for (const candidate of [...candidates].sort(compareCandidatesForMerge)) {
    const existing = merged.find((item) => item.metric.toLowerCase() === candidate.metric.toLowerCase()
      && item.value === candidate.value
      && fieldsCompatible(item, candidate));
    if (!existing) {
      merged.push({ ...candidate, evidenceRefs: [...candidate.evidenceRefs] });
      continue;
    }
    for (const field of ['task', 'dataset', 'split', 'languagePair', 'model', 'comparator']) {
      existing[field] ||= candidate[field];
    }
    existing.evidenceRefs = Array.from(new Set([...existing.evidenceRefs, ...candidate.evidenceRefs]));
    existing._charStart = Math.min(existing._charStart, candidate._charStart);
    if (candidate.location.table !== null && existing.location.table === null) existing.location = candidate.location;
    if (candidate.confidence === 'high') existing.confidence = 'high';
  }
  return merged;
}

export function extractResultClaims(ledger) {
  const sections = sectionMap(ledger);
  const candidates = [];
  for (const item of ledger.evidence || []) {
    if (item.confidence === 'low' || isFrontMatterNoise(item, sections)) continue;
    const fullText = normalizeWhitespace(item.text);
    for (const clause of splitClauses(fullText)) {
      const metrics = metricOccurrences(clause);
      if (metrics.length === 0) continue;
      const numbers = Array.from(clause.matchAll(/(?<![A-Za-z0-9.])-?\d+(?:\.\d+)?(?![A-Za-z0-9]|\.\d)/g));
      for (const number of numbers) {
        const numberEnd = number.index + number[0].length;
        if (metrics.some((metric) => number.index >= metric.index && numberEnd <= metric.index + metric.length)) continue;
        if (isExcludedNumber(clause, number)) continue;
        const boundMetrics = metrics.filter((metric) => isMetricBound(clause, number, metric));
        if (boundMetrics.length === 0) continue;
        const metric = boundMetrics.sort((left, right) => Math.abs(left.index - number.index) - Math.abs(right.index - number.index))[0];
        const value = Number(number[0]);
        const percent = /^\s*%/.test(clause.slice(number.index + number[0].length));
        candidates.push({
          task: taskFor(clause),
          dataset: extractDataset(clause),
          split: extractSplit(clause),
          languagePair: extractLanguagePair(clause),
          metric: metric.metric === 'ROUGE' ? metric.matched.toUpperCase() : metric.metric,
          value,
          unit: percent ? 'percent' : metric.unit,
          model: extractModel(clause),
          comparator: extractComparator(clause),
          direction: metric.direction,
          location: { page: Number(item.location?.page) || 1, table: parseTableNumber(item) },
          evidenceRefs: [item.id],
          confidence: item.confidence === 'high' ? 'high' : 'medium',
          _charStart: Number(item.location?.charStart) || 0
        });
      }
    }
  }

  return mergeCandidates(candidates)
    .sort((left, right) => left.location.page - right.location.page
      || left._charStart - right._charStart
      || left.metric.localeCompare(right.metric)
      || left.value - right.value)
    .map(({ _charStart, ...claim }) => claim);
}

export function projectKeyResults(resultClaims, ledger) {
  const evidence = new Map((ledger.evidence || []).map((item) => [item.id, item]));
  const sections = sectionMap(ledger);
  return resultClaims.map((claim) => {
    const source = evidence.get(claim.evidenceRefs[0]);
    const quote = normalizeWhitespace(source?.quote || source?.text || `${claim.value} ${claim.metric}`);
    const lexicalValues = Array.from(quote.matchAll(/-?\d+(?:\.\d+)?/g))
      .map((match) => match[0])
      .filter((value) => Number(value) === claim.value);
    const valueText = lexicalValues[0] || String(claim.value);
    return {
      label: claim.metric,
      value: claim.unit === 'percent' ? `${valueText}%` : valueText,
      context: quote,
      evidence: source ? evidenceShape(source, sections) : { section: 'unknown', quote },
      evidenceRefs: [...claim.evidenceRefs]
    };
  });
}

export function buildFactsFromLedger(paperSlug, parserVersion, ledger) {
  const coreClaims = selectFactEvidence(ledger, (text, item) => CLAIM_PATTERN.test(text) || item.roles?.includes('claim_candidate'));
  const limitations = selectFactEvidence(ledger, (text, item) => LIMITATION_PATTERN.test(text) || item.roles?.includes('limitation'));
  const resultClaims = extractResultClaims(ledger);
  return {
    schemaVersion: FACTS_SCHEMA_VERSION,
    paperSlug,
    parserVersion,
    coreClaims,
    resultClaims,
    keyResults: projectKeyResults(resultClaims, ledger),
    limitations
  };
}

export function validateFactsEvidenceRefs(facts, ledger) {
  const valid = new Set((ledger.evidence || []).map((item) => item.id));
  const errors = [];
  for (const [field, items] of Object.entries({ coreClaims: facts.coreClaims, resultClaims: facts.resultClaims, keyResults: facts.keyResults, limitations: facts.limitations })) {
    for (const [index, item] of (items || []).entries()) {
      if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0) {
        errors.push(`${field}[${index}] requires evidenceRefs`);
        continue;
      }
      const seen = new Set();
      for (const ref of item.evidenceRefs || []) {
        if (typeof ref !== 'string' || !PAPER_EVIDENCE_ID_PATTERN.test(ref)) errors.push(`${field}[${index}] has invalid evidence id ${ref}`);
        if (seen.has(ref)) errors.push(`${field}[${index}] repeats evidence ${ref}`);
        seen.add(ref);
        if (!valid.has(ref)) errors.push(`${field}[${index}] references missing evidence ${ref}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export { FACTS_SCHEMA_VERSION };
