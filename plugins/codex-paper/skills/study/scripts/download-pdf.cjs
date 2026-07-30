#!/usr/bin/env node

const crypto = require('node:crypto')
const dns = require('node:dns')
const fs = require('node:fs')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { URL } = require('node:url')

const POLICY = Object.freeze(JSON.parse(fs.readFileSync(path.join(__dirname, 'pdf-security-policy.json'), 'utf8')))
const REDIRECTS = new Set([301, 302, 303, 307, 308])

class DownloadSecurityError extends Error {
  constructor(message, code = 'download_policy_error') {
    super(message)
    this.name = 'DownloadSecurityError'
    this.code = code
  }
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null
  return parts.reduce((value, item) => (value * 256 + item) >>> 0, 0) >>> 0
}

function ipv6Bytes(address) {
  let input = address.toLowerCase()
  if (input.includes('%')) return null
  const ipv4Match = input.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (ipv4Match) {
    const number = ipv4Number(ipv4Match[1])
    if (number === null) return null
    input = `${input.slice(0, ipv4Match.index)}${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((item) => !/^[0-9a-f]{1,4}$/.test(item))) return null
  return Buffer.from(groups.flatMap((item) => {
    const value = parseInt(item, 16)
    return [value >>> 8, value & 0xff]
  }))
}

function mappedIpv4(address) {
  const bytes = ipv6Bytes(address)
  if (!bytes || !bytes.subarray(0, 10).equals(Buffer.alloc(10)) || bytes[10] !== 0xff || bytes[11] !== 0xff) return null
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Number(address)
  const network = ipv4Number(base)
  if (value === null || network === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (network & mask)
}

function ipv6InCidr(address, base, prefix) {
  const value = ipv6Bytes(address)
  const network = ipv6Bytes(base)
  if (!value || !network) return false
  const full = Math.floor(prefix / 8)
  const remaining = prefix % 8
  if (!value.subarray(0, full).equals(network.subarray(0, full))) return false
  if (!remaining) return true
  const mask = 0xff << (8 - remaining)
  return (value[full] & mask) === (network[full] & mask)
}

const FORBIDDEN_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]
const FORBIDDEN_V6 = [
  ['::', 96], ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8]
]

function normalizeAddress(address) {
  const stripped = String(address || '').replace(/^\[|\]$/g, '').toLowerCase()
  return mappedIpv4(stripped) || stripped
}

function isPublicAddress(address) {
  const normalized = normalizeAddress(address)
  const family = net.isIP(normalized)
  if (family === 4) return !FORBIDDEN_V4.some(([base, prefix]) => ipv4InCidr(normalized, base, prefix))
  if (family === 6) return !FORBIDDEN_V6.some(([base, prefix]) => ipv6InCidr(normalized, base, prefix))
  return false
}

function validateHttpsUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new DownloadSecurityError('Paper URL is invalid.', 'url_invalid') }
  if (url.protocol !== 'https:') throw new DownloadSecurityError('Paper downloads require HTTPS.', 'https_required')
  if (url.username || url.password) throw new DownloadSecurityError('Paper URLs must not contain credentials.', 'url_credentials')
  if (!url.hostname) throw new DownloadSecurityError('Paper URL has no hostname.', 'url_invalid')
  url.hash = ''
  return url
}

async function resolveSafeTarget(url, { lookup = dns.promises.lookup } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = net.isIP(hostname)
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!Array.isArray(records) || records.length === 0) throw new DownloadSecurityError('Paper host did not resolve.', 'dns_empty')
  const normalized = records.map((record) => ({ address: normalizeAddress(record.address), family: net.isIP(normalizeAddress(record.address)) }))
  if (normalized.some((record) => !record.family || !isPublicAddress(record.address))) {
    throw new DownloadSecurityError('Paper host resolves to a private, local, metadata, or reserved address.', 'ssrf_address')
  }
  return { url, hostname, records: normalized, selected: normalized[0] }
}

function createStaging() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-download-'))
  fs.chmodSync(directory, 0o700)
  const filePath = path.join(directory, `paper-${crypto.randomBytes(12).toString('hex')}.pdf`)
  return { directory, filePath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function assertPdfMagic(filePath, maxBytes = POLICY.maxInputBytes) {
  const info = fs.lstatSync(filePath)
  if (info.isSymbolicLink() || !info.isFile() || info.size < 5 || info.size > maxBytes) {
    throw new DownloadSecurityError('Downloaded PDF has an invalid file type or size.', 'download_size')
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const magic = Buffer.alloc(5)
    if (fs.readSync(fd, magic, 0, 5, 0) !== 5 || magic.toString('ascii') !== '%PDF-') {
      throw new DownloadSecurityError('Downloaded content is not a PDF (%PDF- signature missing).', 'pdf_magic')
    }
  } finally { fs.closeSync(fd) }
  return info.size
}

function requestOnce(target, { requestFactory = https.request, timeoutMs = POLICY.requestTimeoutMs, maxBytes = POLICY.maxInputBytes } = {}) {
  return new Promise((resolve, reject) => {
    const selected = target.selected
    const options = {
      protocol: 'https:',
      hostname: target.hostname,
      port: target.url.port || 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      headers: { Host: target.url.host, 'User-Agent': 'Codex Paper/2 secure PDF fetcher', Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1' },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: selected.address, family: selected.family }])
        else callback(null, selected.address, selected.family)
      }
    }
    const request = requestFactory(options, (response) => {
      const peer = normalizeAddress(response.socket?.remoteAddress)
      if (!peer || peer !== normalizeAddress(selected.address)) {
        response.resume?.()
        reject(new DownloadSecurityError('Connected peer does not match the DNS-pinned address.', 'peer_mismatch'))
        return
      }
      resolve({ request, response })
    })
    request.setTimeout?.(timeoutMs, () => request.destroy(new DownloadSecurityError(`Paper request exceeded ${timeoutMs}ms.`, 'download_timeout')))
    request.on('error', reject)
    request.end()
  })
}

async function downloadFile(input, options = {}) {
  let current = validateHttpsUrl(input)
  const maxRedirects = options.maxRedirects ?? POLICY.maxRedirects
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const target = await resolveSafeTarget(current, options)
    const { response } = await requestOnce(target, options)
    if (REDIRECTS.has(response.statusCode)) {
      const location = response.headers.location
      response.resume?.()
      if (!location) throw new DownloadSecurityError('Redirect response is missing Location.', 'redirect_invalid')
      if (redirect === maxRedirects) throw new DownloadSecurityError('Paper download exceeded the redirect limit.', 'redirect_limit')
      current = validateHttpsUrl(new URL(location, current).href)
      continue
    }
    if (response.statusCode !== 200) {
      response.resume?.()
      throw new DownloadSecurityError(`Paper server returned HTTP ${response.statusCode}.`, 'download_http')
    }
    const maxBytes = options.maxBytes ?? POLICY.maxInputBytes
    const rawLength = response.headers['content-length']
    if (rawLength !== undefined) {
      if (!/^\d+$/.test(String(rawLength))) {
        response.destroy()
        throw new DownloadSecurityError('Paper response has an invalid Content-Length.', 'content_length')
      }
      if (Number(rawLength) > maxBytes) {
        response.destroy()
        throw new DownloadSecurityError(`Paper response exceeds the ${maxBytes}-byte limit.`, 'download_too_large')
      }
    }
    const staging = createStaging()
    const fd = fs.openSync(staging.filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
    let received = 0
    const writeChunk = options.writeChunk || fs.writeSync
    const streamTimer = setTimeout(() => response.destroy(new DownloadSecurityError(`Paper response exceeded the ${options.timeoutMs ?? POLICY.requestTimeoutMs}ms total deadline.`, 'download_timeout')), options.timeoutMs ?? POLICY.requestTimeoutMs)
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const fail = (error) => {
          if (settled) return
          settled = true
          response.destroy()
          reject(error)
        }
        response.on('data', (chunk) => {
          try {
            received += chunk.length
            if (received > maxBytes) {
              fail(new DownloadSecurityError(`Paper response exceeds the ${maxBytes}-byte limit.`, 'download_too_large'))
              return
            }
            writeChunk(fd, chunk)
          } catch (error) {
            fail(error)
          }
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          resolve()
        })
        response.on('aborted', () => fail(new DownloadSecurityError('Paper response was aborted.', 'download_aborted')))
        response.on('error', fail)
      })
      fs.fsyncSync(fd)
    } catch (error) {
      staging.cleanup()
      throw error
    } finally {
      clearTimeout(streamTimer)
      fs.closeSync(fd)
    }
    try {
      assertPdfMagic(staging.filePath, maxBytes)
      const contentType = String(response.headers['content-type'] || '')
      return {
        path: staging.filePath,
        cleanup: staging.cleanup,
        sourceUrl: current.href,
        sourceFilename: path.basename(current.pathname) || 'paper.pdf',
        bytes: received,
        acquiredAt: new Date().toISOString(),
        warnings: /application\/pdf/i.test(contentType) ? [] : [`Server Content-Type was ${contentType || 'missing'}; PDF signature was valid.`]
      }
    } catch (error) {
      staging.cleanup()
      throw error
    }
  }
  throw new DownloadSecurityError('Paper download exceeded the redirect limit.', 'redirect_limit')
}

function secureCopy(source, destination, expectedSize) {
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let destinationFd
  try {
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
    const current = fs.fstatSync(sourceFd)
    if (!current.isFile() || current.size !== expectedSize) throw new DownloadSecurityError('Local PDF changed during staging.', 'pdf_changed')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < expectedSize) {
      const length = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, expectedSize - offset), offset)
      if (length <= 0) throw new DownloadSecurityError('Local PDF ended during staging.', 'pdf_changed')
      fs.writeSync(destinationFd, buffer, 0, length)
      offset += length
    }
    fs.fsyncSync(destinationFd)
  } finally {
    fs.closeSync(sourceFd)
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
  }
}

async function stagePdfInput(input, options = {}) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    const converted = convertArxivToPdfUrl(input) || input
    return downloadFile(converted, options)
  }
  const source = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()))
  const size = assertPdfMagic(source, options.maxBytes ?? POLICY.maxInputBytes)
  const staging = createStaging()
  try {
    secureCopy(source, staging.filePath, size)
    assertPdfMagic(staging.filePath, options.maxBytes ?? POLICY.maxInputBytes)
    return {
      path: staging.filePath,
      cleanup: staging.cleanup,
      sourceUrl: null,
      sourceFilename: path.basename(source),
      bytes: size,
      acquiredAt: new Date().toISOString(),
      warnings: path.extname(source).toLowerCase() === '.pdf' ? [] : ['Local file has no .pdf extension; PDF signature was valid.']
    }
  } catch (error) {
    staging.cleanup()
    throw error
  }
}

function extractArxivId(input) {
  try {
    const url = new URL(input)
    if (url.hostname.toLowerCase() !== 'arxiv.org') return null
    const match = url.pathname.match(/^\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?(?:\.pdf)?$/i)
    return match ? match[1] : null
  } catch { return null }
}

function convertArxivToPdfUrl(input) {
  const id = extractArxivId(input)
  return id ? `https://arxiv.org/pdf/${id}.pdf` : null
}

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: download-pdf.cjs <https-url-or-local-path>')
    process.exit(2)
  }
  try {
    const staged = await stagePdfInput(input)
    process.stdout.write(`${staged.path}\n`)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}

module.exports = {
  DownloadSecurityError,
  POLICY,
  assertPdfMagic,
  convertArxivToPdfUrl,
  downloadFile,
  isPublicAddress,
  normalizeAddress,
  resolveSafeTarget,
  stagePdfInput,
  validateHttpsUrl
}

if (require.main === module) main()
