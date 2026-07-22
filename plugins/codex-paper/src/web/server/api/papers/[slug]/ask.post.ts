import { askCodexWorker } from '../../../utils/codexWorker'
import { appendChatNote } from '../../../utils/chatNotes'
import { requireWritablePaperAccess, resolvePublicFile, validateSlug } from '../../../utils/librarySecurity.mjs'
import { withOperationLocks } from '../../../utils/operationLocks.mjs'
import { renderSafeMarkdownForDelivery } from '../../../utils/activeContentSecurity.mjs'
import { acquirePaperAskLease } from '../../../utils/askLeases.mjs'

const MAX_QUESTION_LENGTH = 4_000
const MAX_SELECTED_FILE_LENGTH = 500

const FORBIDDEN_RESIDUES = [
  'analysisVersion',
  'evidenceRefs',
  'coreClaims',
  'sourceType',
  'evidence-ledger',
  'external-evidence',
  'reasoning-analysis'
]

const FORBIDDEN_RESIDUE_PATTERNS = [
  { label: 'ev-*', pattern: /\bev-p\d{3,}-[a-z]+-[a-f0-9]{10}\b/g },
  { label: 'ext-*', pattern: /\bext-[a-zA-Z0-9._-]+\b/g }
]

function normalizeBodyText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.replace(/\0/g, '').replace(/\r\n/g, '\n').trim().slice(0, maxLength)
}

function buildPaperChatPrompt(paperDir: string, question: string, selectedFile: string) {
  const selectedFileLine = selectedFile ? `Current Web UI file: ${selectedFile}` : 'Current Web UI file: not specified'

  return `Use $paper-chat if it is available. Answer a follow-up question about the local paper learning package below.

Paper package directory:
${paperDir}

${selectedFileLine}

User question:
${question}

Answering rules:
1. Answer in the same language as the user question. For Chinese questions, use Chinese prose except for proper nouns and established technical terms.
2. Prefer evidence in this order: user-visible study materials, reasoning-analysis.json, .codex-paper/answering-pack.md, evidence-ledger.json, facts.json / analysis.json / paper-data.json, then paper-data.rawText or the local paper.pdf text if needed.
3. Only move to the next evidence layer when the previous layer is insufficient.
4. Do not use live web search. Use only local files in the paper package.
5. Do not write or modify files; the Web UI will save the final answer.
6. Do not expose internal JSON field names, evidence IDs, parser object paths, or extraction labels such as analysisVersion, evidenceRefs, coreClaims, or sourceType.
7. If the available learning package and paper evidence cannot answer the question with confidence, say that the evidence is insufficient and explain what is missing.
8. Keep the answer focused and cite sources naturally, such as "基于 summary.md", "根据实验部分", or "论文 p.8，Table 3", without exposing machine IDs.
9. When using reasoning-analysis, distinguish paper claims, external facts, analysis inferences, and research speculations in natural language.
10. Do not turn an inference or speculation into a statement that the paper itself made.`
}

function findForbiddenResidues(text: string) {
  const residues = FORBIDDEN_RESIDUES.filter((residue) => text.includes(residue))
  for (const { label, pattern } of FORBIDDEN_RESIDUE_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      residues.push(label)
    }
  }
  return residues
}

function redactForbiddenResidues(text: string) {
  const withoutFieldNames = FORBIDDEN_RESIDUES.reduce(
    (current, residue) => current.split(residue).join('[internal field]'),
    text
  )
  return FORBIDDEN_RESIDUE_PATTERNS.reduce((current, { pattern }) => {
    pattern.lastIndex = 0
    return current.replace(pattern, '[internal evidence id]')
  }, withoutFieldNames)
}

function createFallbackError(statusCode: number, statusMessage: string, fallbackPrompt: string, detail?: string) {
  return createError({
    statusCode,
    statusMessage,
    data: {
      fallbackPrompt,
      detail
    }
  })
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')

  if (!slug || !validateSlug(slug)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Valid paper slug is required'
    })
  }

  const body = await readBody(event)
  const question = normalizeBodyText(body?.question, MAX_QUESTION_LENGTH)
  const selectedFile = normalizeBodyText(body?.selectedFile, MAX_SELECTED_FILE_LENGTH)

  if (!question) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Question is required'
    })
  }

  const descriptor = requireWritablePaperAccess(slug)
  const paperDir = descriptor.packageDir
  if (selectedFile) resolvePublicFile(slug, selectedFile)
  const fallbackPrompt = buildPaperChatPrompt(paperDir, question, selectedFile)
  const safeFallbackPrompt = fallbackPrompt.split(paperDir).join('[local paper package]')

  const releaseAskLease = acquirePaperAskLease(descriptor.paperLockKey)
  try {
    const { answer } = await askCodexWorker({
      slug: descriptor.paperLockKey,
      paperDir,
      prompt: fallbackPrompt
    })

    if (!answer) {
      throw createFallbackError(
        502,
        'Codex returned an empty answer',
        safeFallbackPrompt
      )
    }

    const forbiddenResidues = findForbiddenResidues(answer)
    if (forbiddenResidues.length > 0) {
      throw createFallbackError(
        502,
        'Codex answer contained internal extraction residue',
        safeFallbackPrompt,
        `Forbidden residues: ${forbiddenResidues.join(', ')}`
      )
    }

    let savedNote: { savedTo: string; entryId: string } | null = null
    let saveWarning: string | null = null
    let completedNote: { savedTo: string; entryId: string } | null = null
    try {
      savedNote = await withOperationLocks([descriptor.paperLockKey], async () => (
        completedNote = appendChatNote(
          descriptor.overlayDir,
          redactForbiddenResidues(question),
          redactForbiddenResidues(answer),
          selectedFile,
          descriptor.paperLockKey
        )
      ), { timeoutMs: 3_000 })
    } catch (saveError: any) {
      savedNote = completedNote
      saveWarning = completedNote
        ? '回答已写入聊天记录，但保存确认遇到异常。请检查历史记录后再重试。'
        : '回答已生成，但聊天记录暂未保存。请先复制回答，稍后重试。'
    }

    const renderedAnswer = renderSafeMarkdownForDelivery(answer, { slug, sourcePath: savedNote?.savedTo || 'chat-notes.md' })
    if (renderedAnswer.degraded) {
      const renderWarning = '回答已生成，但富文本渲染失败，已使用安全纯文本显示。'
      saveWarning = saveWarning ? `${saveWarning} ${renderWarning}` : renderWarning
    }

    return {
      answer,
      answerHtml: renderedAnswer.html,
      saved: Boolean(savedNote),
      saveWarning,
      savedTo: savedNote?.savedTo || null,
      entryId: savedNote?.entryId || null
    }
  } catch (e: any) {
    if (e.statusCode) throw e
    throw createFallbackError(
      502,
      'Failed to run Codex for this question',
      safeFallbackPrompt
    )
  } finally {
    releaseAskLease()
  }
})
