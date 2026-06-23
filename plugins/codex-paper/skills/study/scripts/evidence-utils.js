import crypto from 'crypto';

const KIND_ABBREVIATIONS = {
  abstract: 'abs',
  caption: 'cap',
  equation: 'eq',
  figure: 'fig',
  footnote: 'foot',
  heading: 'head',
  paragraph: 'par',
  reference: 'ref',
  table: 'tab'
};

export function normalizeEvidenceText(text) {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactForId(text) {
  return normalizeEvidenceText(text).replace(/\s+/g, ' ');
}

function padPage(value) {
  const page = Number(value) || 0;
  return String(Math.max(0, page)).padStart(3, '0');
}

function padOrdinal(value) {
  const ordinal = Number(value) || 1;
  return String(Math.max(1, ordinal)).padStart(2, '0');
}

export function makeEvidenceId({ page, kind, text, charStart }) {
  const normalizedText = compactForId(text);
  const stableFields = [
    normalizedText,
    String(Number(page) || 0),
    String(Number(charStart) || 0)
  ].join('\u001f');
  const digest = crypto
    .createHash('sha1')
    .update(stableFields)
    .digest('hex')
    .slice(0, 10);
  const kindAbbrev = KIND_ABBREVIATIONS[kind] || KIND_ABBREVIATIONS.paragraph;
  return `ev-p${padPage(page)}-${kindAbbrev}-${digest}`;
}

export function makeSectionId({ pageStart, canonicalRole, ordinal }) {
  const role = String(canonicalRole || 'other')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'other';
  return `sec-p${padPage(pageStart)}-${role}-${padOrdinal(ordinal)}`;
}

function sectionById(sections = []) {
  return new Map(sections.map((section) => [section.id, section]));
}

export function formatEvidenceLocator(evidence, sections = []) {
  if (!evidence || typeof evidence !== 'object') {
    return '论文位置未知';
  }

  const parts = [];
  const page = evidence.location?.page ?? evidence.page;
  if (page) {
    parts.push(`论文 p.${page}`);
  } else {
    parts.push('论文');
  }

  const sectionsById = sectionById(sections);
  const section = sectionsById.get(evidence.location?.sectionId);
  if (section?.title) {
    parts.push(`§${section.title}`);
  }

  const labels = evidence.labels || {};
  for (const label of [labels.tableNumber, labels.figureNumber, labels.equationNumber].filter(Boolean)) {
    parts.push(label);
  }

  return parts.join('，');
}

export function collectEvidenceRefs(value) {
  const refs = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (Array.isArray(node.evidenceRefs)) {
      refs.push(...node.evidenceRefs.filter((ref) => typeof ref === 'string'));
    }

    Object.values(node).forEach(visit);
  };

  visit(value);
  return Array.from(new Set(refs));
}
