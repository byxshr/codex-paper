#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { validateReasoningPackage } from './validate-reasoning.js';
import { REQUIRED_REFLECTION_HEADINGS } from '../profiles/profile-rules.js';

const REQUIRED_FILES = [
  'README.md',
  'visual-assets.md',
  'summary.md',
  'insights.md',
  'method.md',
  'mental-model.md',
  'reflection.md',
  'qa.md',
  'index.html',
  'paper.pdf'
];

const MARKDOWN_FILES = [
  'README.md',
  'visual-assets.md',
  'summary.md',
  'insights.md',
  'method.md',
  'mental-model.md',
  'reflection.md',
  'qa.md'
];

const USER_VISIBLE_TEXT_FILES = [
  ...MARKDOWN_FILES,
  'index.html'
];

const FORBIDDEN_RESIDUES = [
  /\banalysisVersion\b/i,
  /\bevidenceRefs\b/i,
  /\bcoreClaims\b/i,
  /\bkeyResults\b/i,
  /\bopenQuestions\b/i,
  /\bsourceType\b/i,
  /\bparserVersion\b/i,
  /\bpaperSlug\b/i,
  /\brawText\b/i,
  /\bevidence-ledger(?:\.json)?\b/i,
  /\breasoning-analysis(?:\.json)?\b/i,
  /\bev-p\d{3,}-[a-z]+-[a-f0-9]{10}\b/i,
  /\bext-[a-zA-Z0-9._-]+\b/i,
  // Machine references such as "claim:3"; natural prose like "Result 1" is allowed.
  /\b(?:claim|result|limitation):\d+\b/i,
  /^\s*"[^"]+"\s*:\s*[{["0-9tfn-]/i
];

const QA_LEVELS = [
  { key: 'basic', labels: ['basic', '基础'] },
  { key: 'intermediate', labels: ['intermediate', '中级'] },
  { key: 'advanced', labels: ['advanced', '高级'] }
];

const EMBEDDED_VISUAL_FILES = [
  'README.md',
  'summary.md',
  'method.md'
];

const SOURCE_MARKER = /(?:来源|源自|图\s*\d*|表\s*\d*|第\s*\d+\s*页|页码|章节|节|附录|source|figure|fig\.?|table|page|section|appendix|explanatory redraw|teaching redraw|教学重绘|解释性图解)/i;
const VISUAL_VALUE_MARKER = /(?:帮助|理解|说明|展示|对比|定位|读图|学习价值|用途|推荐|clarif|helps|shows|illustrates|maps|compares|reading|placement|useful|why it matters)/i;
const NO_USEFUL_VISUALS = /(?:无可用|没有可用|未发现|缺少|不足以|图表质量不足|低置信|no useful|no high-value|not enough|unavailable|insufficient|limited visual)/i;
const METHOD_OVERVIEW_MARKER = /(?:pipeline|method|mechanism|architecture|formula|benchmark|dashboard|stage|training|agent loop|overview|流程|方法|机制|架构|公式|基准|结果|阶段|训练|总览|探索器)/i;
const IMAGEGEN_RESIDUE = /(?:\bimagegen\b|\bgenerated_images\b|\bgenerated_pipeline\b|\bgenerated_cover\b|concept poster|AI-generated image|Codex image generation|图片生成提示词|Codex\s*图片生成|生成式封面|概念海报)/i;
const PREVIEW_ASSET_MARKER = /(?:page[_-]?preview|preview|navigation[_-]?only|page[_-]?\d{1,4}[_-]?preview|页面预览|整页预览|page preview)/i;
const NAVIGATION_ONLY_MARKER = /(?:navigation[- ]only|navigation only|仅为定位|定位页预览|只用于定位|仅用于定位|不进入正文|不要插入正文|not for body|not embedded|not inserted|body prose)/i;
const BODY_IMAGE_MIN_WIDTH = 600;
const BODY_IMAGE_MIN_HEIGHT = 220;
const BODY_IMAGE_MIN_PIXELS = 160000;

function usage() {
  console.error('Usage: node validate-study-package.js <paper-slug-or-dir> [--lang zh|en] [--run-code|--run-artifacts] [--legacy-ok] [--timeout-ms 20000]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    lang: null,
    runCode: false,
    legacyOk: false,
    timeoutMs: 20000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lang') {
      args.lang = argv[index + 1];
      index += 1;
    } else if (arg === '--run-code' || arg === '--run-artifacts') {
      args.runCode = true;
    } else if (arg === '--legacy-ok') {
      args.legacyOk = true;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error('Missing paper slug or directory.');
  }

  if (args.lang && !['zh', 'en'].includes(args.lang)) {
    throw new Error('--lang must be zh or en.');
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }

  return args;
}

function resolvePaperDir(input) {
  const expanded = input.replace(/^~(?=$|\/)/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    return fs.statSync(direct).isDirectory() ? direct : path.dirname(direct);
  }

  return path.join(os.homedir(), 'codex-papers', 'papers', input);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function extractMarkdownImageRefs(text) {
  const refs = [];
  const markdownPattern = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
  let match;

  while ((match = markdownPattern.exec(text))) {
    const rawTarget = match[2].trim().replace(/^<|>$/g, '');
    const target = rawTarget.replace(/\s+["'][^"']*["']\s*$/, '').trim();
    refs.push({
      target,
      alt: match[1].trim(),
      lineNumber: lineNumberAt(text, match.index)
    });
  }

  const htmlPattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlPattern.exec(text))) {
    refs.push({
      target: match[1].trim(),
      alt: '',
      lineNumber: lineNumberAt(text, match.index)
    });
  }

  return refs;
}

function resolveImageTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    return { kind: 'empty', target };
  }

  if (/^(?:https?:|data:|mailto:)/i.test(target)) {
    return { kind: 'external', target };
  }

  if (target.startsWith('/api/papers/') && target.includes('path=')) {
    try {
      const url = new URL(target, 'http://codex-paper.local');
      const embeddedPath = url.searchParams.get('path');
      if (embeddedPath) {
        return { kind: 'local', target: decodeURIComponent(embeddedPath.replace(/#.*$/, '')) };
      }
    } catch {
      return { kind: 'invalid', target };
    }
  }

  if (target.startsWith('/')) {
    return { kind: 'absolute', target };
  }

  try {
    return { kind: 'local', target: decodeURIComponent(target.replace(/#.*$/, '')) };
  } catch {
    return { kind: 'invalid', target };
  }
}

function hasMarkdownTable(text) {
  return /^\s*\|.+\|\s*$/m.test(text) && /^\s*\|[\s:-]+\|\s*$/m.test(text);
}

function hasDeterministicDiagram(text) {
  return /(?:```mermaid|<svg\b|<canvas\b|Mermaid|SVG|HTML\s+diagram|结构化表格|教学重绘|解释性图解|Explanatory redraw)/i.test(text);
}

function extractImagePathMentions(text) {
  const mentions = [];
  const pattern = /`([^`\n]+\.(?:png|jpe?g|gif|webp|bmp|svg))`/gi;
  let match;
  while ((match = pattern.exec(text))) {
    mentions.push({
      target: match[1].trim(),
      lineNumber: lineNumberAt(text, match.index)
    });
  }
  return mentions;
}

function readImageDimensions(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) {
    return null;
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      if (!Number.isFinite(length) || length < 2) {
        break;
      }
      offset += 2 + length;
    }
  }

  return null;
}

function isLikelyFullPagePreview(dimensions) {
  if (!dimensions) {
    return false;
  }

  const { width, height } = dimensions;
  if (width <= 0 || height <= 0) {
    return false;
  }

  const aspect = width / height;
  return aspect >= 0.70 && aspect <= 0.82 && Math.max(width, height) >= 700;
}

function isSuspiciousOverCrop(dimensions) {
  if (!dimensions) {
    return false;
  }

  const { width, height } = dimensions;
  if (width <= 0 || height <= 0) {
    return false;
  }

  const aspect = width / height;
  return width >= 1200 && height >= 850 && aspect <= 1.85;
}

function stripMarkdownNoise(text) {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ');
}

function stripMarkdownMachineScanNoise(text) {
  return stripMarkdownNoise(text)
    .replace(/^ {0,3}~~~[\s\S]*?^ {0,3}~~~/gm, '\n');
}

function stripHtmlNoise(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

function visibleTextForLanguage(filename, text) {
  if (/\.html?$/i.test(filename)) {
    return stripHtmlNoise(text);
  }
  return stripMarkdownNoise(text);
}

function countCjk(text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

function countLatinWords(text) {
  return (text.match(/[A-Za-z][A-Za-z0-9_+@./-]*/g) || []).length;
}

function suspiciousEnglishLines(text) {
  return stripMarkdownNoise(text)
    .split('\n')
    .map((line, index) => ({
      lineNumber: index + 1,
      line: line.trim(),
      cjk: countCjk(line),
      latinWords: countLatinWords(line)
    }))
    .filter((item) => item.line && item.latinWords >= 12 && item.cjk < 4)
    .slice(0, 5);
}

function addFinding(findings, level, message) {
  findings[level].push(message);
}

function isV2Package(paperDir) {
  const meta = readJsonIfExists(path.join(paperDir, 'meta.json'));
  return meta?.packageVersion === '2.0.0'
    || fs.existsSync(path.join(paperDir, 'reasoning-analysis.json'))
    || fs.existsSync(path.join(paperDir, 'evidence-ledger.json'));
}

function checkReasoningLayer(paperDir, args, findings) {
  if (!isV2Package(paperDir)) {
    const message = args.legacyOk
      ? 'Legacy v1 package: v2 reasoning validation was skipped because --legacy-ok was provided.'
      : 'Legacy v1 package: v2 reasoning files are absent; existing package checks continue.';
    addFinding(findings, 'warnings', message);
    return;
  }

  const result = validateReasoningPackage(paperDir, { strict: false });
  for (const error of result.report.errors) {
    addFinding(findings, 'errors', `Reasoning ${error.code} at ${error.path}: ${error.message}`);
  }
  for (const warning of result.report.warnings) {
    addFinding(findings, 'warnings', `Reasoning ${warning.code} at ${warning.path}: ${warning.message}`);
  }
}

function checkRequiredFiles(paperDir, findings) {
  for (const filename of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(paperDir, filename))) {
      addFinding(findings, 'errors', `Missing required file: ${filename}`);
    }
  }

  const codeDir = path.join(paperDir, 'code');
  if (!fs.existsSync(codeDir) || !fs.statSync(codeDir).isDirectory()) {
    addFinding(findings, 'errors', 'Missing required code/ directory.');
    return [];
  }

  const codeFiles = fs.readdirSync(codeDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => fs.statSync(path.join(codeDir, name)).isFile());

  if (codeFiles.length === 0) {
    addFinding(findings, 'errors', 'code/ exists but contains no demo files.');
  }

  const genericNames = new Set(['demo.py', 'model_demo.py', 'demo.js', 'main.py']);
  for (const codeFile of codeFiles) {
    if (genericNames.has(codeFile)) {
      addFinding(findings, 'warnings', `Code demo name is generic: code/${codeFile}`);
    }
  }

  return codeFiles;
}

function checkForbiddenResidues(paperDir, findings) {
  for (const filename of USER_VISIBLE_TEXT_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const raw = readText(filePath);
    const visibleText = /\.html?$/i.test(filename) ? stripHtmlNoise(raw) : stripMarkdownMachineScanNoise(raw);
    const lines = visibleText.split('\n');
    lines.forEach((line, index) => {
      for (const pattern of FORBIDDEN_RESIDUES) {
        if (pattern.test(line)) {
          addFinding(findings, 'errors', `${filename}:${index + 1} contains machine residue matching ${pattern}`);
          break;
        }
      }
    });
  }
}

function levelForHeading(line) {
  const match = line.match(/^##\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const heading = match[1].trim().toLowerCase();
  return QA_LEVELS.find((level) => level.labels.some((label) => heading === label.toLowerCase()))?.key || null;
}

function hasQaReductionExplanation(text) {
  const firstLevelIndex = text.search(/^##\s+/m);
  const preface = firstLevelIndex >= 0 ? text.slice(0, firstLevelIndex) : text.slice(0, 800);
  return /(?:少于\s*15|缩减|减少|压缩|短论文|篇幅较短|证据有限|解析质量|内容范围|fewer than 15|short paper|limited evidence|parser quality|narrow scope)/i.test(preface);
}

function checkQa(paperDir, findings) {
  const qaPath = path.join(paperDir, 'qa.md');
  if (!fs.existsSync(qaPath)) {
    return;
  }

  const text = readText(qaPath);
  const counts = Object.fromEntries(QA_LEVELS.map((level) => [level.key, 0]));
  let currentLevel = null;

  for (const line of text.split('\n')) {
    const headingLevel = levelForHeading(line);
    if (headingLevel) {
      currentLevel = headingLevel;
      continue;
    }

    if (/^###\s+\S+/.test(line) && currentLevel) {
      counts[currentLevel] += 1;
    }
  }

  const missingLevels = QA_LEVELS.filter((level) => counts[level.key] === 0).map((level) => level.key);
  if (missingLevels.length > 0) {
    addFinding(findings, 'errors', `qa.md is missing required levels: ${missingLevels.join(', ')}`);
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const belowMinimum = QA_LEVELS.filter((level) => counts[level.key] < 3).map((level) => `${level.key}=${counts[level.key]}`);
  if (belowMinimum.length > 0) {
    addFinding(findings, 'errors', `qa.md must have at least 3 questions per level: ${belowMinimum.join(', ')}`);
  }

  if (total === 15 && QA_LEVELS.every((level) => counts[level.key] === 5)) {
    return;
  }

  if (total === 15) {
    addFinding(findings, 'errors', `qa.md has 15 questions but not 5 per level: basic=${counts.basic}, intermediate=${counts.intermediate}, advanced=${counts.advanced}`);
    return;
  }

  if (total >= 9 && total < 15 && QA_LEVELS.every((level) => counts[level.key] >= 3)) {
    if (hasQaReductionExplanation(text)) {
      addFinding(findings, 'warnings', `qa.md uses flexible QA count (${total}/15) with an explanation.`);
    } else {
      addFinding(findings, 'errors', `qa.md has ${total} questions; 9-14 requires a short explanation before the first level heading.`);
    }
    return;
  }

  addFinding(findings, 'errors', `qa.md has ${total} questions; expected 15 by default or 9-15 with at least 3 per level.`);
}

function checkLanguage(paperDir, lang, findings) {
  if (lang !== 'zh') {
    return;
  }

  for (const filename of USER_VISIBLE_TEXT_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const raw = readText(filePath);
    const visible = visibleTextForLanguage(filename, raw);
    const cjk = countCjk(visible);
    const latinWords = countLatinWords(visible);

    if (cjk === 0 || latinWords > cjk * 0.9) {
      const lines = suspiciousEnglishLines(raw)
        .map((item) => `line ${item.lineNumber}: ${item.line.slice(0, 120)}`)
        .join('; ');
      addFinding(
        findings,
        'errors',
        `${filename} does not look primarily Chinese after stripping code/tables (CJK=${cjk}, latinWords=${latinWords}).${lines ? ` Suspect lines: ${lines}` : ''}`
      );
    } else if (latinWords > cjk * 0.6) {
      addFinding(findings, 'warnings', `${filename} has a high English/proper-noun ratio (CJK=${cjk}, latinWords=${latinWords}).`);
    }
  }
}

function checkHtml(paperDir, findings) {
  const htmlPath = path.join(paperDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return;
  }

  const html = readText(htmlPath);
  const externalPatterns = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\bhref\s*=/i,
    /@import\s+url\s*\(/i,
    /\bfetch\s*\(/i,
    /\blocalStorage\b/i,
    /\bsessionStorage\b/i,
    /https?:\/\//i,
    /\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  ];

  for (const pattern of externalPatterns) {
    if (pattern.test(html)) {
      addFinding(findings, 'errors', `index.html is not self-contained; matched ${pattern}`);
    }
  }

  const hasControl = /<(?:input|button|select|textarea)\b/i.test(html);
  const hasHandler = /\b(?:addEventListener|onclick|oninput|onchange)\b/i.test(html);

  if (!hasControl) {
    addFinding(findings, 'errors', 'index.html has no visible interactive control.');
  }
  if (!hasHandler) {
    addFinding(findings, 'errors', 'index.html has no JavaScript event handler for interaction.');
  }

  const visibleHtmlText = stripHtmlNoise(html);
  if (!METHOD_OVERVIEW_MARKER.test(visibleHtmlText)) {
    addFinding(findings, 'errors', 'index.html does not appear to include a paper-grounded method overview, mechanism map, formula breakdown, or result dashboard.');
  }
}

function checkNoImagegenResidues(paperDir, findings) {
  for (const filename of USER_VISIBLE_TEXT_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = readText(filePath).split('\n');
    lines.forEach((line, index) => {
      if (IMAGEGEN_RESIDUE.test(line)) {
        addFinding(findings, 'errors', `${filename}:${index + 1} contains image-generation residue; default study packages must use paper figures, structured tables, or deterministic diagrams.`);
      }
    });
  }
}

function checkImageReferencePath(paperDir, filename, ref, findings) {
  const resolved = resolveImageTarget(ref.target);

  if (resolved.kind === 'empty' || resolved.kind === 'invalid') {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} has an invalid image target: ${ref.target}`);
    return null;
  }

  if (resolved.kind === 'external') {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} uses an external or embedded image target (${ref.target}); study-package visuals should be local package assets.`);
    return null;
  }

  if (resolved.kind === 'absolute') {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} uses an absolute image path (${ref.target}); use a package-relative image path or Web UI raw path.`);
    return null;
  }

  const normalized = path.normalize(resolved.target);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} references an image outside the paper package: ${ref.target}`);
    return null;
  }

  const imagePath = path.join(paperDir, normalized);
  if (!fs.existsSync(imagePath)) {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} references missing image: ${ref.target}`);
    return null;
  }

  return imagePath;
}

function checkBodyImageQuality(filename, ref, imagePath, findings) {
  const basename = path.basename(ref.target);
  const dimensions = readImageDimensions(imagePath);

  if (PREVIEW_ASSET_MARKER.test(ref.target) || PREVIEW_ASSET_MARKER.test(basename)) {
    addFinding(findings, 'errors', `${filename}:${ref.lineNumber} embeds a page preview/navigation preview in body prose. Page previews belong in visual-assets.md as navigation-only assets, not README/summary/method.`);
  }

  if (dimensions) {
    const pixels = dimensions.width * dimensions.height;
    if (dimensions.width < BODY_IMAGE_MIN_WIDTH || dimensions.height < BODY_IMAGE_MIN_HEIGHT || pixels < BODY_IMAGE_MIN_PIXELS) {
      addFinding(findings, 'errors', `${filename}:${ref.lineNumber} embeds a low-resolution visual (${dimensions.width}x${dimensions.height}); use a readable crop/table/diagram instead.`);
    }

    if (isLikelyFullPagePreview(dimensions) && /(?:page|preview|导航|定位)/i.test(ref.target)) {
      addFinding(findings, 'errors', `${filename}:${ref.lineNumber} embeds a likely full-page preview (${dimensions.width}x${dimensions.height}); use a local figure/table crop or teaching redraw in正文.`);
    }

    if (isSuspiciousOverCrop(dimensions)) {
      addFinding(findings, 'warnings', `${filename}:${ref.lineNumber} embeds a very tall large visual (${dimensions.width}x${dimensions.height}); check that the crop contains only the target figure/table and its own caption, not neighboring prose or other figures.`);
    }
  }
}

function nearbyVisualContext(lines, lineNumber) {
  const start = Math.max(0, lineNumber - 4);
  const end = Math.min(lines.length, lineNumber + 3);
  return lines.slice(start, end).join(' ');
}

function checkMarkdownVisualReferences(paperDir, findings) {
  for (const filename of MARKDOWN_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const text = readText(filePath);
    const lines = text.split('\n');
    const refs = extractMarkdownImageRefs(text);

    refs.forEach((ref) => {
      const imagePath = checkImageReferencePath(paperDir, filename, ref, findings);

      if (!EMBEDDED_VISUAL_FILES.includes(filename)) {
        return;
      }

      if (imagePath) {
        checkBodyImageQuality(filename, ref, imagePath, findings);
      }

      const context = nearbyVisualContext(lines, ref.lineNumber);
      if (!SOURCE_MARKER.test(context)) {
        addFinding(findings, 'errors', `${filename}:${ref.lineNumber} embeds a visual without nearby source text such as figure/table/page/section or explanatory-redraw labeling.`);
      }
      if (!VISUAL_VALUE_MARKER.test(context)) {
        addFinding(findings, 'warnings', `${filename}:${ref.lineNumber} embeds a visual without a nearby explanation of how it helps the reader.`);
      }
    });
  }
}

function isVisualLine(line) {
  return /!\[[^\]]*\]\([^)]+\)|<img\b/i.test(line);
}

function isCaptionOnlyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.length < 160 && (SOURCE_MARKER.test(trimmed) || /^[_*> -]*(?:图|表|Figure|Fig\.|Table|Source|来源)/i.test(trimmed));
}

function checkVisualDensity(paperDir, findings) {
  for (const filename of EMBEDDED_VISUAL_FILES) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = readText(filePath).split('\n');
    let visualRun = 0;

    lines.forEach((line, index) => {
      if (isVisualLine(line)) {
        visualRun += 1;
        if (visualRun > 2) {
          addFinding(findings, 'errors', `${filename}:${index + 1} has more than two visuals in a row without explanatory prose.`);
        }
        return;
      }

      if (isCaptionOnlyLine(line)) {
        return;
      }

      visualRun = 0;
    });
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExactSecondLevelHeading(text, heading) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm');
  return pattern.test(text);
}

function checkV2Reflection(paperDir, findings) {
  const filePath = path.join(paperDir, 'reflection.md');
  if (!fs.existsSync(filePath)) return;
  const text = readText(filePath);
  for (const heading of REQUIRED_REFLECTION_HEADINGS) {
    if (!hasExactSecondLevelHeading(text, heading)) {
      addFinding(findings, 'errors', `reflection.md is missing required v2 heading: ## ${heading}`);
    }
  }
}

function checkV2MethodContract(paperDir, findings) {
  const filePath = path.join(paperDir, 'method.md');
  if (!fs.existsSync(filePath)) return;
  const text = stripMarkdownNoise(readText(filePath));
  if (!/(?:support criteria|支持标准|支持判据|支持条件)/i.test(text)) {
    addFinding(findings, 'errors', 'method.md must include minimal reproduction support criteria.');
  }
  if (!/(?:falsification criteria|证伪标准|反证标准|证伪条件|falsify)/i.test(text)) {
    addFinding(findings, 'errors', 'method.md must include minimal reproduction falsification criteria.');
  }
}

function checkV2QaContract(paperDir, findings) {
  const filePath = path.join(paperDir, 'qa.md');
  if (!fs.existsSync(filePath)) return;
  const text = stripMarkdownNoise(readText(filePath));
  const required = [
    ['author reasoning', /(?:作者推理|reasoning path|author reasoning)/i],
    ['paper claim vs inference', /(?:论文主张|paper claim).*(?:分析推断|inference)|(?:分析推断|inference).*(?:论文主张|paper claim)/is],
    ['weakest assumption', /(?:最弱假设|weakest assumption)/i],
    ['falsification', /(?:证伪|falsification|falsify)/i],
    ['evidence boundary', /(?:证据范围|超出证据|evidence boundary|beyond the evidence)/i]
  ];

  for (const [label, pattern] of required) {
    if (!pattern.test(text)) {
      addFinding(findings, 'errors', `qa.md must include a v2 question about ${label}.`);
    }
  }
}

function hasNaturalEvidenceMarker(line) {
  return /(?:论文\s*p\.?\s*\d+|p\.?\s*\d+|第\s*\d+\s*页|§|section|table\s*\d+|figure\s*\d+|fig\.?\s*\d+|表\s*\d+|图\s*\d+|实验部分|结果部分|附录|appendix)/i.test(line);
}

function hasSubstantiveNumericClaim(line) {
  if (!/(?:\d+(?:\.\d+)?\s?%|\d+\.\d+|\d+(?:\.\d+)?\s?(?:x|ms|gb|mb|billion|million|tokens?|parameters?|bleu|points?))/i.test(line)) {
    return false;
  }
  return /(?:improve|outperform|achieve|accuracy|score|result|benchmark|提升|优于|达到|准确率|结果|基准|指标)/i.test(line);
}

function checkV2NaturalEvidenceLocations(paperDir, findings) {
  for (const filename of ['README.md', 'summary.md', 'insights.md', 'method.md', 'reflection.md']) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) continue;
    const lines = stripMarkdownNoise(readText(filePath)).split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) return;
      if (hasSubstantiveNumericClaim(trimmed) && !hasNaturalEvidenceMarker(trimmed)) {
        addFinding(
          findings,
          'errors',
          `${filename}:${index + 1} has a numeric conclusion without a natural paper location.`
        );
      }
    });
  }
}

function checkV2IndexContract(paperDir, findings) {
  const filePath = path.join(paperDir, 'index.html');
  if (!fs.existsSync(filePath)) return;
  const text = stripHtmlNoise(readText(filePath));
  const required = [
    ['paper claims', /(?:论文主张|paper claims?|paper_claim)/i],
    ['inferences', /(?:分析推断|推断|inferences?)/i],
    ['speculations', /(?:研究猜想|猜测|speculations?)/i],
    ['weakest assumption', /(?:最弱假设|weakest assumption)/i],
    ['counterexample', /(?:最强反例|counterexample)/i]
  ];

  for (const [label, pattern] of required) {
    if (!pattern.test(text)) {
      addFinding(findings, 'errors', `index.html v2 interaction is missing ${label}.`);
    }
  }
}

function checkV2VisibleContentContract(paperDir, findings) {
  checkV2Reflection(paperDir, findings);
  checkV2MethodContract(paperDir, findings);
  checkV2QaContract(paperDir, findings);
  checkV2NaturalEvidenceLocations(paperDir, findings);
  checkV2IndexContract(paperDir, findings);
}

function checkVisualAssetsIndex(paperDir, findings) {
  const filename = 'visual-assets.md';
  const filePath = path.join(paperDir, filename);
  if (!fs.existsSync(filePath)) {
    return;
  }

  const text = readText(filePath);
  const plain = stripMarkdownNoise(text);

  if (plain.trim().length < 80) {
    addFinding(findings, 'errors', 'visual-assets.md is too short to serve as a curated visual asset guide.');
  }

  const refs = extractMarkdownImageRefs(text);
  const hasVisualCandidate = refs.length > 0 || hasMarkdownTable(text) || hasDeterministicDiagram(text);
  const explainsNoUsefulVisuals = NO_USEFUL_VISUALS.test(text);

  if (!hasVisualCandidate && !explainsNoUsefulVisuals) {
    addFinding(findings, 'errors', 'visual-assets.md must either list selected visual assets or explain why no useful visuals were available.');
  }

  if (!SOURCE_MARKER.test(text) && !explainsNoUsefulVisuals) {
    addFinding(findings, 'errors', 'visual-assets.md must record source locations such as figure/table/page/section, or explain why no useful visuals were available.');
  }

  if (!VISUAL_VALUE_MARKER.test(text) && !explainsNoUsefulVisuals) {
    addFinding(findings, 'errors', 'visual-assets.md must explain how selected visuals help readers and where they belong in the reading path.');
  }

  const visualPathMentions = [
    ...extractImagePathMentions(text),
    ...refs.map((ref) => ({ target: ref.target, lineNumber: ref.lineNumber }))
  ];
  const lines = text.split('\n');
  for (const mention of visualPathMentions) {
    if (!PREVIEW_ASSET_MARKER.test(mention.target)) {
      continue;
    }

    const sectionStart = Math.max(0, mention.lineNumber - 6);
    const sectionEnd = Math.min(lines.length, mention.lineNumber + 7);
    const sectionText = lines.slice(sectionStart, sectionEnd).join(' ');

    if (!NAVIGATION_ONLY_MARKER.test(sectionText)) {
      addFinding(findings, 'errors', `visual-assets.md:${mention.lineNumber} lists a page preview without navigation-only labeling.`);
    }

    if (/(?:推荐阅读位置|recommended reading|reading placement).*(?:README|summary|method)/i.test(sectionText)) {
      addFinding(findings, 'errors', `visual-assets.md:${mention.lineNumber} recommends a page preview for正文 files; page previews should be navigation-only.`);
    }
  }
}

function commandForCodeFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.py') {
    return { command: 'python3', args: [filename] };
  }
  if (ext === '.js' || ext === '.mjs') {
    return { command: 'node', args: [filename] };
  }
  return null;
}

function runCodeDemos(paperDir, codeFiles, timeoutMs, findings) {
  const codeDir = path.join(paperDir, 'code');
  const runnable = codeFiles
    .map((filename) => ({ filename, runner: commandForCodeFile(filename) }))
    .filter((item) => item.runner);

  if (runnable.length === 0) {
    addFinding(findings, 'errors', '--run-code was requested, but no Python or JavaScript demo was found.');
    return;
  }

  for (const item of runnable) {
    const result = spawnSync(item.runner.command, item.runner.args, {
      cwd: codeDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });

    if (result.error?.code === 'ETIMEDOUT') {
      addFinding(findings, 'errors', `code/${item.filename} timed out after ${timeoutMs}ms.`);
      continue;
    }

    if (result.error) {
      addFinding(findings, 'errors', `code/${item.filename} failed to run: ${result.error.message}`);
      continue;
    }

    if (result.status !== 0) {
      const stderr = (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
      addFinding(findings, 'errors', `code/${item.filename} exited with ${result.status}.${stderr ? ` Output: ${stderr}` : ''}`);
    }
  }
}

function validate(args) {
  const paperDir = resolvePaperDir(args.input);
  const findings = {
    errors: [],
    warnings: []
  };

  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    addFinding(findings, 'errors', `Paper directory not found: ${paperDir}`);
    return { paperDir, findings };
  }

  const v2Package = isV2Package(paperDir);
  checkReasoningLayer(paperDir, args, findings);

  const codeFiles = checkRequiredFiles(paperDir, findings);
  checkForbiddenResidues(paperDir, findings);
  checkNoImagegenResidues(paperDir, findings);
  checkQa(paperDir, findings);
  checkLanguage(paperDir, args.lang, findings);
  checkHtml(paperDir, findings);
  checkVisualAssetsIndex(paperDir, findings);
  checkMarkdownVisualReferences(paperDir, findings);
  checkVisualDensity(paperDir, findings);
  if (v2Package) {
    checkV2VisibleContentContract(paperDir, findings);
  }

  if (args.runCode) {
    runCodeDemos(paperDir, codeFiles, args.timeoutMs, findings);
  }

  return { paperDir, findings };
}

function printReport(result) {
  const { paperDir, findings } = result;
  const status = findings.errors.length === 0 ? 'PASS' : 'FAIL';

  console.log(`Study package validation: ${status}`);
  console.log(`Paper directory: ${paperDir}`);

  if (findings.errors.length > 0) {
    console.log('\nErrors:');
    findings.errors.forEach((message) => console.log(`- ${message}`));
  }

  if (findings.warnings.length > 0) {
    console.log('\nWarnings:');
    findings.warnings.forEach((message) => console.log(`- ${message}`));
  }

  if (findings.errors.length === 0 && findings.warnings.length === 0) {
    console.log('\nNo issues found.');
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = validate(args);
  printReport(result);
  process.exit(result.findings.errors.length === 0 ? 0 : 1);
} catch (error) {
  usage();
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
