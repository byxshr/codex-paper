import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PDF_SECURITY_POLICY = Object.freeze(JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'pdf-security-policy.json'), 'utf8')))
const ENTRY_NAME = /^\d{8}T\d{6}Z-[a-f0-9]{16}$/

export class PdfSecurityError extends Error {
  constructor(message, code = 'pdf_policy_error') {
    super(message)
    this.name = 'PdfSecurityError'
    this.code = code
  }
}

function libraryRoot(env = process.env) {
  return path.resolve(env.CODEX_PAPER_LIBRARY_ROOT || env.PAPERS_DIR || path.join(os.homedir(), 'codex-papers'))
}

function assertPrivateDirectory(directory, { create = false } = {}) {
  if (!fs.existsSync(directory)) {
    if (!create) return false
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const info = fs.lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PdfSecurityError('PDF quarantine path is unsafe.', 'quarantine_unsafe')
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new PdfSecurityError('PDF quarantine path has the wrong owner.', 'quarantine_unsafe')
  if ((info.mode & 0o077) !== 0) throw new PdfSecurityError('PDF quarantine path must use 0700 permissions.', 'quarantine_unsafe')
  return true
}

export function preflightPdfFile(filePath, { maxBytes = PDF_SECURITY_POLICY.maxInputBytes } = {}) {
  const lexical = fs.lstatSync(filePath)
  if (lexical.isSymbolicLink() || !lexical.isFile()) throw new PdfSecurityError('PDF input must be a regular non-symlink file.', 'pdf_file_type')
  if (lexical.size < 5) throw new PdfSecurityError('PDF input is too short.', 'pdf_magic')
  if (lexical.size > maxBytes) throw new PdfSecurityError(`PDF input exceeds the ${maxBytes}-byte limit.`, 'pdf_too_large')
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const current = fs.fstatSync(fd)
    if (!current.isFile() || current.size !== lexical.size) throw new PdfSecurityError('PDF input changed during validation.', 'pdf_changed')
    const magic = Buffer.alloc(5)
    if (fs.readSync(fd, magic, 0, magic.length, 0) !== magic.length || magic.toString('ascii') !== '%PDF-') {
      throw new PdfSecurityError('PDF input is missing the required %PDF- signature.', 'pdf_magic')
    }
    return { size: current.size, magic: '%PDF-' }
  } finally {
    fs.closeSync(fd)
  }
}

export function copyPdfSnapshot(source, destination) {
  const expected = preflightPdfFile(source)
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let destinationFd
  try {
    const current = fs.fstatSync(sourceFd)
    if (!current.isFile() || current.size !== expected.size) throw new PdfSecurityError('PDF changed before parser snapshot.', 'pdf_changed')
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o400)
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < expected.size) {
      const length = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, expected.size - offset), offset)
      if (length <= 0) throw new PdfSecurityError('PDF ended while creating parser snapshot.', 'pdf_changed')
      fs.writeSync(destinationFd, buffer, 0, length)
      offset += length
    }
    fs.fsyncSync(destinationFd)
  } finally {
    fs.closeSync(sourceFd)
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
  }
  fs.chmodSync(destination, 0o400)
  return preflightPdfFile(destination)
}

export function validateParsedPdf(result) {
  const pageCount = Number(result?.publicData?.pageCount)
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new PdfSecurityError('PDF parser returned no valid pages.', 'pdf_page_count')
  if (pageCount > PDF_SECURITY_POLICY.maxPages) {
    throw new PdfSecurityError(`PDF exceeds the ${PDF_SECURITY_POLICY.maxPages}-page limit.`, 'pdf_page_limit')
  }
  return result
}

function entryStats(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !ENTRY_NAME.test(entry.name)) return []
    const directory = path.join(root, entry.name)
    const info = fs.lstatSync(directory)
    if (info.isSymbolicLink()) return []
    let bytes = 0
    for (const name of ['source.pdf', 'metadata.json']) {
      const candidate = path.join(directory, name)
      if (!fs.existsSync(candidate)) continue
      const item = fs.lstatSync(candidate)
      if (item.isFile() && !item.isSymbolicLink()) bytes += item.size
    }
    return [{ directory, mtimeMs: info.mtimeMs, bytes }]
  }).sort((a, b) => a.mtimeMs - b.mtimeMs)
}

export function sweepPdfQuarantine({ env = process.env, now = Date.now() } = {}) {
  const root = path.join(libraryRoot(env), '.quarantine')
  if (!fs.existsSync(root)) return { entries: 0, bytes: 0 }
  assertPrivateDirectory(root)
  const expiresBefore = now - PDF_SECURITY_POLICY.quarantineRetentionDays * 86400000
  for (const entry of entryStats(root)) {
    if (entry.mtimeMs < expiresBefore) fs.rmSync(entry.directory, { recursive: true, force: true })
  }
  let entries = entryStats(root)
  let bytes = entries.reduce((sum, item) => sum + item.bytes, 0)
  while (entries.length > PDF_SECURITY_POLICY.quarantineMaxEntries || bytes > PDF_SECURITY_POLICY.quarantineMaxBytes) {
    const oldest = entries.shift()
    fs.rmSync(oldest.directory, { recursive: true, force: true })
    bytes -= oldest.bytes
  }
  return { entries: entries.length, bytes }
}

function copyPrivateFile(source, destination, expectedSize) {
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let destinationFd
  try {
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
    const sourceInfo = fs.fstatSync(sourceFd)
    if (!sourceInfo.isFile() || sourceInfo.size !== expectedSize) throw new PdfSecurityError('PDF changed before quarantine capture.', 'pdf_changed')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < expectedSize) {
      const length = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, expectedSize - offset), offset)
      if (length <= 0) throw new PdfSecurityError('PDF ended during quarantine capture.', 'pdf_changed')
      fs.writeSync(destinationFd, buffer, 0, length)
      offset += length
    }
    fs.fsyncSync(destinationFd)
  } finally {
    fs.closeSync(sourceFd)
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
  }
}

function sha256PrivateFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let offset = 0
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, offset)
      if (length === 0) break
      hash.update(buffer.subarray(0, length))
      offset += length
    }
    return hash.digest('hex')
  } finally { fs.closeSync(fd) }
}

export function quarantinePdf(filePath, error, { env = process.env } = {}) {
  const root = path.join(libraryRoot(env), '.quarantine')
  if (!fs.existsSync(path.dirname(root))) fs.mkdirSync(path.dirname(root), { recursive: true })
  const libraryInfo = fs.lstatSync(path.dirname(root))
  if (libraryInfo.isSymbolicLink() || !libraryInfo.isDirectory()) throw new PdfSecurityError('Paper library path is unsafe.', 'quarantine_unsafe')
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 })
  assertPrivateDirectory(root)
  sweepPdfQuarantine({ env })

  const now = new Date()
  const entryName = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(8).toString('hex')}`
  const entryDir = path.join(root, entryName)
  fs.mkdirSync(entryDir, { mode: 0o700 })
  let captured = false
  let size = null
  let sha256 = null
  try {
    const info = fs.lstatSync(filePath)
    size = info.isFile() && !info.isSymbolicLink() ? info.size : null
    if (size !== null && size <= PDF_SECURITY_POLICY.maxInputBytes) {
      copyPrivateFile(filePath, path.join(entryDir, 'source.pdf'), size)
      sha256 = sha256PrivateFile(path.join(entryDir, 'source.pdf'))
      captured = true
    }
    const metadata = {
      quarantineVersion: '1.0.0',
      policyVersion: PDF_SECURITY_POLICY.policyVersion,
      quarantinedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PDF_SECURITY_POLICY.quarantineRetentionDays * 86400000).toISOString(),
      reasonCode: String(error?.code || 'pdf_parse_failed').slice(0, 80),
      reason: String(error?.message || 'PDF parsing failed').replaceAll(filePath, '[source]').replaceAll(path.resolve(filePath), '[source]').replace(/[\r\n]+/g, ' ').slice(0, 512),
      size,
      sha256,
      captured
    }
    fs.writeFileSync(path.join(entryDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    sweepPdfQuarantine({ env })
    return { entryId: entryName, captured }
  } catch (quarantineError) {
    fs.rmSync(entryDir, { recursive: true, force: true })
    throw quarantineError
  }
}
