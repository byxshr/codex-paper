import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
export const ANALYSIS_VERSION = '1.0.0';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the', 'their',
  'this', 'to', 'we', 'with'
]);

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitSentences(value) {
  return normalizeWhitespace(value)
    .split(/(?<=[.?!])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
}

function uniqBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output;
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function removeTrailingArtifacts(value) {
  let text = normalizeWhitespace(value);
  const markers = [
    /\bTable\s+\d+[:.]?/i,
    /\bFigure\s+\d+[:.]?/i,
    /\bFig\.\s*\d+[:.]?/i,
    /\bExperimental Details\b/i,
    /\bAppendix\b/i,
    /\bA\.\d+\b/i
  ];

  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index > 32) {
      text = text.slice(0, match.index).trim();
    }
  }

  return text.replace(/\s+\d+\s*$/, '').trim();
}

function cleanAnalysisText(value) {
  return removeTrailingArtifacts(value)
    .replace(/\s+([,:;?!])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

function tokenize(value) {
  return normalizeForMatch(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function scoreTokenOverlap(source, target) {
  const sourceTokens = tokenize(source);
  const targetTokens = tokenize(target);
  if (sourceTokens.length === 0 || targetTokens.length === 0) {
    return 0;
  }

  const targetSet = new Set(targetTokens);
  let overlap = 0;
  for (const token of sourceTokens) {
    if (targetSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(sourceTokens.length, targetTokens.length);
}

function emptyField() {
  return {
    text: '',
    evidenceRefs: []
  };
}

function factCatalog(facts) {
  const items = [];

  for (const [kind, key] of [
    ['claim', 'coreClaims'],
    ['result', 'keyResults'],
    ['limitation', 'limitations']
  ]) {
    const values = Array.isArray(facts[key]) ? facts[key] : [];
    values.forEach((item, index) => {
      const body = kind === 'result' ? item.context || item.label : item.text;
      items.push({
        ref: `${kind}:${index}`,
        kind,
        text: normalizeWhitespace(body),
        quote: normalizeWhitespace(item.evidence?.quote || '')
      });
    });
  }

  return items;
}

function findEvidenceRefs(text, facts, preferredKinds = [], limit = 2) {
  const catalog = factCatalog(facts);
  const scoreCatalog = (items) => items
    .map((item) => {
      const overlap = Math.max(
        scoreTokenOverlap(text, item.text),
        scoreTokenOverlap(text, item.quote)
      );
      const kindBoost = preferredKinds.includes(item.kind) ? 0.05 : 0;
      return {
        ref: item.ref,
        score: overlap + kindBoost
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const preferredCatalog = preferredKinds.length > 0
    ? catalog.filter((item) => preferredKinds.includes(item.kind))
    : catalog;

  let scores = scoreCatalog(preferredCatalog);
  if (scores.length === 0 && preferredCatalog !== catalog) {
    scores = scoreCatalog(catalog);
  }

  if (scores.length > 0) {
    return scores.map((item) => item.ref);
  }

  const fallback = [];
  for (const kind of preferredKinds) {
    const match = catalog.find((item) => item.kind === kind);
    if (match) {
      fallback.push(match.ref);
      break;
    }
  }

  if (fallback.length > 0) {
    return fallback;
  }

  return catalog.length > 0 ? [catalog[0].ref] : [];
}

function isGenericResultLabel(label) {
  return /^Result\s+\d+$/i.test(String(label || '').trim());
}

function isNoisyResult(result) {
  const context = normalizeWhitespace(result?.context || '');
  const value = String(result?.value || '').trim();

  if (!context) {
    return true;
  }

  if (/\bExperimental Details\b|\bA\.\d+\b|\bGoogle search engine\b|\bJina\b|\buses two types of tools\b/i.test(context)) {
    return true;
  }

  if (/\bsearching multiple queries simultaneously\b|\btop-\d+\s+results\b|\bretrieve the full content of the web page\b|\bSearch is used to access\b/i.test(context)) {
    return true;
  }

  if (/^\d+\s+[A-Z]/.test(context) && !/\b(?:billion|million|languages?|benchmark|accuracy|score|state-of-the-art|outperform|improve)\b/i.test(context)) {
    return true;
  }

  if (/^\d{4}$/.test(value) && /\(\w.+\d{4}\)|\bJina\b|\bOpenAI\b/i.test(context)) {
    return true;
  }

  return false;
}

function deriveMetric(result) {
  const context = normalizeWhitespace(result.context);
  const label = cleanAnalysisText(result.label || '');

  if (/parameter scales?\s+ranging/i.test(context)) {
    return 'Parameter scale';
  }

  if (/multilingual support|languages? and dialects/i.test(context)) {
    return 'Language coverage';
  }

  if (/state-of-the-art|outperform|competitive/i.test(context)) {
    return 'Benchmark performance';
  }

  if (label && !isGenericResultLabel(label)) {
    return capitalize(label);
  }

  return 'Key result';
}

function deriveValue(result) {
  const context = normalizeWhitespace(result.context);

  const parameterRange = context.match(/ranging from\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+billion/i);
  if (parameterRange) {
    return `${parameterRange[1]} to ${parameterRange[2]} billion`;
  }

  const languageExpansion = context.match(/from\s+\d+\s+to\s+(\d+)\s+languages?(?:\s+and\s+dialects)?/i);
  if (languageExpansion) {
    return `${languageExpansion[1]} languages and dialects`;
  }

  if (/state-of-the-art/i.test(context)) {
    return 'State-of-the-art';
  }

  if (/matching proprietary agents/i.test(context)) {
    return 'Matches proprietary-agent performance';
  }

  if (/outperforms all open-source agents/i.test(context)) {
    return 'Outperforms open-source agents';
  }

  if (result.value && result.value !== 'See evidence') {
    return String(result.value).trim();
  }

  return 'See evidence';
}

function deriveBenchmark(result, paperData) {
  const context = normalizeWhitespace(result.context);

  if (/BrowseComp/i.test(context)) {
    return 'BrowseComp';
  }

  if (/code generation, mathematical reasoning, agent tasks/i.test(context)) {
    return 'Code, math, and agent benchmarks';
  }

  if (/complex information-seeking tasks/i.test(context)) {
    return 'Complex information-seeking benchmarks';
  }

  if (/parameter scales?|multilingual support/i.test(context)) {
    return paperData.title;
  }

  if (/open-source agents?/i.test(context)) {
    return 'Open-source agent benchmarks';
  }

  return paperData.title || 'Reported benchmark';
}

function buildResultsTable(paperData, facts) {
  const rows = [];
  const results = Array.isArray(facts.keyResults) ? facts.keyResults : [];

  results.forEach((result, index) => {
    if (isNoisyResult(result)) {
      return;
    }

    rows.push({
      metric: deriveMetric(result),
      value: deriveValue(result),
      benchmark: deriveBenchmark(result, paperData),
      evidenceRefs: [`result:${index}`]
    });
  });

  if (rows.length === 0) {
    const fallbackSentence = splitSentences([
      paperData.sections?.abstract,
      paperData.sections?.conclusion
    ].join(' '))
      .find((sentence) => /\b(?:state-of-the-art|outperforms|matching proprietary agents|closing the capability gap|surpass human levels)\b/i.test(sentence));

    if (fallbackSentence) {
      rows.push({
        metric: 'Benchmark performance',
        value: /matching proprietary agents/i.test(fallbackSentence)
          ? 'Matches proprietary-agent performance'
          : (/state-of-the-art/i.test(fallbackSentence) ? 'State-of-the-art' : 'Reported strong performance'),
        benchmark: /BrowseComp/i.test(fallbackSentence)
          ? 'BrowseComp'
          : (/\bcomplex information-seeking tasks\b/i.test(fallbackSentence)
            ? 'Complex information-seeking benchmarks'
            : (paperData.title || 'Reported benchmarks')),
        evidenceRefs: findEvidenceRefs(fallbackSentence, facts, ['claim', 'result'], 2)
      });
    }
  }

  return uniqBy(rows, (row) => `${row.metric}|${row.value}|${row.benchmark}`).slice(0, 4);
}

function chooseOneSentence(paperData, facts) {
  const claims = Array.isArray(facts.coreClaims) ? facts.coreClaims : [];
  const ranked = claims
    .map((claim, index) => {
      const text = cleanAnalysisText(claim.text);
      let score = 0;
      if (claim.evidence?.section === 'abstract') score += 2;
      if (text.length >= 60 && text.length <= 180) score += 1;
      if (/introduce|present|propose/i.test(text)) score += 1;
      return {
        text,
        evidenceRefs: [`claim:${index}`],
        score
      };
    })
    .sort((left, right) => right.score - left.score);

  if (ranked.length > 0) {
    return {
      text: ranked[0].text,
      evidenceRefs: ranked[0].evidenceRefs
    };
  }

  const fallback = splitSentences(paperData.sections?.abstract || '')[0];
  if (!fallback) {
    return emptyField();
  }

  return {
    text: cleanAnalysisText(fallback),
    evidenceRefs: findEvidenceRefs(fallback, facts, ['claim'], 1)
  };
}

function chooseProblem(paperData, facts) {
  const candidates = [
    ...splitSentences(paperData.sections?.introduction || ''),
    ...splitSentences(paperData.sections?.abstract || '')
  ]
    .filter((sentence) => /\b(?:however|yet|while|remain|challenge|problem|gap|limited|constraint|uncertainty|proprietary|unsolved|cognitive limitations)\b/i.test(sentence))
    .map((sentence) => ({
      text: cleanAnalysisText(sentence),
      score: (/\b(?:however|problem|challenge|gap|unsolved)\b/i.test(sentence) ? 2 : 0)
        + (/\b(?:introduction|abstract)\b/i.test(sentence) ? 0 : 0)
    }))
    .sort((left, right) => right.score - left.score);

  if (candidates.length > 0) {
    return {
      text: candidates[0].text,
      evidenceRefs: findEvidenceRefs(candidates[0].text, facts, ['limitation', 'claim'], 2)
    };
  }

  const limitation = Array.isArray(facts.limitations) ? facts.limitations[0] : null;
  if (limitation?.text) {
    return {
      text: cleanAnalysisText(limitation.text),
      evidenceRefs: ['limitation:0']
    };
  }

  return emptyField();
}

function chooseCoreIdea(paperData, facts, oneSentenceText) {
  const claims = Array.isArray(facts.coreClaims) ? facts.coreClaims : [];
  const cleanedClaims = claims.map((claim, index) => ({
    text: cleanAnalysisText(claim.text),
    evidenceRefs: [`claim:${index}`]
  }));

  const methodFirst = cleanedClaims.find((item) =>
    normalizeForMatch(item.text) !== normalizeForMatch(oneSentenceText)
    && /\b(?:approach|method|framework|pipeline|algorithm|mechanism|mode|budget)\b/i.test(item.text)
  );
  if (methodFirst) {
    return methodFirst;
  }

  const innovationSentence = splitSentences(paperData.sections?.abstract || '')
    .find((sentence) => /\b(?:key innovation|framework|mechanism|budget|dynamic mode switching|thinking mode|non-thinking mode)\b/i.test(sentence));
  if (innovationSentence) {
    return {
      text: cleanAnalysisText(innovationSentence),
      evidenceRefs: findEvidenceRefs(innovationSentence, facts, ['claim', 'result'], 2)
    };
  }

  const noveltyFirst = cleanedClaims.find((item) =>
    normalizeForMatch(item.text) !== normalizeForMatch(oneSentenceText)
    && /\b(?:introduce|present|propose|develop)\b/i.test(item.text)
  );
  if (noveltyFirst) {
    return noveltyFirst;
  }

  const fallbackClaim = cleanedClaims.find((item) =>
    normalizeForMatch(item.text) !== normalizeForMatch(oneSentenceText)
  );
  if (fallbackClaim) {
    return fallbackClaim;
  }

  return emptyField();
}

function contributionFromResult(row) {
  if (row.metric === 'Parameter scale') {
    return `${row.benchmark} spans ${row.value} parameters.`;
  }

  if (row.metric === 'Language coverage') {
    return `${row.benchmark} expands multilingual support to ${row.value}.`;
  }

  if (row.metric === 'Benchmark performance') {
    return `${row.value} on ${row.benchmark}.`;
  }

  return `${row.metric}: ${row.value} on ${row.benchmark}.`;
}

function buildContributions(facts, resultsTable, oneSentenceText, coreIdeaText) {
  const claims = Array.isArray(facts.coreClaims) ? facts.coreClaims : [];
  const claimItems = claims
    .map((claim, index) => ({
      text: cleanAnalysisText(claim.text),
      evidenceRefs: [`claim:${index}`]
    }))
    .filter((item) => item.text)
    .filter((item) => scoreTokenOverlap(item.text, oneSentenceText) < 0.95)
    .filter((item) => scoreTokenOverlap(item.text, coreIdeaText) < 0.95);

  const resultItems = (resultsTable || []).map((row) => ({
    text: contributionFromResult(row),
    evidenceRefs: row.evidenceRefs
  }));

  return uniqBy([...claimItems, ...resultItems], (item) => normalizeForMatch(item.text)).slice(0, 4);
}

function buildLimitations(facts) {
  const limitations = Array.isArray(facts.limitations) ? facts.limitations : [];
  return limitations
    .map((item, index) => ({
      text: cleanAnalysisText(item.text),
      evidenceRefs: [`limitation:${index}`]
    }))
    .filter((item) => item.text)
    .filter((item) => /\b(?:however|limitation|remain|challenge|risk|unsolved|future work|trade-off)\b/i.test(item.text))
    .filter((item) => !/\b(?:minimizing the risk|we have also addressed)\b/i.test(item.text))
    .slice(0, 3);
}

function buildOpenQuestions(limitations) {
  return limitations.slice(0, 3).map((item) => ({
    text: /\bfuture work\b/i.test(item.text)
      ? 'What should future work explore next?'
      : `How can future work address: ${item.text.replace(/^However,\s*/i, '').replace(/[.?!]+$/, '')}?`,
    evidenceRefs: item.evidenceRefs
  }));
}

export function validateAnalysisWithFacts(analysis, facts) {
  const validRefs = new Set(factCatalog(facts).map((item) => item.ref));
  const errors = [];

  function checkRefs(refs, label) {
    (refs || []).forEach((ref) => {
      if (!validRefs.has(ref)) {
        errors.push(`${label} has invalid evidence ref: ${ref}`);
      }
    });
  }

  checkRefs(analysis.oneSentence?.evidenceRefs, 'oneSentence');
  checkRefs(analysis.problem?.evidenceRefs, 'problem');
  checkRefs(analysis.coreIdea?.evidenceRefs, 'coreIdea');
  (analysis.contributions || []).forEach((item, index) => checkRefs(item.evidenceRefs, `contributions[${index}]`));
  (analysis.resultsTable || []).forEach((item, index) => checkRefs(item.evidenceRefs, `resultsTable[${index}]`));
  (analysis.limitations || []).forEach((item, index) => checkRefs(item.evidenceRefs, `limitations[${index}]`));
  (analysis.openQuestions || []).forEach((item, index) => checkRefs(item.evidenceRefs, `openQuestions[${index}]`));

  return {
    valid: errors.length === 0,
    errors
  };
}

export function buildAnalysisFromArtifacts(paperData, facts) {
  const oneSentence = chooseOneSentence(paperData, facts);
  const problem = chooseProblem(paperData, facts);
  const coreIdea = chooseCoreIdea(paperData, facts, oneSentence.text);
  const resultsTable = buildResultsTable(paperData, facts);
  const contributions = buildContributions(facts, resultsTable, oneSentence.text, coreIdea.text);
  const limitations = buildLimitations(facts);
  const openQuestions = buildOpenQuestions(limitations);

  const analysis = {
    paperSlug: paperData.paperSlug,
    parserVersion: paperData.parserVersion,
    analysisVersion: ANALYSIS_VERSION,
    generatedAt: new Date().toISOString(),
    oneSentence,
    problem,
    coreIdea,
    contributions,
    resultsTable,
    limitations,
    openQuestions
  };

  const validation = validateAnalysisWithFacts(analysis, facts);
  if (!validation.valid) {
    throw new Error(`Invalid analysis output: ${validation.errors.join('; ')}`);
  }

  return analysis;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePaperDir(input) {
  if (!input) {
    throw new Error('Prepared paper path or slug is required');
  }

  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) {
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  }

  return path.join(PAPERS_ROOT, input);
}

export function buildAnalysisForPaperDir(input) {
  const paperDir = resolvePaperDir(input);
  const paperDataPath = path.join(paperDir, 'paper-data.json');
  const factsPath = path.join(paperDir, 'facts.json');
  const analysisPath = path.join(paperDir, 'analysis.json');

  if (!fs.existsSync(paperDataPath)) {
    throw new Error(`Missing paper-data.json: ${paperDataPath}`);
  }

  if (!fs.existsSync(factsPath)) {
    throw new Error(`Missing facts.json: ${factsPath}`);
  }

  const paperData = readJsonFile(paperDataPath);
  const facts = readJsonFile(factsPath);
  const analysis = buildAnalysisFromArtifacts(paperData, facts);

  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

  return {
    paperDir,
    analysisPath,
    paperSlug: paperData.paperSlug,
    analysis
  };
}

async function runCli() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node build-analysis.js <paper-slug-or-paper-dir>');
    process.exit(1);
  }

  const result = buildAnalysisForPaperDir(input);
  process.stdout.write(`${JSON.stringify({
    paperSlug: result.paperSlug,
    paperDir: result.paperDir,
    analysisPath: result.analysisPath,
    analysisVersion: result.analysis.analysisVersion
  }, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    console.error(`Error building analysis: ${error.message}`);
    process.exit(1);
  });
}
