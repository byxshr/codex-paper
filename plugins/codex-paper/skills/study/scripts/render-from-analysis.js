import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBRARY_ROOT = path.join(process.env.HOME || '', 'codex-papers');
const PAPERS_ROOT = path.join(LIBRARY_ROOT, 'papers');

const COPY = {
  en: {
    readmeTitle: 'Study Guide',
    about: 'What This Paper Is About',
    whyRead: 'How To Read This Folder',
    takeaways: 'Key Takeaways',
    artifacts: 'Structured Artifacts',
    parserNotes: 'Parser Notes',
    quickSummaryTitle: 'Quick Summary',
    oneSentence: 'One Sentence',
    problem: 'Problem',
    coreIdea: 'Core Idea',
    contributions: 'Key Contributions',
    results: 'Main Results',
    whyItMatters: 'Why It Matters',
    limitations: 'Limitations',
    summaryTitle: 'Structured Summary',
    background: 'Background',
    problemStatement: 'Problem Statement',
    insightsTitle: 'Insights',
    coreShift: 'Core Shift',
    whyWorks: 'Why This Works',
    tradeoffs: 'Trade-offs',
    practicalImplications: 'Practical Implications',
    openQuestions: 'Open Questions',
    source: 'Source',
    metric: 'Metric',
    value: 'Value',
    benchmark: 'Benchmark',
    noResults: 'No quantitative results were extracted with high confidence.',
    noLimitations: 'No explicit limitation was extracted with high confidence.',
    noQuestions: 'No follow-up questions were generated from the available evidence.',
    stepQuick: 'Start with `quick-summary.md` for a 5-minute overview.',
    stepSummary: 'Continue with `summary.md` for a structured walkthrough.',
    stepInsights: 'Read `insights.md` for the conceptual shift and implications.',
    artifactIntro: 'These files are designed to be the trusted analysis-first layer for downstream study materials:',
    whyTemplateWithResult: 'This paper matters because it turns the problem into a concrete approach and reports `%VALUE%` on `%BENCHMARK%`.',
    whyTemplateNoResult: 'This paper matters because it turns the problem into a reusable approach that can guide follow-up work.',
    coreShiftTemplate: 'The conceptual shift is moving from `%PROBLEM%` toward `%CORE_IDEA%`.',
    whyWorksIntro: 'The paper works through the following mechanisms:',
    practicalTemplateWithResult: 'In practice, the most immediate signal is `%VALUE%` on `%BENCHMARK%`, which suggests the approach is actionable beyond a purely conceptual contribution.',
    practicalTemplateNoResult: 'In practice, the value lies in giving a reusable framing that can guide implementation and follow-up evaluation.',
    parserFlagPrefix: 'Parser quality flags:'
  },
  zh: {
    readmeTitle: '学习导航',
    about: '这篇论文讲什么',
    whyRead: '建议阅读顺序',
    takeaways: '核心要点',
    artifacts: '阅读材料',
    parserNotes: '解析说明',
    quickSummaryTitle: '快速摘要',
    oneSentence: '一句话总结',
    problem: '问题',
    coreIdea: '核心思路',
    contributions: '关键贡献',
    results: '主要结果',
    whyItMatters: '为什么重要',
    limitations: '局限性',
    summaryTitle: '结构化总结',
    background: '背景',
    problemStatement: '问题定义',
    insightsTitle: '洞察',
    coreShift: '核心转变',
    whyWorks: '为什么有效',
    tradeoffs: '权衡与代价',
    practicalImplications: '实践意义',
    openQuestions: '后续问题',
    source: '来源',
    metric: '指标',
    value: '数值',
    benchmark: '基准',
    noResults: '当前没有高置信提取出的定量结果。',
    noLimitations: '当前没有高置信提取出的明确局限性。',
    noQuestions: '当前没有基于现有证据生成额外追问。',
    stepQuick: '先看 `quick-summary.md`，用 5 分钟建立整体认识。',
    stepSummary: '再看 `summary.md`，做结构化梳理。',
    stepInsights: '最后看 `insights.md`，理解概念转变和实践意义。',
    artifactIntro: '下面这些文件按层次组织，适合从快速理解逐步进入详细阅读：',
    whyTemplateWithResult: '这篇论文的重要性在于，它把问题转化成了可复用的方法，并在 `%BENCHMARK%` 上给出了 `%VALUE%` 的结果信号。',
    whyTemplateNoResult: '这篇论文的重要性在于，它把问题转化成了可复用的方法框架，能直接指导后续实现和扩展。',
    coreShiftTemplate: '它带来的核心转变，是从“%PROBLEM%”推进到“%CORE_IDEA%”。',
    whyWorksIntro: '这篇论文主要通过以下机制起作用：',
    practicalTemplateWithResult: '从实践角度看，最直接的信号是它在 `%BENCHMARK%` 上给出了 `%VALUE%`，说明这不仅是概念贡献，也具备落地价值。',
    practicalTemplateNoResult: '从实践角度看，它最大的价值是提供了一个可以复用的思路框架，便于后续实现、评估和扩展。',
    parserFlagPrefix: '解析质量标记：'
  }
};

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickLanguage(value) {
  return value === 'zh' ? 'zh' : 'en';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePaperDir(input) {
  if (!input) {
    throw new Error('Paper slug or directory is required');
  }

  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) {
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  }

  return path.join(PAPERS_ROOT, input);
}

function evidenceMap(facts) {
  const output = new Map();
  const mapping = [
    ['claim', facts.coreClaims || []],
    ['result', facts.keyResults || []],
    ['limitation', facts.limitations || []]
  ];

  mapping.forEach(([kind, items]) => {
    items.forEach((item, index) => {
      output.set(`${kind}:${index}`, {
        section: item.evidence?.section || 'unknown',
        quote: normalizeWhitespace(item.evidence?.quote || item.text || item.context || '')
      });
    });
  });

  return output;
}

function displaySection(section, lang) {
  if (lang !== 'zh') {
    return section;
  }

  const mapping = {
    abstract: '摘要',
    introduction: '引言',
    conclusion: '结论',
    unknown: '未知'
  };

  return mapping[section] || section;
}

function formatSources(evidenceRefs, facts) {
  const lang = arguments[2] || 'en';
  const lookup = evidenceMap(facts);
  const sections = [];

  for (const ref of evidenceRefs || []) {
    const item = lookup.get(ref);
    if (item?.section && !sections.includes(item.section)) {
      sections.push(item.section);
    }
  }

  if (sections.length === 0) {
    return lang === 'zh' ? '未知' : 'unknown';
  }

  return sections.map((section) => displaySection(section, lang)).join(', ');
}

function bulletLines(items, facts, labels, options = {}) {
  const { includeSource = false } = options;
  const lang = labels === COPY.zh ? 'zh' : 'en';
  if (!Array.isArray(items) || items.length === 0) {
    return [`- ${labels.noLimitations}`];
  }

  return items.map((item) => {
    const text = localizeText(item.text, lang);
    if (!includeSource) {
      return `- ${text}`;
    }
    return `- ${text} (${labels.source}: ${formatSources(item.evidenceRefs, facts, lang)})`;
  });
}

function renderResultTable(resultsTable, facts, labels) {
  if (!Array.isArray(resultsTable) || resultsTable.length === 0) {
    return `${labels.noResults}\n`;
  }

  const header = `| ${labels.metric} | ${labels.value} | ${labels.benchmark} | ${labels.source} |`;
  const divider = '|---|---|---|---|';
  const metricMap = labels === COPY.zh
    ? {
        'Parameter scale': '参数规模',
        'Benchmark performance': '基准表现',
        'Language coverage': '语言覆盖'
      }
    : {};
  const lang = labels === COPY.zh ? 'zh' : 'en';
  const rows = resultsTable.map((row) => `| ${metricMap[normalizeWhitespace(row.metric)] || normalizeWhitespace(row.metric)} | ${localizeResultValue(row.value, lang)} | ${localizeBenchmark(row.benchmark, lang)} | ${formatSources(row.evidenceRefs, facts, lang)} |`);
  return [header, divider, ...rows].join('\n');
}

function formatTemplate(template, replacements) {
  let value = template;
  Object.entries(replacements).forEach(([key, replacement]) => {
    value = value.replaceAll(`%${key}%`, replacement);
  });
  return value;
}

const ZH_TEXT_MAP = new Map([
  [
    'In this work, we present Qwen3, the latest version of the Qwen model family.',
    '本文介绍 Qwen3，即 Qwen 模型家族的最新版本。'
  ],
  [
    'While most state-of-the-art models remain proprietary, the rapid growth of open-source communities has substantially reduced the performance gap between open-weight and closed-source models.',
    '尽管大多数最先进模型仍是专有模型，但开源社区的快速发展已经显著缩小了开源权重模型与闭源模型之间的性能差距。'
  ],
  [
    'A key innovation in Qwen3 is the integration of thinking mode (for complex, multi-step reasoning) and non-thinking mode (for rapid, context-driven responses) into a unified framework.',
    'Qwen3 的关键创新是将用于复杂多步推理的思考模式和用于快速上下文响应的非思考模式整合到统一框架中。'
  ],
  [
    'Empirical evaluations demonstrate that Qwen3 achieves state-of-the-art results across diverse benchmarks, including tasks in code generation, mathematical reasoning, agent tasks, etc., competitive against larger MoE models and proprietary models.',
    '实证评估表明，Qwen3 在代码生成、数学推理、智能体任务等多类基准上达到最先进结果，并可与更大的 MoE 模型和专有模型竞争。'
  ],
  [
    'In this work, we introduce Qwen3, the latest series in our foundation model family, Qwen.',
    '本文介绍基础模型家族 Qwen 的最新系列 Qwen3。'
  ],
  [
    'Qwen3 Technical Report spans 0.6 to 235 billion parameters.',
    'Qwen3 Technical Report 覆盖 0.6B 到 235B 参数规模。'
  ],
  [
    'State-of-the-art on Code, math, and agent benchmarks.',
    '在代码、数学和智能体基准上达到最先进水平。'
  ],
  [
    'We leave this exploration as future work.',
    '这部分探索留待未来工作。'
  ],
  [
    'Based on this insight, we introduce WebSailor, a complete post-training methodology designed to instill this crucial capability.',
    '基于这一洞察，本文提出 WebSailor，一套用于注入这项关键能力的完整后训练方法。'
  ],
  [
    'However, instilling these advanced reasoning capabilities in open-source agents remains an unsolved problem.',
    '然而，如何让开源智能体具备这些高级推理能力仍是未解决的问题。'
  ],
  [
    'Our approach involves generating novel, high-uncertainty tasks through structured sampling and information obfuscation, RFT cold start, and an efficient agentic RL training algorithm, Duplicating Sampling Policy Optimization (DUPO).',
    '该方法通过结构化采样和信息混淆生成新的高不确定性任务，并结合 RFT 冷启动和高效的智能体强化学习训练算法 DUPO（Duplicating Sampling Policy Optimization）。'
  ],
  [
    'Leading proprietary agentic systems, such as Deep Research (OpenAI, 2025a), show that Large Language Model (LLM) agents can transcend these human limitations.',
    'Deep Research 等领先的专有智能体系统表明，LLM 智能体可以超越这些人类限制。'
  ],
  [
    'Matches proprietary-agent performance on Complex information-seeking benchmarks.',
    '在复杂信息寻求基准上达到专有智能体性能。'
  ],
  [
    'After obtaining QAs, a key challenge is acquiring full supervision.',
    '获得问答数据后，一个关键挑战是取得完整监督信号。'
  ]
]);

const ZH_VALUE_MAP = new Map([
  ['0.6 to 235 billion', '0.6B 到 235B'],
  ['State-of-the-art', '最先进水平'],
  ['119 languages and dialects', '119 种语言和方言'],
  ['Matches proprietary-agent performance', '达到专有智能体性能'],
  ['Outperforms open-source agents', '超过开源智能体'],
  ['See evidence', '见证据']
]);

const ZH_BENCHMARK_MAP = new Map([
  ['Code, math, and agent benchmarks', '代码、数学和智能体基准'],
  ['Complex information-seeking benchmarks', '复杂信息寻求基准'],
  ['Open-source agent benchmarks', '开源智能体基准']
]);

function localizeText(value, lang) {
  const text = normalizeWhitespace(value);
  if (lang !== 'zh' || !text) {
    return text;
  }

  return ZH_TEXT_MAP.get(text) || text;
}

function localizeResultValue(value, lang) {
  const text = normalizeWhitespace(value);
  if (lang !== 'zh' || !text) {
    return text;
  }

  return ZH_VALUE_MAP.get(text) || text;
}

function localizeBenchmark(value, lang) {
  const text = normalizeWhitespace(value);
  if (lang !== 'zh' || !text) {
    return text;
  }

  return ZH_BENCHMARK_MAP.get(text) || text;
}

function whyItMatters(analysis, labels) {
  const lang = labels === COPY.zh ? 'zh' : 'en';
  const firstResult = (analysis.resultsTable || []).find((row) => normalizeWhitespace(row.metric) === 'Benchmark performance')
    || (analysis.resultsTable || []).find((row) => normalizeWhitespace(row.metric) === 'Language coverage')
    || analysis.resultsTable?.[0];
  if (firstResult) {
    return formatTemplate(labels.whyTemplateWithResult, {
      VALUE: localizeResultValue(firstResult.value, lang),
      BENCHMARK: localizeBenchmark(firstResult.benchmark, lang)
    });
  }

  return labels.whyTemplateNoResult;
}

function coreShift(analysis, labels) {
  const lang = labels === COPY.zh ? 'zh' : 'en';
  const problem = localizeText(analysis.problem?.text || '', lang);
  const coreIdea = localizeText(analysis.coreIdea?.text || '', lang);
  if (!problem || !coreIdea) {
    return '';
  }

  return formatTemplate(labels.coreShiftTemplate, {
    PROBLEM: problem,
    CORE_IDEA: coreIdea
  });
}

function practicalImplications(analysis, labels) {
  const lang = labels === COPY.zh ? 'zh' : 'en';
  const firstResult = (analysis.resultsTable || []).find((row) => normalizeWhitespace(row.metric) === 'Benchmark performance')
    || (analysis.resultsTable || []).find((row) => normalizeWhitespace(row.metric) === 'Language coverage')
    || analysis.resultsTable?.[0];
  if (firstResult) {
    return formatTemplate(labels.practicalTemplateWithResult, {
      VALUE: localizeResultValue(firstResult.value, lang),
      BENCHMARK: localizeBenchmark(firstResult.benchmark, lang)
    });
  }

  return labels.practicalTemplateNoResult;
}

function parserNotes(paperData, labels) {
  const flags = Array.isArray(paperData.qualityFlags) ? paperData.qualityFlags : [];
  if (flags.length === 0) {
    return '';
  }
  return `${labels.parserFlagPrefix} ${flags.join(', ')}`;
}

function localizeOpenQuestion(text, lang) {
  const value = normalizeWhitespace(text);
  if (lang !== 'zh') {
    return value;
  }

  if (/^What should future work explore next\?/i.test(value)) {
    return '未来工作下一步最值得探索什么？';
  }

  const match = value.match(/^How can future work address:\s*(.+)\?$/i);
  if (match) {
    return `未来工作如何进一步解决：${localizeText(match[1], lang)}？`;
  }

  return localizeText(value, lang);
}

function renderReadme(paperData, analysis, facts, lang) {
  const labels = COPY[lang];
  const lines = [
    `# ${paperData.title}`,
    '',
    `## ${labels.about}`,
    localizeText(analysis.oneSentence?.text || paperData.abstract || '', lang),
    '',
    `## ${labels.whyRead}`,
    `- ${labels.stepQuick}`,
    `- ${labels.stepSummary}`,
    `- ${labels.stepInsights}`,
    '',
    `## ${labels.takeaways}`,
    ...bulletLines(analysis.contributions, facts, labels),
    '',
    `## ${labels.artifacts}`,
    labels.artifactIntro,
    '- `quick-summary.md`',
    '- `summary.md`',
    '- `insights.md`',
    '- `paper.pdf`'
  ];

  const note = parserNotes(paperData, labels);
  if (note) {
    lines.push('', `## ${labels.parserNotes}`, note);
  }

  return `${lines.join('\n')}\n`;
}

function renderQuickSummary(paperData, analysis, facts, lang) {
  const labels = COPY[lang];
  const lines = [
    `# ${labels.quickSummaryTitle}: ${paperData.title}`,
    '',
    `## ${labels.oneSentence}`,
    localizeText(analysis.oneSentence?.text || '', lang),
    '',
    `## ${labels.problem}`,
    localizeText(analysis.problem?.text || '', lang),
    '',
    `## ${labels.coreIdea}`,
    localizeText(analysis.coreIdea?.text || '', lang),
    '',
    `## ${labels.contributions}`,
    ...bulletLines(analysis.contributions, facts, labels),
    '',
    `## ${labels.results}`,
    renderResultTable(analysis.resultsTable, facts, labels),
    '',
    `## ${labels.whyItMatters}`,
    whyItMatters(analysis, labels),
    '',
    `## ${labels.limitations}`,
    ...bulletLines(analysis.limitations, facts, labels, { includeSource: true })
  ];

  return `${lines.join('\n')}\n`;
}

function renderStructuredSummary(paperData, analysis, facts, lang) {
  const labels = COPY[lang];
  const lines = [
    `# ${labels.summaryTitle}: ${paperData.title}`,
    '',
    `## ${labels.background}`,
    localizeText(analysis.oneSentence?.text || paperData.abstract || '', lang),
    '',
    `## ${labels.problemStatement}`,
    `${localizeText(analysis.problem?.text || '', lang)} (${labels.source}: ${formatSources(analysis.problem?.evidenceRefs, facts, lang)})`,
    '',
    `## ${labels.coreIdea}`,
    `${localizeText(analysis.coreIdea?.text || '', lang)} (${labels.source}: ${formatSources(analysis.coreIdea?.evidenceRefs, facts, lang)})`,
    '',
    `## ${labels.contributions}`,
    ...bulletLines(analysis.contributions, facts, labels, { includeSource: true }),
    '',
    `## ${labels.results}`,
    renderResultTable(analysis.resultsTable, facts, labels),
    '',
    `## ${labels.limitations}`,
    ...bulletLines(analysis.limitations, facts, labels, { includeSource: true }),
    '',
    `## ${labels.openQuestions}`,
    ...(Array.isArray(analysis.openQuestions) && analysis.openQuestions.length > 0
      ? analysis.openQuestions.map((item) => `- ${localizeOpenQuestion(item.text, lang)} (${labels.source}: ${formatSources(item.evidenceRefs, facts, lang)})`)
      : [`- ${labels.noQuestions}`])
  ];

  return `${lines.join('\n')}\n`;
}

function renderInsights(paperData, analysis, facts, lang) {
  const labels = COPY[lang];
  const mechanismLines = Array.isArray(analysis.contributions) && analysis.contributions.length > 0
    ? bulletLines(analysis.contributions, facts, labels, { includeSource: true })
    : ['- N/A'];

  const lines = [
    `# ${labels.insightsTitle}: ${paperData.title}`,
    '',
    `## ${labels.coreShift}`,
    coreShift(analysis, labels) || localizeText(analysis.coreIdea?.text || '', lang),
    '',
    `## ${labels.whyWorks}`,
    labels.whyWorksIntro,
    ...mechanismLines,
    '',
    `## ${labels.tradeoffs}`,
    ...bulletLines(analysis.limitations, facts, labels, { includeSource: true }),
    '',
    `## ${labels.practicalImplications}`,
    practicalImplications(analysis, labels),
    '',
    `## ${labels.openQuestions}`,
    ...(Array.isArray(analysis.openQuestions) && analysis.openQuestions.length > 0
      ? analysis.openQuestions.map((item) => `- ${localizeOpenQuestion(item.text, lang)} (${labels.source}: ${formatSources(item.evidenceRefs, facts, lang)})`)
      : [`- ${labels.noQuestions}`])
  ];

  return `${lines.join('\n')}\n`;
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content);
}

export function renderMaterialsForPaper(input, profile = 'all', lang = 'en') {
  const paperDir = resolvePaperDir(input);
  const language = pickLanguage(lang);
  const paperData = readJson(path.join(paperDir, 'paper-data.json'));
  const facts = readJson(path.join(paperDir, 'facts.json'));
  const analysis = readJson(path.join(paperDir, 'analysis.json'));
  const writtenFiles = [];

  if (profile === 'summary' || profile === 'all') {
    const quickSummaryPath = path.join(paperDir, 'quick-summary.md');
    writeFile(quickSummaryPath, renderQuickSummary(paperData, analysis, facts, language));
    writtenFiles.push(quickSummaryPath);
  }

  if (profile === 'study' || profile === 'all') {
    const readmePath = path.join(paperDir, 'README.md');
    const summaryPath = path.join(paperDir, 'summary.md');
    const insightsPath = path.join(paperDir, 'insights.md');
    writeFile(readmePath, renderReadme(paperData, analysis, facts, language));
    writeFile(summaryPath, renderStructuredSummary(paperData, analysis, facts, language));
    writeFile(insightsPath, renderInsights(paperData, analysis, facts, language));
    writtenFiles.push(readmePath, summaryPath, insightsPath);
  }

  return {
    paperSlug: paperData.paperSlug,
    paperDir,
    language,
    profile,
    writtenFiles
  };
}

async function runCli() {
  const input = process.argv[2];
  const profile = process.argv[3] || 'all';
  const lang = process.argv[4] || 'en';

  if (!input) {
    console.error('Usage: node render-from-analysis.js <paper-slug-or-dir> [summary|study|all] [en|zh]');
    process.exit(1);
  }

  const result = renderMaterialsForPaper(input, profile, lang);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  runCli().catch((error) => {
    console.error(`Error rendering materials: ${error.message}`);
    process.exit(1);
  });
}
