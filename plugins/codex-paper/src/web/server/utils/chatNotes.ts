import fs from 'fs'
import path from 'path'

interface ChatNoteEntry {
  id: string
  timestamp: string
  selectedFile: string
  question: string
  answer: string
  sourceNote: string
}

const CHAT_NOTES_FILENAME = 'chat-notes.md'
const DEFAULT_SOURCE_NOTE = '本回答由 Codex 基于学习包、隐藏问答导航包和本地论文证据生成。'

function normalizeLines(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function makeEntryId(timestamp: string, usedIds: Set<string>) {
  const base = `chat-${slugify(timestamp) || 'note'}`
  let id = base
  let suffix = 2

  while (usedIds.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }

  usedIds.add(id)
  return id
}

function summarizeQuestion(question: string) {
  const compact = question.replace(/\s+/g, ' ').trim()
  if (compact.length <= 42) {
    return compact
  }
  return `${compact.slice(0, 42)}...`
}

function formatDirectoryTimestamp(timestamp: string) {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

function extractBetween(body: string, startLabel: string, endLabel: string) {
  const pattern = new RegExp(`${startLabel}\\s*\\n\\n([\\s\\S]*?)(?:\\n\\n${endLabel}|$)`)
  const match = body.match(pattern)
  return match?.[1]?.trim() || ''
}

function parseSelectedFile(body: string) {
  const match = body.match(/当前材料：(?:`([^`]+)`|([^\n]+))/)
  const value = (match?.[1] || match?.[2] || '').trim()
  return value === '未指定' ? '' : value
}

function parseExistingEntries(rawText: string): ChatNoteEntry[] {
  const text = normalizeLines(rawText)
  const entryPattern = /(?:^|\n)---\n\n(?:<a id="([^"]+)"><\/a>\n)?## ([^\n]+)\n([\s\S]*?)(?=\n---\n\n(?:<a id="[^"]+"><\/a>\n)?## |\s*$)/g
  const usedIds = new Set<string>()
  const entries: ChatNoteEntry[] = []
  let match: RegExpExecArray | null

  while ((match = entryPattern.exec(text))) {
    const anchorId = match[1] || ''
    const title = match[2].trim()
    const body = `## ${title}\n${match[3].trim()}`
    const timestamp = title.match(/\d{4}-\d{2}-\d{2}T[^\s]+Z/)?.[0] || title
    const question = extractBetween(body, '### 问题', '### 回答')
    const answer = extractBetween(body, '### 回答', '### 来源说明')

    if (!question || !answer) {
      continue
    }

    const selectedFile = parseSelectedFile(body)
    const sourceNote = extractBetween(body, '### 来源说明', '---') || DEFAULT_SOURCE_NOTE
    let id = anchorId
    if (!id || usedIds.has(id)) {
      id = makeEntryId(timestamp, usedIds)
    } else {
      usedIds.add(id)
    }

    entries.push({
      id,
      timestamp,
      selectedFile,
      question,
      answer,
      sourceNote
    })
  }

  return entries
}

function formatEntry(entry: ChatNoteEntry) {
  const selectedFileLine = entry.selectedFile ? `当前材料：\`${entry.selectedFile}\`` : '当前材料：未指定'

  return [
    '---',
    '',
    `<a id="${entry.id}"></a>`,
    `## ${entry.timestamp}`,
    '',
    selectedFileLine,
    '',
    '### 问题',
    '',
    entry.question.trim(),
    '',
    '### 回答',
    '',
    entry.answer.trim(),
    '',
    '### 来源说明',
    '',
    entry.sourceNote.trim() || DEFAULT_SOURCE_NOTE
  ].join('\n')
}

function renderChatNotes(entries: ChatNoteEntry[]) {
  const directory = entries.length > 0
    ? entries.map((entry) => {
        const fileLabel = entry.selectedFile || '未指定材料'
        const title = `${formatDirectoryTimestamp(entry.timestamp)} · ${summarizeQuestion(entry.question)} · ${fileLabel}`
        return `- [${title}](#${entry.id})`
      }).join('\n')
    : '- 暂无问答记录'

  return [
    '# Chat Notes',
    '',
    '## 目录',
    '',
    directory,
    '',
    ...entries.map(formatEntry),
    ''
  ].join('\n')
}

export function appendChatNote(paperDir: string, question: string, answer: string, selectedFile: string) {
  const chatNotesPath = path.join(paperDir, CHAT_NOTES_FILENAME)
  const rawText = fs.existsSync(chatNotesPath) ? fs.readFileSync(chatNotesPath, 'utf8') : ''
  const entries = parseExistingEntries(rawText)
  const usedIds = new Set(entries.map((entry) => entry.id))
  const timestamp = new Date().toISOString()
  const entry: ChatNoteEntry = {
    id: makeEntryId(timestamp, usedIds),
    timestamp,
    selectedFile,
    question,
    answer,
    sourceNote: DEFAULT_SOURCE_NOTE
  }

  entries.push(entry)
  fs.writeFileSync(chatNotesPath, renderChatNotes(entries), 'utf8')

  return {
    entryId: entry.id,
    savedTo: CHAT_NOTES_FILENAME
  }
}
