import { AsyncLocalStorage } from 'node:async_hooks'
import { acquireStorageLocksSync, withStorageLocks } from '../../../shared/storage-transaction.mjs'

const lockContext = new AsyncLocalStorage()

function mapLockError(error) {
  if (error?.statusCode) {
    error.statusMessage = error.message
    return error
  }
  return error
}

export function tryAcquireLocks(keys, options = {}) {
  try {
    const handle = acquireStorageLocksSync(keys, { libraryRoot: options.libraryRoot || process.env.PAPERS_DIR, timeoutMs: 0 })
    return () => handle.release()
  } catch (error) {
    if (error?.statusCode === 409) return null
    throw mapLockError(error)
  }
}

export async function withOperationLocks(keys, operation, options = {}) {
  try {
    return await withStorageLocks(keys, (handle) => lockContext.run(handle, () => operation(handle)), {
      libraryRoot: options.libraryRoot || process.env.PAPERS_DIR,
      timeoutMs: options.timeoutMs ?? 0,
    })
  } catch (error) {
    throw mapLockError(error)
  }
}

export function withOperationLocksSync(keys, operation, options = {}) {
  const handle = acquireStorageLocksSync(keys, {
    libraryRoot: options.libraryRoot || process.env.PAPERS_DIR,
    timeoutMs: options.timeoutMs ?? 0,
  })
  try { return lockContext.run(handle, () => operation(handle)) } finally { handle.release() }
}

export function currentOperationLockHandle() {
  const handle = lockContext.getStore()
  if (!handle) {
    const error = new Error('A shared storage writer was called outside an operation lock')
    error.code = 'STORAGE_LOCK_REQUIRED'
    error.statusCode = 409
    throw error
  }
  return handle
}

export function resetOperationLocksForTests() {
  // Cross-process locks are filesystem scoped and released by their owners.
}
