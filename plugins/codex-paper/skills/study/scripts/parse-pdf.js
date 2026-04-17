import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import pdf from 'pdf-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '../../..');
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json');
const PARSER_VERSION = readParserVersion();

function readParserVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
    return manifest.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function cleanLine(value) {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeInline(value) {
  return normalizeText(value).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeSplitLines(value) {
  return normalizeText(value)
    .split('\n')
    .map(cleanLine)
    .filter(Boolean);
}

function cleanLink(link) {
  return link.replace(/[)>.,;:]+$/g, '');
}

function parseYear(...values) {
  const years = [];
  for (const value of values) {
    const matches = String(value || '').match(/\b(?:19|20)\d{2}\b/g) || [];
    for (const match of matches) {
      const year = Number(match);
      if (year >= 1900 && year <= 2100) {
        years.push(year);
      }
    }
  }

  return years.length > 0 ? Math.max(...years) : null;
}

function looksLikeUrlOrEmail(line) {
  return /https?:\/\/|www\.|@/i.test(line);
}

function looksLikeInstitution(line) {
  return /\b(?:university|institute|laboratory|lab|school|department|college|research|tongyi|alibaba|meituan|fudan|peking|tsinghua|inc\.|corp\.|company)\b/i.test(line);
}

function looksLikeSectionHeading(line) {
  return /^(?:\d+(?:\.\d+)?\s*)?(?:abstract|introduction|conclusion|conclusions|references|appendix|acknowledg(?:e)?ments?)\b/i.test(line);
}

function isPureMarkerLine(line) {
  return /^[\d\s*†‡,.;:()[\]\-]+$/.test(line);
}

function cleanTitlePunctuation(value) {
  return value
    .replace(/\s+([,:;?!])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function rejectTitleLine(line) {
  if (!line) return true;
  if (line.length < 6) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(line)) return true;
  if (/^arxiv:/i.test(line)) return true;
  if (/^\[.*\]$/.test(line)) return true;
  if (/^\d+$/.test(line)) return true;
  if (/^(?:abstract|introduction|conclusion|references|appendix)$/i.test(line)) return true;
  if (looksLikeUrlOrEmail(line)) return true;
  if (looksLikeInstitution(line)) return true;
  return false;
}

function extractNamesFromText(text) {
  const cleaned = text
    .replace(/\u0000/g, ' ')
    .replace(/[*†‡]/g, ' ')
    .replace(/[()[\]]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const names = [];
  const teamMatches = cleaned.match(/\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2}\s+Team\b/g) || [];
  names.push(...teamMatches);

  const personRegex = /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,3}\b/g;
  const personMatches = cleaned.match(personRegex) || [];
  names.push(...personMatches);

  return uniq(
    names
      .map(cleanLine)
      .filter((name) => name.length >= 5)
      .filter((name) => !looksLikeInstitution(name))
      .filter((name) => !looksLikeSectionHeading(name))
      .filter((name) => !looksLikeUrlOrEmail(name))
  );
}

function looksLikeAuthorBlock(block) {
  const names = extractNamesFromText(block);
  if (names.length === 0) return false;
  if (/\bTeam\b/.test(block)) return true;
  if (names.length >= 2) return true;
  return /[,*†‡]|\b\d+\b|\n/.test(block)
    && !looksLikeInstitution(block)
    && !looksLikeSectionHeading(block)
    && !looksLikeUrlOrEmail(block);
}

function buildTitleFromBlocks(blocks, metadataTitle, fallbackTitle) {
  const cleanedMetadataTitle = cleanTitlePunctuation(cleanLine(metadataTitle || ''));
  if (cleanedMetadataTitle && !rejectTitleLine(cleanedMetadataTitle)) {
    const matchedIndex = blocks.findIndex((block) => normalizeForMatch(block) === normalizeForMatch(cleanedMetadataTitle));
    return {
      title: cleanedMetadataTitle,
      titleBlockEnd: matchedIndex,
      usedFallback: false
    };
  }

  const startIndex = blocks.findIndex((block) => !rejectTitleLine(block));
  if (startIndex !== -1) {
    const titleParts = [blocks[startIndex]];
    let endIndex = startIndex;

    for (let index = startIndex + 1; index < Math.min(blocks.length, startIndex + 3); index += 1) {
      const nextBlock = blocks[index];
      if (!nextBlock || rejectTitleLine(nextBlock) || looksLikeAuthorBlock(nextBlock) || looksLikeSectionHeading(nextBlock) || looksLikeInstitution(nextBlock) || looksLikeUrlOrEmail(nextBlock)) {
        break;
      }
      titleParts.push(nextBlock);
      endIndex = index;
    }

    return {
      title: cleanTitlePunctuation(titleParts.join(' ')),
      titleBlockEnd: endIndex,
      usedFallback: false
    };
  }

  return {
    title: cleanTitlePunctuation(fallbackTitle),
    titleBlockEnd: -1,
    usedFallback: true
  };
}

function extractAuthors(blocks, titleBlockEnd, metadataAuthor) {
  const authorWindow = [];
  const startIndex = titleBlockEnd >= 0 ? titleBlockEnd + 1 : 0;

  for (let index = startIndex; index < Math.min(blocks.length, startIndex + 12); index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (/^abstract$/i.test(block) || looksLikeSectionHeading(block)) break;
    if (looksLikeUrlOrEmail(block) && authorWindow.length > 0) break;
    if (looksLikeInstitution(block) && authorWindow.length > 0) break;
    if (isPureMarkerLine(block)) continue;
    authorWindow.push(block);
  }

  let authors = extractNamesFromText(authorWindow.join(' '));
  let lowConfidence = authors.length === 0;

  if (authors.length === 0 && metadataAuthor) {
    authors = extractNamesFromText(metadataAuthor);
    lowConfidence = true;
  }

  if (authors.some((author) => /\b\w+\s+\w+/.test(author) || /Team$/i.test(author))) {
    lowConfidence = false;
  }

  return {
    authors,
    lowConfidence
  };
}

function findHeadingIndex(text, names, fromIndex = 0) {
  const pattern = names.map(escapeRegExp).join('|');
  const regex = new RegExp(`(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*)?\\s*(?:${pattern})\\b[\\s:.-]*`, 'i');
  const slice = text.slice(fromIndex);
  const match = slice.match(regex);

  if (!match || match.index == null) {
    return null;
  }

  return {
    start: fromIndex + match.index,
    end: fromIndex + match.index + match[0].length
  };
}

function extractSectionBetween(text, startNames, endNames) {
  const start = findHeadingIndex(text, startNames);
  if (!start) return '';

  let end = text.length;
  for (const group of endNames) {
    const next = findHeadingIndex(text, group, start.end);
    if (next && next.start < end) {
      end = next.start;
    }
  }

  return normalizeInline(text.slice(start.end, end));
}

function extractAbstractFromBlocks(blocks) {
  const abstractIndex = blocks.findIndex((block) => /^abstract$/i.test(block));
  if (abstractIndex === -1) {
    return '';
  }

  const abstractBlocks = [];
  for (let index = abstractIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (looksLikeSectionHeading(block)) break;
    if (/^figure\s+\d+/i.test(block) || /^table\s+\d+/i.test(block)) break;
    abstractBlocks.push(block);
  }

  return normalizeInline(abstractBlocks.join(' ')).trim();
}

function extractAbstract(text, blocks) {
  const fromBlocks = extractAbstractFromBlocks(blocks);
  if (fromBlocks) {
    return fromBlocks;
  }

  const abstract = extractSectionBetween(text, ['Abstract'], [
    ['Introduction'],
    ['Background'],
    ['Related Work'],
    ['Methods'],
    ['Approach'],
    ['Model'],
    ['Preliminaries']
  ]);

  return abstract.split(/\bFigure\s+\d+\b/i)[0].split(/\bTable\s+\d+\b/i)[0].trim();
}

function extractSections(text, abstract) {
  const introduction = extractSectionBetween(text, ['Introduction'], [
    ['Related Work'],
    ['Background'],
    ['Methods'],
    ['Method'],
    ['Approach'],
    ['Model'],
    ['Experiments'],
    ['Training'],
    ['Results'],
    ['Conclusion'],
    ['Conclusions']
  ]);

  const conclusion = extractSectionBetween(text, ['Conclusion', 'Conclusions', 'Discussion and Conclusion'], [
    ['Acknowledgments', 'Acknowledgements'],
    ['References'],
    ['Appendix']
  ]);

  return {
    abstract,
    introduction,
    conclusion
  };
}

function extractLinks(text) {
  const rawLinks = text.match(/https?:\/\/[^\s)]+/g) || [];
  const cleanedLinks = uniq(rawLinks.map(cleanLink));
  const githubLinks = cleanedLinks.filter((link) => /github\.com/i.test(link));
  const codeLinks = cleanedLinks.filter((link) => {
    if (githubLinks.includes(link)) return false;
    return /(?:huggingface\.co|modelscope\.cn|paperswithcode\.com|openreview\.net\/code|codeocean\.com|4open\.science|arxiv\.org\/(?:src|abs|pdf))/i.test(link);
  });

  return {
    githubLinks,
    codeLinks
  };
}

function collectWarnings(...chunks) {
  return uniq(
    chunks
      .flatMap((chunk) => String(chunk || '').split('\n'))
      .map(cleanLine)
      .filter(Boolean)
  );
}

function readWithPyMuPdf(pdfPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-parser-'));
  const outputPath = path.join(tempDir, 'raw.json');
  const script = `
import json
import sys
import fitz

doc = fitz.open(sys.argv[1])
payload = {
    "metadata": doc.metadata or {},
    "pageCount": len(doc),
    "firstPageBlocks": [],
    "pages": []
}

if len(doc) > 0:
    for block in doc[0].get_text("blocks"):
        text = str(block[4]).replace("\\x00", " ").strip()
        if text:
            payload["firstPageBlocks"].append(text)

for page in doc:
    payload["pages"].append(page.get_text("text").replace("\\x00", " "))

with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False)
`;

  const result = spawnSync('python3', ['-c', script, pdfPath, outputPath], {
    encoding: 'utf8'
  });

  const warnings = collectWarnings(result.stdout, result.stderr);

  if (result.status !== 0) {
    throw new Error(warnings.join(' | ') || 'PyMuPDF extraction failed');
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('PyMuPDF extraction did not produce output');
  }

  try {
    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    return {
      raw,
      warnings
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function capturePdfParseOutput(dataBuffer) {
  let capturedStdout = '';
  let capturedStderr = '';
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    capturedStdout += value;
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  process.stderr.write = ((chunk, encoding, callback) => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    capturedStderr += value;
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    const result = await pdf(dataBuffer);
    return {
      result,
      capturedStdout,
      capturedStderr
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function extractRawPdfData(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parserWarnings = [];

  try {
    const { raw, warnings } = readWithPyMuPdf(pdfPath);
    return {
      metadata: raw.metadata || {},
      pageCount: raw.pageCount || 0,
      firstPageBlocks: (raw.firstPageBlocks || []).map(cleanLine).filter(Boolean),
      pages: raw.pages || [],
      warnings: warnings || parserWarnings
    };
  } catch (error) {
    parserWarnings.push(`PyMuPDF unavailable: ${error.message}`);
  }

  const { result, capturedStdout, capturedStderr } = await capturePdfParseOutput(dataBuffer);
  const warnings = parserWarnings.concat(collectWarnings(capturedStdout, capturedStderr));
  const lines = safeSplitLines(result.text || '');

  return {
    metadata: result.info || {},
    pageCount: result.numpages || 0,
    firstPageBlocks: lines.slice(0, 12),
    pages: [result.text || ''],
    warnings
  };
}

function buildFallbackTitle(pdfPath) {
  const stem = path.basename(pdfPath, path.extname(pdfPath));
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildFactsTextSource(pages) {
  return normalizeText(pages.join('\n\n'));
}

export async function parsePdfDetailed(pdfPath) {
  if (!pdfPath) {
    throw new Error('PDF path is required');
  }

  const source = await extractRawPdfData(pdfPath);
  const rawText = buildFactsTextSource(source.pages);
  const firstPageBlocks = source.firstPageBlocks.map(cleanLine).filter(Boolean);
  const firstPageLines = uniq([
    ...firstPageBlocks.flatMap((block) => safeSplitLines(block)),
    ...safeSplitLines(source.pages[0] || '').slice(0, 40)
  ]);

  const titleInfo = buildTitleFromBlocks(
    firstPageBlocks,
    source.metadata?.title || source.metadata?.Title,
    buildFallbackTitle(pdfPath)
  );
  const authorInfo = extractAuthors(
    firstPageBlocks,
    titleInfo.titleBlockEnd,
    source.metadata?.author || source.metadata?.Author
  );
  const abstract = extractAbstract(rawText, firstPageBlocks);
  const sections = extractSections(rawText, abstract);
  const { githubLinks, codeLinks } = extractLinks(rawText);
  const year = parseYear(
    source.metadata?.creationDate,
    source.metadata?.CreationDate,
    source.metadata?.modDate,
    source.metadata?.ModDate,
    firstPageLines.slice(0, 8).join(' ')
  );

  const qualityFlags = [];
  if (titleInfo.usedFallback) qualityFlags.push('title_from_fallback');
  if (authorInfo.lowConfidence) qualityFlags.push('authors_low_confidence');
  if (!abstract) qualityFlags.push('abstract_missing');
  if (!sections.abstract || !sections.introduction || !sections.conclusion) qualityFlags.push('sections_partial');
  if (githubLinks.length === 0 && codeLinks.length === 0) qualityFlags.push('links_missing');

  const publicData = {
    title: titleInfo.title,
    authors: authorInfo.authors,
    abstract,
    pageCount: source.pageCount,
    year,
    githubLinks,
    codeLinks,
    sections,
    warnings: uniq(source.warnings),
    qualityFlags,
    parserVersion: PARSER_VERSION
  };

  return {
    ...publicData,
    rawText
  };
}

export async function parsePdf(pdfPath) {
  const detailed = await parsePdfDetailed(pdfPath);
  const { rawText: _rawText, ...publicData } = detailed;
  return publicData;
}

async function runCli() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node parse-pdf.js <pdf-path>');
    process.exit(1);
  }

  const result = await parsePdf(pdfPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    console.error(`Error parsing PDF: ${error.message}`);
    process.exit(1);
  });
}
