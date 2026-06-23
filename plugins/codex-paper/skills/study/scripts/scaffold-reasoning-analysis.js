#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');

const REVIEW_TEMPLATE = `# Reasoning Review

- [ ] 核心主张与贡献、结果已区分
- [ ] 每个 paper_claim 都有论文证据
- [ ] 每个高影响 inference 都有证据，并明确使用推断语气
- [ ] 作者推理路径不是目录复述
- [ ] 每个验证单元包含问题、设计、观察、结论
- [ ] 结论没有超出实验或证明支持范围
- [ ] 最弱假设只有一个，并直接关联核心主张
- [ ] 最小复现同时包含支持和证伪标准
- [ ] 最强反例挑战明确主张，而非外围细节
- [ ] 非实证论文没有被强行改写成实验复现；证伪/观察标准按证明、分类、论证或决策后果解释
- [ ] 后续研究不是仅扩大数据、模型或调参
- [ ] 低质量解析和缺失证据已显式披露

## Remaining uncertainties

...
`;

function usage() {
  console.error('Usage: node scaffold-reasoning-analysis.js <paper-dir-or-slug> [--force] [--context paper-only|canonical|literature] [--profile auto|empirical|theoretical|architecture|system|benchmark|survey|post-training|position|other]');
}

function parseArgs(argv) {
  const args = {
    input: null,
    force: false,
    contextMode: 'paper-only',
    profile: 'auto'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--context') {
      args.contextMode = argv[index + 1];
      index += 1;
    } else if (arg === '--profile') {
      args.profile = argv[index + 1];
      index += 1;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error('Paper directory or slug is required');
  }

  if (!['paper-only', 'canonical', 'literature'].includes(args.contextMode)) {
    throw new Error('--context must be paper-only, canonical, or literature');
  }

  if (!['auto', 'empirical', 'theoretical', 'architecture', 'system', 'benchmark', 'survey', 'post-training', 'position', 'other'].includes(args.profile)) {
    throw new Error('--profile is not recognized');
  }

  return args;
}

function resolvePaperDir(input) {
  const expanded = input.replace(/^~(?=$|\/)/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    return fs.statSync(direct).isDirectory() ? direct : path.dirname(direct);
  }

  return path.join(PAPERS_ROOT, input);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function textBlob(...values) {
  return values
    .map((value) => typeof value === 'string' ? value : JSON.stringify(value || ''))
    .join('\n')
    .toLowerCase();
}

export function inferPaperType({ paperData, evidenceLedger }) {
  const blob = textBlob(paperData?.title, paperData?.abstract, paperData?.sections, evidenceLedger?.evidence?.slice(0, 80));

  if (/\b(?:theorem|proof|lemma|proposition|bound|convergence)\b|定理|证明|引理/.test(blob)) return 'theoretical';
  if (/\b(?:survey|taxonomy|review|systematic literature|综述|分类体系)\b/.test(blob)) return 'survey';
  if (/\b(?:benchmark|dataset|leaderboard|evaluation suite|基准|数据集)\b/.test(blob)) return 'benchmark';
  if (/\b(?:position paper|perspective|we argue|we advocate|立场|观点)\b/.test(blob)) return 'position';
  if (/\b(?:post-training|rlhf|rlvr|preference optimization|reward model|fine-tun)\b/.test(blob)) return 'post-training';
  if (/\b(?:system|latency|throughput|deployment|hardware|cache|serve|serving)\b/.test(blob)) return 'system';
  if (/\b(?:architecture|transformer|attention|module|component|network architecture)\b/.test(blob)) return 'architecture';
  if (/\b(?:experiment|ablation|baseline|metric|accuracy|bleu|f1|auc|outperform)\b/.test(blob)) return 'empirical';
  return 'other';
}

function evidenceQualityFromLedger(ledger) {
  const quality = ledger?.quality || {};
  if (quality.sectionCoverage === 'none') return 'partial_sections';
  if (quality.readingOrder === 'low') return 'noisy_reading_order';
  if (quality.tableExtraction === 'none') return 'noisy_table_extraction';
  return 'complete_enough';
}

function difficultyFromPaper(paperData, paperType) {
  if (paperType === 'theoretical') return 'highly_theoretical';
  const textLength = String(paperData?.rawText || '').length;
  if (textLength > 50000) return 'advanced';
  if (textLength > 20000) return 'intermediate';
  return 'intermediate';
}

export function buildReasoningSkeleton({ paperDir, contextMode = 'paper-only', profile = 'auto' }) {
  const meta = readJson(path.join(paperDir, 'meta.json'));
  const paperData = readJson(path.join(paperDir, 'paper-data.json'));
  const evidenceLedger = readJson(path.join(paperDir, 'evidence-ledger.json'));
  const paperType = profile === 'auto' ? inferPaperType({ paperData, evidenceLedger }) : profile;

  return {
    schemaVersion: '2.0.0',
    status: 'draft',
    paperSlug: meta.slug || paperData.paperSlug || evidenceLedger.paperSlug || path.basename(paperDir),
    generatedAt: new Date().toISOString(),
    contextMode,
    paperType,
    difficulty: difficultyFromPaper(paperData, paperType),
    evidenceQuality: evidenceQualityFromLedger(evidenceLedger),
    centralClaims: [],
    researchQuestion: {},
    priorWorkGap: {},
    authorReasoningPath: [],
    coreIntuition: {},
    methodModel: {
      inputs: [],
      components: [],
      pipeline: [],
      outputs: [],
      equations: []
    },
    validations: [],
    takeaways: [],
    weakestAssumption: {},
    minimalReproduction: {},
    strongestCounterexample: {},
    followUpIdea: {},
    limitations: [],
    uncertaintyZones: []
  };
}

export function scaffoldReasoningAnalysis(input, options = {}) {
  const paperDir = resolvePaperDir(input);
  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    throw new Error(`Paper directory not found: ${paperDir}`);
  }

  for (const filename of ['meta.json', 'paper-data.json', 'evidence-ledger.json']) {
    const filePath = path.join(paperDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required file: ${filename}`);
    }
  }

  const outputPath = path.join(paperDir, 'reasoning-analysis.json');
  if (fs.existsSync(outputPath) && !options.force) {
    throw new Error(`reasoning-analysis.json already exists. Use --force to overwrite: ${outputPath}`);
  }

  const skeleton = buildReasoningSkeleton({
    paperDir,
    contextMode: options.contextMode || 'paper-only',
    profile: options.profile || 'auto'
  });

  fs.writeFileSync(outputPath, `${JSON.stringify(skeleton, null, 2)}\n`);

  const codexDir = path.join(paperDir, '.codex-paper');
  fs.mkdirSync(codexDir, { recursive: true });
  const reviewPath = path.join(codexDir, 'reasoning-review.md');
  if (!fs.existsSync(reviewPath) || options.force) {
    fs.writeFileSync(reviewPath, REVIEW_TEMPLATE);
  }

  return {
    paperDir,
    outputPath,
    reviewPath,
    skeleton
  };
}

async function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = scaffoldReasoningAnalysis(args.input, args);
    process.stdout.write(`${JSON.stringify({
      paperDir: result.paperDir,
      reasoningPath: result.outputPath,
      reviewPath: result.reviewPath,
      status: result.skeleton.status,
      paperType: result.skeleton.paperType,
      contextMode: result.skeleton.contextMode,
      next: 'Codex must read evidence-ledger.json, fill reasoning-analysis.json, set status to complete, and run validate-reasoning.js --strict before authoring visible materials.'
    }, null, 2)}\n`);
  } catch (error) {
    usage();
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  runCli();
}
