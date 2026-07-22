const activePaperAsks = new Map()

export function acquirePaperAskLease(paperLockKey) {
  if (typeof paperLockKey !== 'string' || !paperLockKey) throw new Error('A paper lock key is required for an Ask lease.')
  activePaperAsks.set(paperLockKey, (activePaperAsks.get(paperLockKey) || 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activePaperAsks.get(paperLockKey) || 1) - 1
    if (remaining > 0) activePaperAsks.set(paperLockKey, remaining)
    else activePaperAsks.delete(paperLockKey)
  }
}

export function hasActivePaperAsk(paperLockKey) {
  return (activePaperAsks.get(paperLockKey) || 0) > 0
}

export function resetPaperAskLeasesForTests() {
  activePaperAsks.clear()
}
