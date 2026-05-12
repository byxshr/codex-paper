import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'

const ASK_TIMEOUT_MS = 180_000
const MCP_INIT_TIMEOUT_MS = 30_000
const MAX_STDERR_TAIL = 16 * 1024

type JsonRpcId = number | string

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface AskCodexWorkerOptions {
  slug: string
  paperDir: string
  prompt: string
}

interface AskCodexWorkerResult {
  answer: string
  threadId: string
}

interface CodexToolOutput {
  content?: string
  threadId?: string
}

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

function parseTextToolOutput(text: string): CodexToolOutput {
  const trimmed = text.trim()
  if (!trimmed) {
    return {}
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      return {
        content: typeof parsed.content === 'string' ? parsed.content : undefined,
        threadId: typeof parsed.threadId === 'string' ? parsed.threadId : undefined
      }
    }
  } catch {
    // Plain text is also a valid MCP tool content shape.
  }

  return { content: trimmed }
}

function extractCodexToolOutput(result: any): CodexToolOutput {
  const structured = result?.structuredContent
  if (structured && typeof structured === 'object') {
    return {
      content: typeof structured.content === 'string' ? structured.content : undefined,
      threadId: typeof structured.threadId === 'string' ? structured.threadId : undefined
    }
  }

  if (typeof result?.content === 'string') {
    return parseTextToolOutput(result.content)
  }

  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('\n')

    return parseTextToolOutput(text)
  }

  if (result && typeof result === 'object') {
    return {
      content: typeof result.content === 'string' ? result.content : undefined,
      threadId: typeof result.threadId === 'string' ? result.threadId : undefined
    }
  }

  return {}
}

function formatJsonRpcError(error: any) {
  if (!error) {
    return 'Unknown Codex MCP error'
  }

  if (typeof error.message === 'string') {
    return error.message
  }

  return JSON.stringify(error)
}

class CodexMcpWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private nextId = 1
  private startPromise: Promise<void> | null = null
  private stdoutBuffer = ''
  private stderrTail = ''
  private pendingRequests = new Map<string, PendingRequest>()
  private paperThreads = new Map<string, string>()

  async ask(options: AskCodexWorkerOptions): Promise<AskCodexWorkerResult> {
    try {
      await this.ensureStarted()

      const existingThreadId = this.paperThreads.get(options.slug)
      const result = existingThreadId
        ? await this.callTool('codex-reply', {
            threadId: existingThreadId,
            prompt: options.prompt
          })
        : await this.callTool('codex', {
            prompt: options.prompt,
            cwd: options.paperDir,
            sandbox: 'read-only',
            'approval-policy': 'never'
          })

      const output = extractCodexToolOutput(result)
      const answer = output.content?.trim()
      const threadId = output.threadId || existingThreadId

      if (!answer) {
        throw new Error('Codex returned an empty answer')
      }

      if (!threadId) {
        throw new Error('Codex did not return a thread id for this paper')
      }

      this.paperThreads.set(options.slug, threadId)

      return { answer, threadId }
    } catch (error) {
      this.resetAfterFailure()
      throw error
    }
  }

  stop() {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
    this.child = null
    this.initialized = false
    this.startPromise = null
    this.paperThreads.clear()
  }

  private async ensureStarted() {
    if (this.child && this.initialized && !this.child.killed) {
      return
    }

    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }

    await this.startPromise
  }

  private async start() {
    this.stop()

    const codexBin = resolveCodexBin()
    const childEnv = {
      ...process.env,
      PATH: [
        path.dirname(process.execPath),
        path.dirname(codexBin),
        process.env.PATH || ''
      ].filter(Boolean).join(path.delimiter)
    }

    const child = spawn(codexBin, ['mcp-server'], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.initialized = false
    this.stdoutBuffer = ''
    this.stderrTail = ''

    child.stdout.on('data', (chunk) => {
      if (this.child === child) {
        this.handleStdout(chunk)
      }
    })
    child.stderr.on('data', (chunk) => {
      if (this.child === child) {
        this.handleStderr(chunk)
      }
    })
    child.on('error', (error) => {
      if (this.child === child) {
        this.rejectAll(error)
      }
    })
    child.on('close', (code, signal) => {
      if (this.child !== child) {
        return
      }

      const detail = this.stderrTail.trim() || `Codex MCP worker exited with ${signal || code}`
      this.initialized = false
      this.child = null
      this.paperThreads.clear()
      this.rejectAll(new Error(detail))
    })

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'codex-paper-web',
        version: '1.0.0'
      }
    }, MCP_INIT_TIMEOUT_MS)

    this.sendNotification('notifications/initialized', {})
    this.initialized = true
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args
    }, ASK_TIMEOUT_MS)

    if (result?.isError) {
      const message = Array.isArray(result.content)
        ? result.content.map((item: any) => item?.text).filter(Boolean).join('\n')
        : undefined
      throw new Error(message || `Codex MCP tool ${name} failed`)
    }

    return result
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Codex MCP worker is not running'))
    }

    const id = this.nextId++
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id))
        reject(new Error('Codex timed out before returning an answer.'))
      }, timeoutMs)

      this.pendingRequests.set(String(id), { resolve, reject, timeout })
      this.child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return

        clearTimeout(timeout)
        this.pendingRequests.delete(String(id))
        reject(error)
      })
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) {
      return
    }

    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    })}\n`)
  }

  private handleStdout(chunk: Buffer) {
    this.stdoutBuffer += chunk.toString('utf8')

    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)

      if (line) {
        this.handleJsonLine(line)
      }

      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleJsonLine(line: string) {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-MAX_STDERR_TAIL)
      return
    }

    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      return
    }

    const pending = this.pendingRequests.get(String(message.id as JsonRpcId))
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(String(message.id as JsonRpcId))

    if (message.error) {
      pending.reject(new Error(formatJsonRpcError(message.error)))
      return
    }

    pending.resolve(message.result)
  }

  private handleStderr(chunk: Buffer) {
    this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-MAX_STDERR_TAIL)
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingRequests.delete(id)
    }
  }

  private resetAfterFailure() {
    this.stop()
    this.rejectAll(new Error('Codex MCP worker was reset after a failed request.'))
  }
}

const codexWorker = new CodexMcpWorker()

process.once('exit', () => {
  codexWorker.stop()
})

export function askCodexWorker(options: AskCodexWorkerOptions) {
  return codexWorker.ask(options)
}
