#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REQUIRED_FILES = [
  'README.md',
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
  /\bparserVersion\b/i,
  /\bpaperSlug\b/i,
  /\brawText\b/i,
  /\bResult\s+\d+\b/i,
  /\bSee evidence\b/i,
  /\b(?:claim|result|limitation):\d+\b/i,
  /^\s*"[^"]+"\s*:\s*[{["0-9tfn-]/i
];

const QA_LEVELS = [
  { key: 'basic', labels: ['basic', '基础'] },
  { key: 'intermediate', labels: ['intermediate', '中级'] },
  { key: 'advanced', labels: ['advanced', '高级'] }
];

function usage() {
  console.error('Usage: node validate-study-package.js <paper-slug-or-dir> [--lang zh|en] [--run-code] [--timeout-ms 20000]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    lang: null,
    runCode: false,
    timeoutMs: 20000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lang') {
      args.lang = argv[index + 1];
      index += 1;
    } else if (arg === '--run-code') {
      args.runCode = true;
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
    const visibleText = /\.html?$/i.test(filename) ? stripHtmlNoise(raw) : raw;
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

  const codeFiles = checkRequiredFiles(paperDir, findings);
  checkForbiddenResidues(paperDir, findings);
  checkQa(paperDir, findings);
  checkLanguage(paperDir, args.lang, findings);
  checkHtml(paperDir, findings);

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
