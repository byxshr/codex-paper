import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { askCodexWorker } from '../../../utils/codexWorker'
import { appendChatNote } from '../../../utils/chatNotes'

const MAX_QUESTION_LENGTH = 4_000
const MAX_SELECTED_FILE_LENGTH = 500

const activeRequests = new Set<string>()

const FORBIDDEN_RESIDUES = [
  'analysisVersion',
  'evidenceRefs',
  'coreClaims',
  'sourceType',
  'evidence-ledger',
  'external-evidence',
  'reasoning-analysis',
  'Result 1',
  'See evidence'
]

function validateSlug(slug: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)
}

function getPaperDir(slug: string) {
  const papersRoot = path.join(homedir(), 'codex-papers/papers')
  const paperDir = path.resolve(papersRoot, slug)
  const relativePath = path.relative(papersRoot, paperDir)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Access denied'
    })
  }

  if (!fs.existsSync(paperDir) || !fs.statSync(paperDir).isDirectory()) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Paper directory not found'
    })
  }

  return paperDir
}

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
6. Do not expose internal JSON field names, evidence IDs, parser object paths, or extraction labels such as analysisVersion, evidenceRefs, coreClaims, sourceType, Result 1, or See evidence.
7. If the available learning package and paper evidence cannot answer the question with confidence, say that the evidence is insufficient and explain what is missing.
8. Keep the answer focused and cite sources naturally, such as "基于 summary.md", "根据实验部分", or "论文 p.8，Table 3", without exposing machine IDs.
9. When using reasoning-analysis, distinguish paper claims, external facts, analysis inferences, and research speculations in natural language.
10. Do not turn an inference or speculation into a statement that the paper itself made.`
}

function findForbiddenResidues(text: string) {
  const residues = FORBIDDEN_RESIDUES.filter((residue) => text.includes(residue))
  if (/\bev-p\d{3}-[a-z]+-[a-f0-9]{10}\b/.test(text)) {
    residues.push('ev-*')
  }
  return residues
}

function redactForbiddenResidues(text: string) {
  return FORBIDDEN_RESIDUES.reduce(
    (current, residue) => current.split(residue).join('[internal field]'),
    text
  )
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

  const paperDir = getPaperDir(slug)
  const fallbackPrompt = buildPaperChatPrompt(paperDir, question, selectedFile)

  if (activeRequests.has(slug)) {
    throw createFallbackError(
      409,
      'Codex is already answering a question for this paper',
      fallbackPrompt
    )
  }

  activeRequests.add(slug)

  try {
    const { answer } = await askCodexWorker({
      slug,
      paperDir,
      prompt: fallbackPrompt
    })

    if (!answer) {
      throw createFallbackError(
        502,
        'Codex returned an empty answer',
        fallbackPrompt
      )
    }

    const forbiddenResidues = findForbiddenResidues(answer)
    if (forbiddenResidues.length > 0) {
      throw createFallbackError(
        502,
        'Codex answer contained internal extraction residue',
        fallbackPrompt,
        `Forbidden residues: ${forbiddenResidues.join(', ')}`
      )
    }

    const savedNote = appendChatNote(
      paperDir,
      redactForbiddenResidues(question),
      redactForbiddenResidues(answer),
      selectedFile
    )

    return {
      answer,
      savedTo: savedNote.savedTo,
      entryId: savedNote.entryId
    }
  } catch (e: any) {
    if (e.statusCode) {
      throw e
    }

    throw createFallbackError(
      502,
      'Failed to run Codex for this question',
      fallbackPrompt,
      e.message
    )
  } finally {
    activeRequests.delete(slug)
  }
})
