import { makeEvidenceId, makeSectionId, normalizeEvidenceText } from './evidence-utils.js';

const SCHEMA_VERSION = '2.0.0';

const SECTION_ALIASES = [
  ['abstract', ['abstract', '摘要']],
  ['introduction', ['introduction', 'introductions', '引言', '简介']],
  ['related_work', ['related work', 'prior work', '相关工作', '已有工作']],
  ['background', ['background', 'preliminaries', '背景', '预备知识']],
  ['method', ['method', 'methods', 'approach', 'framework', 'proposed method', '方法', '模型', '框架']],
  ['theory', ['theory', 'analysis', '理论', '理论分析']],
  ['experiments', ['experiments', 'experimental setup', '实验', '实验设置']],
  ['evaluation', ['evaluation', '评测', '评价']],
  ['results', ['results', 'main results', '结果']],
  ['ablation', ['ablation', 'ablation study', '消融', '消融实验']],
  ['discussion', ['discussion', '讨论']],
  ['limitations', ['limitations', 'limitations and future work', '局限性', '限制']],
  ['conclusion', ['conclusion', 'conclusions', '结论']],
  ['appendix', ['appendix', 'appendices', '附录']],
  ['references', ['references', 'bibliography', '参考文献']]
];

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[\s\d.、:：-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalRoleForTitle(title) {
  const normalized = normalizeTitle(title);
  for (const [role, aliases] of SECTION_ALIASES) {
    if (aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias} `))) {
      return role;
    }
  }
  return 'other';
}

function headingLevelFromText(text) {
  const match = String(text || '').trim().match(/^(\d+(?:\.\d+)*)/);
  if (!match) return 1;
  return Math.min(match[1].split('.').length, 6);
}

function looksLikeHeading(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 120) return false;
  if (/^(?:\d+(?:\.\d+)*\.?|[A-Z]\.)\s+[A-Z\u4e00-\u9fff]/.test(value)) return true;
  if (/^(?:abstract|introduction|related work|background|preliminaries|method|methods|approach|framework|proposed method|experiments?|experimental setup|evaluation|results?|ablation|discussion|limitations?|conclusions?|references|appendix)\b/i.test(value)) return true;
  if (/^(?:摘要|引言|简介|相关工作|背景|预备知识|方法|模型|框架|实验|评测|评价|结果|消融|讨论|局限性|限制|结论|参考文献|附录)(?:\s|$|[:：、])/.test(value)) return true;
  return false;
}

function pageForOffset(pages, offset) {
  return pages.find((page) => offset >= page.rawTextStart && offset <= page.rawTextEnd) || pages[0] || null;
}

function sectionForOffset(sections, offset) {
  let selected = null;
  for (const section of sections) {
    if (offset >= section.startOffset && offset <= section.endOffset) {
      selected = section;
    }
  }
  return selected;
}

function sectionCoverageFor(sections) {
  const meaningful = sections.filter((section) => section.canonicalRole !== 'other');
  if (meaningful.length >= 3) return 'high';
  if (meaningful.length > 0) return 'partial';
  return 'none';
}

function findLocalOffset(pageText, text, searchFrom = 0) {
  const exact = pageText.indexOf(text, searchFrom);
  if (exact >= 0) return exact;

  const compact = normalizeEvidenceText(text);
  const fallback = pageText.indexOf(compact, searchFrom);
  return fallback >= 0 ? fallback : searchFrom;
}

function extractLabel(text, kind) {
  const figure = text.match(/\b(?:Figure|Fig\.)\s*\d+[A-Za-z]?\b/i) || text.match(/图\s*\d+[A-Za-z]?/);
  const table = text.match(/\bTable\s*\d+[A-Za-z]?\b/i) || text.match(/表\s*\d+[A-Za-z]?/);
  const equation = text.match(/\b(?:Equation|Eq\.)\s*\(?\d+[A-Za-z]?\)?/i) || text.match(/公式\s*\(?\d+[A-Za-z]?\)?/);

  return {
    figureNumber: figure && (kind === 'figure' || kind === 'caption') ? figure[0].replace(/\s+/g, ' ') : null,
    tableNumber: table && (kind === 'table' || kind === 'caption') ? table[0].replace(/\s+/g, ' ') : null,
    equationNumber: equation && kind === 'equation' ? equation[0].replace(/\s+/g, ' ') : null
  };
}

function classifyEvidenceKind(text, section, block) {
  const value = String(text || '').trim();
  if (section?.canonicalRole === 'references') return 'reference';
  if (section?.canonicalRole === 'abstract') return 'abstract';
  if (block?.isHeadingCandidate || looksLikeHeading(value)) return 'heading';
  if (/^(?:Figure|Fig\.|Table)\s*\d+|^(?:图|表)\s*\d+/i.test(value)) {
    return /\bTable\b|^表/i.test(value) ? 'table' : 'figure';
  }
  if (/\b(?:Figure|Fig\.|Table)\s*\d+[:.]|(?:图|表)\s*\d+[:：]/i.test(value)) return 'caption';
  if (/^\(?\d+\)?\s*[=:]|\\begin\{equation\}|\\\[[\s\S]*\\\]/.test(value)) return 'equation';
  if (/^\s*[*†‡]\s+/.test(value)) return 'footnote';
  return 'paragraph';
}

export function classifyEvidenceRoles(text, context = {}) {
  const value = String(text || '');
  const sectionRole = context.section?.canonicalRole;
  const kind = context.kind;
  const roles = new Set();

  if (sectionRole === 'abstract') roles.add('claim_candidate');
  if (sectionRole === 'method') roles.add('method');
  if (sectionRole === 'theory') roles.add('definition');
  if (sectionRole === 'experiments' || sectionRole === 'evaluation') roles.add('experiment_setup');
  if (sectionRole === 'results') roles.add('result');
  if (sectionRole === 'ablation') roles.add('ablation');
  if (sectionRole === 'limitations') roles.add('limitation');

  if (/\b(?:problem|challenge|difficulty|limitation|bottleneck|问题|挑战|瓶颈)\b/i.test(value)) roles.add('problem');
  if (/\b(?:motivat|important|need|why|crucial|重要|动机|需要)\b/i.test(value)) roles.add('motivation');
  if (/\b(?:prior work|previous|existing|baseline|传统|已有|现有)\b/i.test(value)) roles.add('prior_work');
  if (/\b(?:gap|however|yet|缺口|不足|然而)\b/i.test(value)) roles.add('gap');
  if (/\b(?:propose|present|introduce|show|demonstrate|claim|本文|提出|证明|表明)\b/i.test(value)) roles.add('claim_candidate');
  if (/\b(?:module|component|architecture|algorithm|pipeline|mechanism|模块|组件|架构|算法|机制)\b/i.test(value)) roles.add('mechanism');
  if (/\b(?:assume|assumption|假设)\b/i.test(value)) roles.add('assumption');
  if (/\b(?:experiment|setup|dataset|metric|baseline|benchmark|实验|数据集|指标|基准)\b/i.test(value)) roles.add('experiment_setup');
  if (/\b(?:outperform|improve|achieve|accuracy|bleu|score|提升|优于|达到|准确率)\b/i.test(value)) roles.add('result');
  if (/\b(?:ablation|remove|without|消融|移除)\b/i.test(value)) roles.add('ablation');
  if (/\b(?:future work|future research|未来工作|后续)\b/i.test(value)) roles.add('future_work');
  if (/\b(?:define|definition|denote|定义|记作)\b/i.test(value)) roles.add('definition');
  if (kind === 'table') roles.add('result');

  return Array.from(roles);
}

function buildPagesFromParsed(parsed) {
  if (Array.isArray(parsed.pages) && parsed.pages.length > 0 && typeof parsed.pages[0] === 'object') {
    return parsed.pages.map((page, index) => {
      const text = String(page.text || '');
      return {
        page: Number(page.page) || index + 1,
        text,
        rawTextStart: Number(page.rawTextStart) || 0,
        rawTextEnd: Number(page.rawTextEnd) || text.length,
        blockCount: Number(page.blockCount) || (Array.isArray(page.blocks) ? page.blocks.length : 0),
        ...(Array.isArray(page.blocks) ? { blocks: page.blocks } : {})
      };
    });
  }

  if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
    let offset = 0;
    return parsed.pages.map((textValue, index) => {
      const text = String(textValue || '');
      const rawTextStart = offset;
      const rawTextEnd = rawTextStart + text.length;
      offset = rawTextEnd + 2;
      return {
        page: index + 1,
        text,
        rawTextStart,
        rawTextEnd,
        blockCount: text ? 1 : 0
      };
    });
  }

  const text = String(parsed.rawText || parsed.publicData?.rawText || '');
  return [{
    page: 1,
    text,
    rawTextStart: 0,
    rawTextEnd: text.length,
    blockCount: text ? 1 : 0
  }];
}

export function buildSectionTree({ pages, rawText, parserMetadata = {} }) {
  const headings = [];
  const perPageOrdinal = new Map();

  for (const page of pages) {
    const candidates = Array.isArray(page.blocks) && page.blocks.length > 0
      ? page.blocks.map((block) => ({
        text: block.text,
        localOffset: findLocalOffset(page.text, block.text),
        confidence: block.isHeadingCandidate ? 'high' : 'medium'
      }))
      : page.text.split('\n').map((line) => ({
        text: line,
        localOffset: page.text.indexOf(line),
        confidence: 'medium'
      }));

    for (const candidate of candidates) {
      const title = normalizeEvidenceText(candidate.text).replace(/\n+/g, ' ');
      if (!looksLikeHeading(title)) continue;
      const canonicalRole = canonicalRoleForTitle(title);
      const pageStart = page.page;
      const ordinalKey = `${pageStart}:${canonicalRole}`;
      const ordinal = (perPageOrdinal.get(ordinalKey) || 0) + 1;
      perPageOrdinal.set(ordinalKey, ordinal);
      const startOffset = page.rawTextStart + Math.max(0, candidate.localOffset || 0);
      headings.push({
        id: makeSectionId({ pageStart, canonicalRole, ordinal }),
        title,
        normalizedTitle: normalizeTitle(title),
        canonicalRole,
        level: headingLevelFromText(title),
        pageStart,
        pageEnd: pageStart,
        startOffset,
        endOffset: startOffset,
        confidence: canonicalRole === 'other' ? 'low' : candidate.confidence
      });
    }
  }

  if (headings.length === 0) {
    const firstPage = pages[0] || { page: 1, rawTextStart: 0 };
    headings.push({
      id: makeSectionId({ pageStart: firstPage.page, canonicalRole: 'other', ordinal: 1 }),
      title: 'Document',
      normalizedTitle: 'document',
      canonicalRole: 'other',
      level: 1,
      pageStart: firstPage.page,
      pageEnd: pages.at(-1)?.page || firstPage.page,
      startOffset: 0,
      endOffset: rawText.length,
      confidence: 'low'
    });
  }

  headings.sort((left, right) => left.startOffset - right.startOffset);

  for (let index = 0; index < headings.length; index += 1) {
    const section = headings[index];
    const next = headings[index + 1];
    const endOffset = next ? Math.max(section.startOffset, next.startOffset - 1) : rawText.length;
    const endPage = pageForOffset(pages, endOffset)?.page || section.pageStart;
    section.endOffset = endOffset;
    section.pageEnd = Math.max(section.pageStart, endPage);
  }

  if (parserMetadata?.warnings?.length) {
    return headings.map((section) => ({
      ...section,
      confidence: section.confidence === 'high' ? 'medium' : section.confidence
    }));
  }

  return headings;
}

function paragraphItemsForPage(page) {
  if (Array.isArray(page.blocks) && page.blocks.length > 0) {
    return page.blocks
      .map((block, index) => ({
        text: normalizeEvidenceText(block.text),
        blockIndex: Number(block.index) || index,
        bbox: Array.isArray(block.bbox) ? block.bbox : null,
        localOffset: findLocalOffset(page.text, normalizeEvidenceText(block.text)),
        block
      }))
      .filter((item) => item.text);
  }

  const chunks = page.text
    .split(/\n{2,}/)
    .flatMap((chunk) => chunk.split(/\n(?=(?:\d+(?:\.\d+)*\.?\s+)?(?:Abstract|Introduction|Related Work|Background|Method|Methods|Approach|Experiments?|Evaluation|Results?|Ablation|Discussion|Limitations?|Conclusions?|References|Appendix|摘要|引言|相关工作|方法|实验|评测|结果|结论|参考文献|附录)\b)/i))
    .map(normalizeEvidenceText)
    .filter(Boolean);

  let searchFrom = 0;
  return chunks.map((text) => {
    const localOffset = findLocalOffset(page.text, text, searchFrom);
    searchFrom = localOffset + text.length;
    return {
      text,
      blockIndex: null,
      bbox: null,
      localOffset,
      block: null
    };
  });
}

export function splitPageIntoEvidence({ page, sections }) {
  const items = paragraphItemsForPage(page);
  return items.map((item) => {
    const charStart = page.rawTextStart + item.localOffset;
    const charEnd = charStart + item.text.length;
    const section = sectionForOffset(sections, charStart);
    const kind = classifyEvidenceKind(item.text, section, item.block);
    const labels = extractLabel(item.text, kind);
    const roles = classifyEvidenceRoles(item.text, { section, kind });

    return {
      id: makeEvidenceId({
        page: page.page,
        kind,
        text: item.text,
        charStart
      }),
      kind,
      roles,
      text: item.text,
      quote: item.text.length > 500 ? `${item.text.slice(0, 497)}...` : item.text,
      location: {
        page: page.page,
        sectionId: section?.id || null,
        charStart,
        charEnd,
        blockIndex: item.blockIndex,
        bbox: item.bbox
      },
      labels,
      source: 'paper',
      confidence: item.block ? 'high' : 'medium'
    };
  });
}

function inferLanguage(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk > latin * 0.2) return 'zh';
  return 'en';
}

function uniqueEvidence(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

export function buildEvidenceLedger({ parsed, source = {}, paperSlug }) {
  const detailed = parsed.publicData ? parsed : {
    publicData: parsed,
    rawText: parsed.rawText || '',
    pages: parsed.pages,
    sectionTree: parsed.sectionTree,
    parserMetadata: parsed.parserMetadata || {}
  };

  const publicData = detailed.publicData || {};
  const pages = buildPagesFromParsed({
    pages: detailed.pages,
    rawText: detailed.rawText || publicData.rawText || ''
  });
  const rawText = String(detailed.rawText || pages.map((page) => page.text).join('\n\n'));
  const parserMetadata = detailed.parserMetadata || {};
  const sections = Array.isArray(detailed.sectionTree) && detailed.sectionTree.length > 0
    ? detailed.sectionTree
    : buildSectionTree({ pages, rawText, parserMetadata });
  const evidence = uniqueEvidence(pages.flatMap((page) => splitPageIntoEvidence({ page, sections })));
  const parserName = parserMetadata.parser === 'pdf-parse' ? 'pdf-parse' : (parserMetadata.parser === 'pymupdf' ? 'pymupdf' : 'unknown');
  const warnings = [
    ...(Array.isArray(publicData.warnings) ? publicData.warnings : []),
    ...(Array.isArray(parserMetadata.warnings) ? parserMetadata.warnings : [])
  ].filter(Boolean);

  return {
    schemaVersion: SCHEMA_VERSION,
    paperSlug: paperSlug || publicData.paperSlug || '',
    parserVersion: publicData.parserVersion || parserMetadata.parserVersion || '0.0.0',
    generatedAt: new Date().toISOString(),
    document: {
      title: publicData.title || '',
      authors: Array.isArray(publicData.authors) ? publicData.authors : [],
      pageCount: Number(publicData.pageCount) || pages.length,
      language: inferLanguage(rawText),
      sourceUrl: source.sourceUrl || publicData.sourceUrl || null,
      sha256: source.sha256 || null
    },
    sections,
    pages,
    evidence,
    quality: {
      parser: parserName,
      readingOrder: parserName === 'pymupdf' ? 'high' : 'low',
      sectionCoverage: sectionCoverageFor(sections),
      tableExtraction: evidence.some((item) => item.kind === 'table') ? 'text-only' : 'none',
      warnings: Array.from(new Set(warnings))
    }
  };
}
