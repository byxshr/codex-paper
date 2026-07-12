const LOCKS_KEY = Symbol.for('codex-paper.operation-locks')

function locks() {
  if (!globalThis[LOCKS_KEY]) globalThis[LOCKS_KEY] = new Set()
  return globalThis[LOCKS_KEY]
}

export function tryAcquireLocks(keys) {
  const normalized = [...new Set(keys)].sort()
  const active = locks()
  if (normalized.some((key) => active.has(key))) return null
  for (const key of normalized) active.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const key of normalized) active.delete(key)
  }
}

export async function withOperationLocks(keys, operation) {
  const release = tryAcquireLocks(keys)
  if (!release) {
    const error = new Error('A conflicting library operation is already running')
    error.statusCode = 409
    error.statusMessage = error.message
    throw error
  }
  try {
    return await operation()
  } finally {
    release()
  }
}

export function resetOperationLocksForTests() {
  globalThis[LOCKS_KEY] = new Set()
}
