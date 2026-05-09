import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { homedir, tmpdir } from 'os'

const ASK_TIMEOUT_MS = 180_000
const MAX_QUESTION_LENGTH = 4_000
const MAX_SELECTED_FILE_LENGTH = 500
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

const activeRequests = new Set<string>()

const FORBIDDEN_RESIDUES = [
  'analysisVersion',
  'evidenceRefs',
  'coreClaims',
  'Result 1',
  'See evidence'
]

function isExecutable(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function getNvmCodexCandidates() {
  const versionsDir = path.join(homedir(), '.nvm/versions/node')

  try {
    return fs.readdirSync(versionsDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => path.join(versionsDir, version, 'bin/codex'))
  } catch {
    return []
  }
}

function resolveCodexBin() {
  const pathCandidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'codex'))

  const candidates = [
    process.env.CODEX_BIN,
    path.join(path.dirname(process.execPath), 'codex'),
    ...pathCandidates,
    ...getNvmCodexCandidates(),
    path.join(homedir(), '.volta/bin/codex'),
    path.join(homedir(), '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ].filter(Boolean) as string[]

  return Array.from(new Set(candidates)).find(isExecutable) || 'codex'
}

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
2. Prefer evidence in this order: user-visible study materials, .codex-paper/answering-pack.md, facts.json / analysis.json / paper-data.json, then paper-data.rawText or the local paper.pdf text if needed.
3. Only move to the next evidence layer when the previous layer is insufficient.
4. Do not use live web search. Use only local files in the paper package.
5. Do not write or modify files; the Web UI will save the final answer.
6. Do not expose internal JSON field names, evidence IDs, parser object paths, or extraction labels such as analysisVersion, evidenceRefs, coreClaims, Result 1, or See evidence.
7. If the available learning package and paper evidence cannot answer the question with confidence, say that the evidence is insufficient and explain what is missing.
8. Keep the answer focused and cite sources naturally, such as "基于 summary.md" or "根据实验部分", without exposing machine IDs.`
}

function findForbiddenResidues(text: string) {
  return FORBIDDEN_RESIDUES.filter((residue) => text.includes(residue))
}

function redactForbiddenResidues(text: string) {
  return FORBIDDEN_RESIDUES.reduce(
    (current, residue) => current.split(residue).join('[internal field]'),
    text
  )
}

function appendChatNote(paperDir: string, question: string, answer: string, selectedFile: string) {
  const timestamp = new Date().toISOString()
  const selectedFileLine = selectedFile ? `当前材料：\`${selectedFile}\`` : '当前材料：未指定'
  const safeQuestion = redactForbiddenResidues(question)
  const safeAnswer = redactForbiddenResidues(answer)
  const note = [
    '',
    '---',
    '',
    `## ${timestamp}`,
    '',
    selectedFileLine,
    '',
    '### 问题',
    '',
    safeQuestion,
    '',
    '### 回答',
    '',
    safeAnswer.trim(),
    '',
    '### 来源说明',
    '',
    '本回答由 Codex 基于学习包、隐藏问答导航包和本地论文证据生成。'
  ].join('\n')

  fs.appendFileSync(path.join(paperDir, 'chat-notes.md'), note, 'utf8')
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

function runCodex(codexBin: string, args: string[], prompt: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error) {
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    }

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (target === 'stdout') {
        stdout += chunk.toString('utf8')
      } else {
        stderr += chunk.toString('utf8')
      }

      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BUFFER_BYTES) {
        child.kill('SIGTERM')
        finish(new Error('Codex output exceeded the maximum buffer size.'))
      }
    }

    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('Codex timed out before returning an answer.'))
    }, ASK_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => appendOutput('stdout', chunk))
    child.stderr.on('data', (chunk) => appendOutput('stderr', chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (settled) return

      if (code === 0) {
        finish()
      } else {
        const detail = stderr.trim() || stdout.trim() || `Codex exited with code ${code}`
        finish(new Error(detail))
      }
    })

    child.stdin.end(prompt)
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

  const outputPath = path.join(tmpdir(), `codex-paper-answer-${slug}-${Date.now()}.md`)

  try {
    const codexBin = resolveCodexBin()
    const childEnv = {
      ...process.env,
      PATH: [
        path.dirname(process.execPath),
        path.dirname(codexBin),
        process.env.PATH || ''
      ].filter(Boolean).join(path.delimiter)
    }
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      paperDir,
      '-o',
      outputPath,
      '-'
    ]

    const { stdout } = await runCodex(codexBin, args, fallbackPrompt, paperDir, childEnv)

    const answer = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, 'utf8').trim()
      : stdout.trim()

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

    appendChatNote(paperDir, question, answer, selectedFile)

    return {
      answer,
      savedTo: 'chat-notes.md'
    }
  } catch (e: any) {
    if (e.statusCode) {
      throw e
    }

    const detail = e.killed && e.signal === 'SIGTERM'
      ? 'Codex timed out before returning an answer.'
      : e.message

    throw createFallbackError(
      502,
      'Failed to run Codex for this question',
      fallbackPrompt,
      detail
    )
  } finally {
    activeRequests.delete(slug)
    fs.rmSync(outputPath, { force: true })
  }
})
