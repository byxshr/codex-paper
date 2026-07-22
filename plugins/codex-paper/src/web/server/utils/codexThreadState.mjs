export async function callCodexPaperTool({ paperThreads, slug, paperDir, prompt, callTool }) {
  const existingThread = paperThreads.get(slug)
  const existingThreadId = existingThread?.paperDir === paperDir ? existingThread.threadId : undefined
  if (!existingThreadId) {
    return {
      existingThreadId: undefined,
      result: await callTool('codex', {
        prompt,
        cwd: paperDir,
        sandbox: 'read-only',
        'approval-policy': 'never'
      })
    }
  }

  try {
    return {
      existingThreadId,
      result: await callTool('codex-reply', { threadId: existingThreadId, prompt })
    }
  } catch (error) {
    if (paperThreads.get(slug) === existingThread) paperThreads.delete(slug)
    throw error
  }
}

export function invalidateCodexPaperThread({ paperThreads, slug, paperDir, threadId }) {
  const current = paperThreads.get(slug)
  if (current?.paperDir === paperDir && current?.threadId === threadId) paperThreads.delete(slug)
}

export function finalizeCodexPaperToolResult({ paperThreads, slug, paperDir, existingThreadId, result, extractOutput }) {
  try {
    const output = extractOutput(result)
    const answer = output.content?.trim()
    const threadId = output.threadId || existingThreadId
    if (!answer) throw new Error('Codex returned an empty answer')
    if (!threadId) throw new Error('Codex did not return a thread id for this paper')
    return { answer, threadId }
  } catch (error) {
    if (existingThreadId) invalidateCodexPaperThread({ paperThreads, slug, paperDir, threadId: existingThreadId })
    throw error
  }
}
