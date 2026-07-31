import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cliExitCode } from './cli-error-format.mjs'

export const STORAGE_TRANSACTION_VERSION = '1.0.0'
export const DEFAULT_CLI_LOCK_TIMEOUT_MS = 10_000
export const MAX_LOCK_TIMEOUT_MS = 30_000
export const LOCK_HEARTBEAT_MS = 5_000

const LOCK_KIND_RANK = Object.freeze({
  registry: 10,
  paper: 20,
  legacy: 20,
  source: 30,
  generation: 40,
  workspace: 50,
  trash: 50,
  backup: 50,
  restore: 50,
  migration: 50,
  index: 60,
})

export class StorageTransactionError extends Error {
  constructor(code, message, statusCode = 422, details = {}) {
    super(message)
    this.name = 'StorageTransactionError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function assertSafeDirectory(directory, containmentRoot = null) {
  let stats
  try { stats = fs.lstatSync(directory) } catch {
    throw new StorageTransactionError('STORAGE_DIRECTORY_MISSING', 'Storage directory does not exist.', 404)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new StorageTransactionError('STORAGE_PATH_UNSAFE', 'Storage directory must be a non-symlink directory.', 403)
  }
  const canonical = fs.realpathSync(directory)
  if (containmentRoot) {
    const root = fs.realpathSync(containmentRoot)
    if (!isContained(root, canonical)) throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage path escapes its authority boundary.', 403)
  }
  return canonical
}

function ensurePrivateDirectory(directory, parent = null) {
  if (parent) assertSafeDirectory(parent)
  try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return assertSafeDirectory(directory, parent)
}

function lockKind(key) {
  const kind = String(key).split(':', 1)[0]
  if (!(kind in LOCK_KIND_RANK)) throw new StorageTransactionError('STORAGE_LOCK_KEY_INVALID', 'Storage lock key is invalid.', 400)
  return kind
}

export function normalizeLockKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new StorageTransactionError('STORAGE_LOCK_KEY_INVALID', 'At least one storage lock key is required.', 400)
  return [...new Set(keys.map((key) => {
    if (typeof key !== 'string' || !key || key.length > 1024 || key.includes('\0')) {
      throw new StorageTransactionError('STORAGE_LOCK_KEY_INVALID', 'Storage lock key is invalid.', 400)
    }
    lockKind(key)
    return key
  }))].sort((left, right) => LOCK_KIND_RANK[lockKind(left)] - LOCK_KIND_RANK[lockKind(right)] || left.localeCompare(right))
}

function lockDirectoryName(key) {
  const kind = lockKind(key)
  const digest = crypto.createHash('sha256').update(key).digest('hex')
  return `${String(LOCK_KIND_RANK[kind]).padStart(2, '0')}-${kind}-${digest}.lock`
}

export function storageLockPath(key, options = {}) {
  const { lockRoot } = prepareLockRoot(options)
  normalizeLockKeys([key])
  return path.join(lockRoot, lockDirectoryName(key))
}

function writeOwnerRecord(lockDir, owner) {
  const target = path.join(lockDir, 'owner.json')
  const temporary = path.join(lockDir, `.owner.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    const directoryDescriptor = fs.openSync(lockDir, fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function readOwnerRecord(lockDir) {
  const stats = fs.lstatSync(lockDir)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new StorageTransactionError('STORAGE_LOCK_UNSAFE', 'Storage lock path is unsafe.', 403)
  const ownerPath = path.join(lockDir, 'owner.json')
  let descriptor
  try {
    const ownerStats = fs.lstatSync(ownerPath)
    if (ownerStats.isSymbolicLink() || !ownerStats.isFile()) throw new Error('invalid owner record')
    descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const owner = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    if (owner?.schemaVersion !== STORAGE_TRANSACTION_VERSION || typeof owner?.token !== 'string'
      || !Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner?.hostname !== 'string'
      || Number.isNaN(Date.parse(owner?.acquiredAt)) || Number.isNaN(Date.parse(owner?.heartbeatAt))) {
      throw new Error('invalid owner record')
    }
    return owner
  } catch (error) {
    if (error instanceof StorageTransactionError) throw error
    if (error?.code === 'ENOENT') {
      const lockStats = fs.lstatSync(lockDir)
      if (Date.now() - lockStats.mtimeMs <= 1_000) {
        throw new StorageTransactionError('STORAGE_LOCK_INITIALIZING', 'Storage lock initialization is still in progress.', 409)
      }
    }
    throw new StorageTransactionError('STORAGE_LOCK_CORRUPT', 'Storage lock owner record is invalid.', 422)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function newOwnerRecord(key) {
  const now = new Date().toISOString()
  return {
    schemaVersion: STORAGE_TRANSACTION_VERSION,
    key,
    token: crypto.randomBytes(32).toString('hex'),
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: now,
    heartbeatAt: now,
  }
}

function acquireReclaimGuard(lockRoot, lockDir) {
  const guardDir = `${lockDir}.reclaim`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = newOwnerRecord(`reclaim:${path.basename(lockDir)}`)
    const initializing = path.join(lockRoot, `.reclaim-init-${path.basename(lockDir)}-${crypto.randomBytes(8).toString('hex')}`)
    try {
      fs.mkdirSync(initializing, { mode: 0o700 })
      writeOwnerRecord(initializing, owner)
      try {
        fs.renameSync(initializing, guardDir)
        return { key: owner.key, lockDir: guardDir, owner }
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
      }
    } finally {
      try { fs.rmSync(initializing, { recursive: true, force: true }) } catch {}
    }

    let existing
    try { existing = readOwnerRecord(guardDir) } catch {
      return null
    }
    if (existing.hostname !== os.hostname() || processExists(existing.pid)) return null
    const staleGuard = path.join(lockRoot, `.stale-reclaim-${path.basename(lockDir)}-${crypto.randomBytes(8).toString('hex')}`)
    try { fs.renameSync(guardDir, staleGuard) } catch { return null }
    try {
      const moved = readOwnerRecord(staleGuard)
      if (moved.token !== existing.token || moved.pid !== existing.pid || moved.hostname !== existing.hostname) {
        try { if (!fs.existsSync(guardDir)) fs.renameSync(staleGuard, guardDir) } catch {}
        return null
      }
      fs.rmSync(staleGuard, { recursive: true, force: true })
    } catch {
      try { if (!fs.existsSync(guardDir)) fs.renameSync(staleGuard, guardDir) } catch {}
      return null
    }
  }
  return null
}

function reclaimDeadOwner(lockRoot, lockDir, owner) {
  if (owner.hostname !== os.hostname() || processExists(owner.pid)) return false
  const reclaimGuard = acquireReclaimGuard(lockRoot, lockDir)
  if (!reclaimGuard) return false
  const stale = path.join(lockRoot, `.stale-${path.basename(lockDir)}-${crypto.randomBytes(8).toString('hex')}`)
  try {
    let current
    try { current = readOwnerRecord(lockDir) } catch { return false }
    if (current.token !== owner.token || current.pid !== owner.pid || current.hostname !== owner.hostname || processExists(current.pid)) return false
    try { fs.renameSync(lockDir, stale) } catch { return false }
    let moved
    try { moved = readOwnerRecord(stale) } catch {
      try { if (!fs.existsSync(lockDir)) fs.renameSync(stale, lockDir) } catch {}
      return false
    }
    if (moved.token !== owner.token || moved.pid !== owner.pid || moved.hostname !== owner.hostname) {
      try {
        if (!fs.existsSync(lockDir)) fs.renameSync(stale, lockDir)
      } catch {}
      return false
    }
    fs.rmSync(stale, { recursive: true, force: true })
    return true
  } finally {
    try { releaseOne(reclaimGuard) } catch {}
  }
}

function tryAcquireOne(lockRoot, key) {
  const lockDir = path.join(lockRoot, lockDirectoryName(key))
  const owner = newOwnerRecord(key)
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 })
    try { writeOwnerRecord(lockDir, owner) } catch (error) {
      try { fs.rmdirSync(lockDir) } catch {}
      throw error
    }
    return { key, lockDir, owner }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let existing
    try { existing = readOwnerRecord(lockDir) } catch (ownerError) {
      if (ownerError?.code === 'STORAGE_LOCK_INITIALIZING') return null
      throw ownerError
    }
    try {
      if (reclaimDeadOwner(lockRoot, lockDir, existing)) return tryAcquireOne(lockRoot, key)
    } catch (reclaimError) {
      if (reclaimError?.code !== 'STORAGE_LOCK_INITIALIZING') throw reclaimError
    }
    return null
  }
}

function releaseOne(item) {
  let owner
  try { owner = readOwnerRecord(item.lockDir) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (owner.token !== item.owner.token) throw new StorageTransactionError('STORAGE_LOCK_OWNERSHIP_LOST', 'Storage lock ownership changed before release.', 409)
  fs.unlinkSync(path.join(item.lockDir, 'owner.json'))
  fs.rmdirSync(item.lockDir)
}

function releaseAcquired(acquired) {
  const errors = []
  for (const item of [...acquired].reverse()) {
    try { releaseOne(item) } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'One or more storage locks could not be released.')
}

function rollbackAfterError(acquired, error) {
  try { releaseAcquired(acquired) } catch (cleanupError) {
    error.cleanupError = cleanupError
  }
  throw error
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function createLockHandle(normalized, acquired, libraryRoot) {
  let released = false
  const handle = {
    keys: normalized,
    libraryRoot,
    owns(key) { return !released && normalized.includes(key) },
    assertOwns(key) {
      if (!this.owns(key)) throw new StorageTransactionError('STORAGE_LOCK_REQUIRED', 'The required storage lock is not held.', 409)
    },
    release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      releaseAcquired(acquired)
    },
  }
  const heartbeat = setInterval(() => {
    for (const item of acquired) {
      try {
        const current = readOwnerRecord(item.lockDir)
        if (current.token !== item.owner.token) continue
        item.owner.heartbeatAt = new Date().toISOString()
        writeOwnerRecord(item.lockDir, item.owner)
      } catch {}
    }
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref?.()
  return handle
}

function prepareLockRoot(options = {}) {
  const libraryRoot = path.resolve(options.libraryRoot || process.env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'))
  fs.mkdirSync(libraryRoot, { recursive: true, mode: 0o700 })
  assertSafeDirectory(libraryRoot)
  const codexRoot = path.join(libraryRoot, '.codex-paper')
  ensurePrivateDirectory(codexRoot, libraryRoot)
  const lockRoot = path.join(codexRoot, 'locks-v1')
  ensurePrivateDirectory(lockRoot, codexRoot)
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_CLI_LOCK_TIMEOUT_MS)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new StorageTransactionError('STORAGE_LOCK_TIMEOUT_INVALID', 'Lock timeout must be an integer between 0 and 30000 milliseconds.', 400)
  }
  return { libraryRoot, lockRoot, timeoutMs }
}

export async function acquireStorageLocks(keys, options = {}) {
  const { libraryRoot, lockRoot, timeoutMs } = prepareLockRoot(options)
  const normalized = normalizeLockKeys(keys)
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  for (;;) {
    const acquired = []
    let conflictKey = null
    try {
      for (const key of normalized) {
        const item = tryAcquireOne(lockRoot, key)
        if (!item) { conflictKey = key; break }
        acquired.push(item)
      }
      if (!conflictKey) {
        return createLockHandle(normalized, acquired, libraryRoot)
      }
    } catch (error) { rollbackAfterError(acquired, error) }
    releaseAcquired(acquired)
    if (Date.now() >= deadline) {
      throw new StorageTransactionError(timeoutMs === 0 ? 'STORAGE_LOCK_CONFLICT' : 'STORAGE_LOCK_TIMEOUT', 'A conflicting storage operation is already running.', 409, { key: conflictKey, retryable: true })
    }
    attempt += 1
    await sleep(Math.min(250, 25 * (2 ** Math.min(attempt, 3))) + crypto.randomInt(0, 20))
  }
}

export function acquireStorageLocksSync(keys, options = {}) {
  const { libraryRoot, lockRoot, timeoutMs } = prepareLockRoot(options)
  const normalized = normalizeLockKeys(keys)
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  for (;;) {
    const acquired = []
    let conflictKey = null
    try {
      for (const key of normalized) {
        const item = tryAcquireOne(lockRoot, key)
        if (!item) { conflictKey = key; break }
        acquired.push(item)
      }
      if (!conflictKey) return createLockHandle(normalized, acquired, libraryRoot)
    } catch (error) { rollbackAfterError(acquired, error) }
    releaseAcquired(acquired)
    if (Date.now() >= deadline) {
      throw new StorageTransactionError(timeoutMs === 0 ? 'STORAGE_LOCK_CONFLICT' : 'STORAGE_LOCK_TIMEOUT', 'A conflicting storage operation is already running.', 409, { key: conflictKey, retryable: true })
    }
    attempt += 1
    const delay = Math.min(250, 25 * (2 ** Math.min(attempt, 3))) + crypto.randomInt(0, 20)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  }
}

export function withStorageLocksSync(keys, operation, options = {}) {
  const handle = acquireStorageLocksSync(keys, options)
  try { return operation(handle) } finally { handle.release() }
}

export async function withStorageLocks(keys, operation, options = {}) {
  const handle = await acquireStorageLocks(keys, options)
  try { return await operation(handle) } finally { handle.release() }
}

function assertLock(handle, requiredLock) {
  if (!handle || typeof handle.assertOwns !== 'function') throw new StorageTransactionError('STORAGE_LOCK_REQUIRED', 'A storage lock handle is required.', 409)
  handle.assertOwns(requiredLock)
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function readFileNoFollowBounded(filePath, maxBytes = 128 * 1024 * 1024) {
  let descriptor
  try {
    const stats = fs.lstatSync(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) throw new StorageTransactionError('STORAGE_PATH_UNSAFE', 'Source must be a regular non-symlink file.', 403)
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) throw new StorageTransactionError('STORAGE_PATH_UNSAFE', 'Source must be a regular file.', 403)
    if (opened.size > maxBytes) throw new StorageTransactionError('STORAGE_FILE_TOO_LARGE', 'Storage file exceeds the allowed size.', 413)
    return fs.readFileSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function fileWritePrecondition(filePath, maxBytes = 128 * 1024 * 1024) {
  try {
    return { expectedSha256: sha256Buffer(readFileNoFollowBounded(filePath, maxBytes)) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { expectAbsent: true }
    throw error
  }
}

export function storageCliExitCode(error) {
  return cliExitCode(error)
}

export function atomicWriteFile({ root, relativePath, data, lockHandle, requiredLock, expectedSha256, expectAbsent = false, mode = 0o600, maxBytes = 128 * 1024 * 1024 }) {
  assertLock(lockHandle, requiredLock)
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new StorageTransactionError('STORAGE_PATH_INVALID', 'A safe relative storage path is required.', 400)
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage path escapes its authority boundary.', 403)
  const hasExpectedSha256 = expectedSha256 !== undefined
  if (Boolean(expectAbsent) === hasExpectedSha256) {
    throw new StorageTransactionError(
      hasExpectedSha256 ? 'WRITE_PRECONDITION_INVALID' : 'WRITE_PRECONDITION_REQUIRED',
      'Exactly one absent-or-SHA storage precondition is required.',
      hasExpectedSha256 ? 400 : 409
    )
  }
  const canonicalRoot = assertSafeDirectory(root)
  let parent = canonicalRoot
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(parent, segment)
    if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
    parent = assertSafeDirectory(next, canonicalRoot)
  }
  const target = path.join(parent, segments.at(-1))
  if (!isContained(canonicalRoot, target)) throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage path escapes its authority boundary.', 403)
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  if (bytes.length > maxBytes) throw new StorageTransactionError('STORAGE_FILE_TOO_LARGE', 'Storage file exceeds the allowed size.', 413)
  let existing = null
  try {
    const stats = fs.lstatSync(target)
    if (stats.isSymbolicLink() || !stats.isFile()) throw new StorageTransactionError('STORAGE_PATH_UNSAFE', 'Storage target must be a regular non-symlink file.', 403)
    existing = readFileNoFollowBounded(target, maxBytes)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (expectAbsent && existing !== null) throw new StorageTransactionError('WRITE_PRECONDITION_FAILED', 'Storage target already exists.', 409)
  if (hasExpectedSha256) {
    if (!/^[a-f0-9]{64}$/.test(String(expectedSha256)) || existing === null || sha256Buffer(existing) !== expectedSha256) {
      throw new StorageTransactionError('WRITE_PRECONDITION_FAILED', 'Storage target changed since it was read.', 409)
    }
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
  return { path: target, sha256: sha256Buffer(bytes), bytes: bytes.length }
}

export function atomicWriteJson(options) {
  return atomicWriteFile({ ...options, data: `${JSON.stringify(options.value, null, 2)}\n` })
}

export function ensureStorageDirectory({ parent, directory, lockHandle, requiredLock, mode = 0o700 }) {
  assertLock(lockHandle, requiredLock)
  const canonicalParent = assertSafeDirectory(parent)
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== canonicalParent) {
    throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage directory must be a direct child of its authority boundary.', 403)
  }
  try { fs.mkdirSync(resolved, { mode }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const canonical = assertSafeDirectory(resolved, canonicalParent)
  const descriptor = fs.openSync(canonicalParent, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  return canonical
}

export function atomicRemoveFile({ root, relativePath, lockHandle, requiredLock, expectedSha256 }) {
  assertLock(lockHandle, requiredLock)
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 || ''))) {
    throw new StorageTransactionError('WRITE_PRECONDITION_REQUIRED', 'A valid SHA-256 removal precondition is required.', 409)
  }
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new StorageTransactionError('STORAGE_PATH_INVALID', 'A safe relative storage path is required.', 400)
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage path escapes its authority boundary.', 403)
  const authority = assertSafeDirectory(root)
  let parent = authority
  for (const segment of segments.slice(0, -1)) parent = assertSafeDirectory(path.join(parent, segment), authority)
  const target = path.join(parent, segments.at(-1))
  if (!isContained(authority, target)) throw new StorageTransactionError('STORAGE_PATH_ESCAPE', 'Storage path escapes its authority boundary.', 403)
  const bytes = readFileNoFollowBounded(target, 128 * 1024 * 1024)
  const currentSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  if (currentSha256 !== expectedSha256) {
    throw new StorageTransactionError('WRITE_PRECONDITION_FAILED', 'The storage precondition no longer matches the current file.', 409)
  }
  fs.unlinkSync(target)
  const descriptor = fs.openSync(parent, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  return { removed: true, sha256: currentSha256 }
}
