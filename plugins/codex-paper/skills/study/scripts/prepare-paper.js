import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parsePdfDetailed } from './parse-pdf.js';
import { buildAnalysisFromArtifacts } from './build-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');
const INDEX_PATH = path.join(LIBRARY_ROOT, 'index.json');

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

function buildEvidenceItem(section, text) {
  return {
    section,
    quote: text
  };
}

function extractCoreClaims(parsed) {
  const candidates = [];
  const claimSections = [
    ['abstract', parsed.sections.abstract],
    ['introduction', parsed.sections.introduction],
    ['conclusion', parsed.sections.conclusion]
  ];

  for (const [section, content] of claimSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b(?:introduce|propose|present|show|demonstrate|develop|our approach|this paper)\b/i.test(sentence));
    for (const sentence of sentences) {
      candidates.push({
        text: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  if (candidates.length === 0 && parsed.sections.abstract) {
    const firstSentence = splitSentences(parsed.sections.abstract)[0];
    if (firstSentence) {
      candidates.push({
        text: firstSentence,
        evidence: buildEvidenceItem('abstract', firstSentence)
      });
    }
  }

  return candidates;
}

function extractKeyResults(parsed) {
  const candidates = [];
  const resultSections = [
    ['abstract', parsed.sections.abstract],
    ['conclusion', parsed.sections.conclusion]
  ];

  for (const [section, content] of resultSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b\d+(?:\.\d+)?\b/.test(sentence) || /\b(?:outperform|improve|benchmark|state-of-the-art|languages|billion|million)\b/i.test(sentence));
    for (const sentence of sentences) {
      const valueMatch = sentence.match(/\b\d+(?:\.\d+)?(?:\s?(?:%|percent|points?|languages?|billion|million|hours?|x))?\b/i);
      const labelMatch = sentence.match(/\b(?:accuracy|score|benchmark|languages|parameters|performance|efficiency|improvement)\b/i);
      candidates.push({
        label: labelMatch ? labelMatch[0] : `Result ${candidates.length + 1}`,
        value: valueMatch ? valueMatch[0] : 'See evidence',
        context: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  return candidates;
}

function extractLimitations(parsed) {
  const candidates = [];
  const limitationSections = [
    ['conclusion', parsed.sections.conclusion],
    ['abstract', parsed.sections.abstract],
    ['introduction', parsed.sections.introduction]
  ];

  for (const [section, content] of limitationSections) {
    const sentences = splitSentences(content).filter((sentence) => /\b(?:however|limitation|future work|remain|challenge|unstable|risk)\b/i.test(sentence));
    for (const sentence of sentences) {
      candidates.push({
        text: sentence,
        evidence: buildEvidenceItem(section, sentence)
      });
      if (candidates.length >= 3) {
        return candidates;
      }
    }
  }

  return candidates;
}

function buildFacts(paperSlug, parsed) {
  return {
    paperSlug,
    parserVersion: parsed.parserVersion,
    coreClaims: extractCoreClaims(parsed),
    keyResults: extractKeyResults(parsed),
    limitations: extractLimitations(parsed)
  };
}

function resolveInput(input) {
  if (/^https?:\/\//i.test(input)) {
    const scriptPath = path.join(__dirname, 'download-pdf.cjs');
    const output = execFileSync(process.execPath, [scriptPath, input], {
      encoding: 'utf8'
    }).trim();

    return {
      inputPath: output.split('\n').pop().trim(),
      sourceUrl: input
    };
  }

  return {
    inputPath: path.resolve(input),
    sourceUrl: null
  };
}

function readIndexPreserveShape() {
  if (!fs.existsSync(INDEX_PATH)) {
    return {
      raw: [],
      papers: [],
      isArray: true
    };
  }

  const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  if (Array.isArray(raw)) {
    return {
      raw,
      papers: raw,
      isArray: true
    };
  }

  return {
    raw,
    papers: Array.isArray(raw.papers) ? raw.papers : [],
    isArray: false
  };
}

function writeIndexPreserveShape(indexState) {
  if (indexState.isArray) {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(indexState.papers, null, 2));
    return;
  }

  indexState.raw.papers = indexState.papers;
  fs.writeFileSync(INDEX_PATH, JSON.stringify(indexState.raw, null, 2));
}

export async function preparePaper(userInput) {
  if (!userInput) {
    throw new Error('Paper input is required');
  }

  ensureDir(PAPERS_ROOT);

  const { inputPath, sourceUrl } = resolveInput(userInput);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`PDF not found: ${inputPath}`);
  }

  const parsed = await parsePdfDetailed(inputPath);
  const sourceFilename = path.basename(inputPath);
  const paperSlug = slugify(parsed.title || path.basename(inputPath, path.extname(inputPath)));
  const paperDir = path.join(PAPERS_ROOT, paperSlug);
  const today = new Date().toISOString().slice(0, 10);

  ensureDir(paperDir);

  const paperData = {
    paperSlug,
    sourceFilename,
    sourceUrl,
    preparedAt: new Date().toISOString(),
    title: parsed.title,
    authors: parsed.authors,
    abstract: parsed.abstract,
    pageCount: parsed.pageCount,
    year: parsed.year,
    githubLinks: parsed.githubLinks,
    codeLinks: parsed.codeLinks,
    sections: parsed.sections,
    warnings: parsed.warnings,
    qualityFlags: parsed.qualityFlags,
    parserVersion: parsed.parserVersion,
    rawText: parsed.rawText
  };

  const facts = buildFacts(paperSlug, parsed);
  const analysis = buildAnalysisFromArtifacts(paperData, facts);
  const meta = {
    title: parsed.title,
    slug: paperSlug,
    authors: parsed.authors,
    abstract: parsed.abstract,
    year: parsed.year,
    date: today,
    tags: [],
    githubLinks: parsed.githubLinks,
    codeLinks: parsed.codeLinks,
    sourceFilename,
    parserVersion: parsed.parserVersion,
    qualityFlags: parsed.qualityFlags,
    url: sourceUrl
  };

  const indexEntry = {
    id: paperSlug,
    title: parsed.title,
    slug: paperSlug,
    authors: parsed.authors,
    abstract: parsed.abstract,
    year: parsed.year,
    date: today,
    tags: [],
    githubLinks: parsed.githubLinks,
    codeLinks: parsed.codeLinks,
    sourceFilename,
    parserVersion: parsed.parserVersion,
    qualityFlags: parsed.qualityFlags,
    url: sourceUrl
  };

  fs.copyFileSync(inputPath, path.join(paperDir, 'paper.pdf'));
  fs.writeFileSync(path.join(paperDir, 'paper-data.json'), JSON.stringify(paperData, null, 2));
  fs.writeFileSync(path.join(paperDir, 'facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(paperDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const indexState = readIndexPreserveShape();
  const existingIndex = indexState.papers.findIndex((paper) => paper.slug === paperSlug);
  if (existingIndex >= 0) {
    indexState.papers[existingIndex] = {
      ...indexState.papers[existingIndex],
      ...indexEntry
    };
  } else {
    indexState.papers.push(indexEntry);
  }
  writeIndexPreserveShape(indexState);

  return {
    paperSlug,
    paperDir,
    inputPath,
    sourceFilename,
    paperData,
    facts,
    analysis
  };
}

async function runCli() {
  const userInput = process.argv[2];
  if (!userInput) {
    console.error('Usage: node prepare-paper.js <pdf-path-or-url>');
    process.exit(1);
  }

  const result = await preparePaper(userInput);
  process.stdout.write(`${JSON.stringify({
    paperSlug: result.paperSlug,
    paperDir: result.paperDir,
    sourceFilename: result.sourceFilename,
    parserVersion: result.paperData.parserVersion,
    analysisVersion: result.analysis.analysisVersion
  }, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    console.error(`Error preparing paper: ${error.message}`);
    process.exit(1);
  });
}
