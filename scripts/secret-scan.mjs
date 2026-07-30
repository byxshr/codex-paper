#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let policy
let policyLoadError = null
try {
  policy = JSON.parse(readFileSync(path.join(repoRoot, 'security/secret-scan-policy.json'), 'utf8'))
} catch (error) {
  policyLoadError = `secret scan policy is invalid JSON: ${error.message}`
}
const EXIT = Object.freeze({ OK: 0, POLICY: 1, CONFIG: 2 })
const prefix = (...parts) => parts.join('')
const RULES = Object.freeze([
  { id: 'private-key', pattern: new RegExp(prefix('-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA )?', 'PRIVATE KEY-----')) },
  { id: 'github-token', pattern: new RegExp(`\\b(?:${prefix('g', 'hp', '_')}|${prefix('github', '_pat_')})[A-Za-z0-9_]{20,}\\b`) },
  { id: 'openai-token', pattern: new RegExp(`\\b${prefix('s', 'k-')}(?:proj-)?[A-Za-z0-9_-]{20,}\\b`) },
  { id: 'aws-access-key', pattern: new RegExp(`\\b(?:${prefix('A', 'KIA')}|${prefix('A', 'SIA')})[A-Z0-9]{16}\\b`) },
  { id: 'slack-token', pattern: new RegExp(`\\b${prefix('x', 'ox', '[abprs]-')}[A-Za-z0-9-]{20,}\\b`) },
  { id: 'credential-url', pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/ },
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function trackedFiles(root = repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
}

export function scanContent(content, file = 'fixture.txt') {
  const findings = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of RULES) {
      if (rule.pattern.test(lines[index])) findings.push({ rule: rule.id, file, line: index + 1, contentSha256: sha256(lines[index]) })
    }
  }
  return findings
}

function validUtcDay(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

export function validateSecretPolicy(candidate) {
  const errors = []
  if (!candidate || candidate.schemaVersion !== '1.0.0' || typeof candidate.policyVersion !== 'string') errors.push('secret scan policy identity is invalid')
  if (!Number.isInteger(candidate?.maxFileBytes) || candidate.maxFileBytes < 1024 || candidate.maxFileBytes > 64 * 1024 * 1024) {
    errors.push('secret scan maxFileBytes must be an integer from 1 KiB to 64 MiB')
  }
  if (!Array.isArray(candidate?.allowlist)) errors.push('secret scan allowlist must be an array')
  for (const entry of candidate?.allowlist || []) {
    if (typeof entry.file !== 'string'
      || !Number.isInteger(entry.line)
      || typeof entry.rule !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.contentSha256 || '')
      || !validUtcDay(entry.expiresOn)
      || typeof entry.reason !== 'string'
      || entry.reason.trim().length < 10) {
      errors.push('secret scan allowlist entries must be exact, hashed, expiring, and justified')
    }
  }
  return errors
}

function allowed(finding, selectedPolicy, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  return selectedPolicy.allowlist.some((entry) => entry.file === finding.file
    && entry.line === finding.line
    && entry.rule === finding.rule
    && entry.contentSha256 === finding.contentSha256
    && entry.expiresOn >= day)
}

export function scanRepository({ root = repoRoot, files = trackedFiles(root), now = new Date(), policyOverride = policy } = {}) {
  const findings = []
  const errors = []
  const configurationErrors = policyLoadError ? [{ file: 'security/secret-scan-policy.json', reason: policyLoadError }] : []
  for (const reason of policyLoadError ? [] : validateSecretPolicy(policyOverride)) {
    configurationErrors.push({ file: 'security/secret-scan-policy.json', reason })
  }
  if (configurationErrors.length) {
    return { status: 'configuration_error', findings, errors, configurationErrors, scanned: 0 }
  }
  for (const file of files) {
    const absolute = path.join(root, file)
    let info
    try {
      info = statSync(absolute)
    } catch (error) {
      configurationErrors.push({ file, reason: `tracked file is unavailable: ${error.code || 'read_error'}` })
      continue
    }
    if (!info.isFile()) continue
    if (info.size > policyOverride.maxFileBytes) {
      errors.push({ file, reason: `tracked file exceeds secret scan budget ${policyOverride.maxFileBytes}` })
      continue
    }
    let buffer
    try {
      buffer = readFileSync(absolute)
    } catch (error) {
      configurationErrors.push({ file, reason: `tracked file cannot be read: ${error.code || 'read_error'}` })
      continue
    }
    for (const finding of scanContent(buffer.toString('utf8'), file)) {
      if (!allowed(finding, policyOverride, now)) findings.push(finding)
    }
  }
  return {
    status: findings.length ? 'fail' : configurationErrors.length ? 'configuration_error' : errors.length ? 'fail' : 'pass',
    findings,
    errors,
    configurationErrors,
    scanned: files.length,
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--json')) process.exit(EXIT.CONFIG)
  const report = scanRepository()
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Secret scan: ${report.status}; tracked files=${report.scanned}`)
    for (const finding of report.findings) console.log(`- ${finding.rule}: ${finding.file}:${finding.line}`)
    for (const error of report.errors) console.log(`- ${error.file}: ${error.reason}`)
    for (const error of report.configurationErrors) console.log(`- ${error.file}: ${error.reason}`)
  }
  process.exit(report.status === 'pass' ? EXIT.OK : report.status === 'configuration_error' ? EXIT.CONFIG : EXIT.POLICY)
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
