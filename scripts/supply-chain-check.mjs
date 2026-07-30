#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewPath = path.join(repoRoot, 'security/supply-chain-review.json')
const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
const EXIT = Object.freeze({ OK: 0, POLICY: 1, CONFIG: 2 })
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/

function sha256File(relativePath) {
  return createHash('sha256').update(readFileSync(path.join(repoRoot, relativePath))).digest('hex')
}

function readJson(relativePath, errors) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
  } catch (error) {
    errors.push(`${relativePath} is invalid JSON: ${error.message}`)
    return null
  }
}

function checkPackage(relativePath, errors) {
  const manifest = readJson(relativePath, errors)
  const lockPath = path.posix.join(path.posix.dirname(relativePath), 'package-lock.json')
  const lock = readJson(lockPath, errors)
  if (!manifest || !lock) return
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] || {})) {
      if (!EXACT_SEMVER.test(spec)) errors.push(`${relativePath} ${section}.${name} must use an exact semver`)
      if (lock.packages?.['']?.[section]?.[name] !== spec) errors.push(`${lockPath} root ${section}.${name} is not synchronized`)
    }
  }
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name || entry.link) continue
    if (!entry.inBundle && (!entry.integrity || !/^sha512-/.test(entry.integrity))) errors.push(`${lockPath} ${name} is missing sha512 integrity`)
    if (typeof entry.resolved === 'string' && /^(?:git|https?:|file:)/.test(entry.resolved) && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      errors.push(`${lockPath} ${name} uses a non-registry dependency source`)
    }
  }
}

function parseUtcDay(value) {
  if (typeof value !== 'string' || !UTC_DAY.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed
}

function validateExpiringPolicyEntry(entry, label, reviewedAt, maximumDays, errors) {
  const expiry = parseUtcDay(entry?.expiresOn)
  if (!expiry) {
    errors.push(`${label} must have a valid expiresOn date`)
    return
  }
  const latest = new Date(reviewedAt.getTime() + maximumDays * 24 * 60 * 60 * 1000)
  if (expiry > latest) errors.push(`${label} exceeds exceptionMaximumDays`)
}

export function validateDependencyPolicy(dependencyPolicy, errors) {
  const reviewedAt = parseUtcDay(review.reviewedAt)
  const maximumDays = dependencyPolicy?.exceptionMaximumDays
  if (!reviewedAt) errors.push('supply-chain review reviewedAt must be a valid UTC date')
  if (!Number.isInteger(maximumDays) || maximumDays < 1 || maximumDays > 90) errors.push('dependency exceptionMaximumDays must be an integer from 1 to 90')
  const lockfiles = new Set()
  for (const [index, entry] of (dependencyPolicy?.exceptions || []).entries()) {
    const label = `dependency exception ${index}`
    if (typeof entry.lockfile !== 'string' || lockfiles.has(entry.lockfile)) errors.push(`${label} must have a unique lockfile`)
    lockfiles.add(entry.lockfile)
    if (reviewedAt && Number.isInteger(maximumDays)) validateExpiringPolicyEntry(entry, label, reviewedAt, maximumDays, errors)
    if (!Array.isArray(entry.packages) || entry.packages.length === 0) errors.push(`${label} must list exact packages`)
    for (const item of entry.packages || []) {
      if (typeof item.name !== 'string' || typeof item.range !== 'string' || !Array.isArray(item.nodes) || item.nodes.length === 0
        || item.nodes.some((node) => typeof node !== 'string' || !node.startsWith('node_modules/'))) {
        errors.push(`${label} package entries must contain name, range, and non-empty installed nodes`)
      }
    }
    if (typeof entry.reachability !== 'string' || entry.reachability.trim().length < 20
      || !Array.isArray(entry.mitigations) || entry.mitigations.length === 0
      || typeof entry.decision !== 'string' || entry.decision.trim().length < 10) {
      errors.push(`${label} must document reachability, mitigations, and decision`)
    }
  }
  for (const [index, entry] of (dependencyPolicy?.peerDependencyRelaxations || []).entries()) {
    const label = `peer dependency relaxation ${index}`
    if (entry.flag !== '--legacy-peer-deps' || typeof entry.lockfile !== 'string') errors.push(`${label} must bind the exact flag and lockfile`)
    if (reviewedAt && Number.isInteger(maximumDays)) validateExpiringPolicyEntry(entry, label, reviewedAt, maximumDays, errors)
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20
      || typeof entry.reachability !== 'string' || entry.reachability.trim().length < 20
      || !Array.isArray(entry.mitigations) || entry.mitigations.length === 0
      || typeof entry.decision !== 'string' || entry.decision.trim().length < 10) {
      errors.push(`${label} must document reason, reachability, mitigations, and decision`)
    }
  }
}

export function checkWorkflowUses(workflow, errors) {
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
    const reference = match[1].replace(/^['"]|['"]$/g, '')
    if (reference.startsWith('./.github/actions/')) continue
    if (reference.startsWith('docker://')) {
      if (!/@sha256:[a-f0-9]{64}$/.test(reference)) errors.push(`Docker action ${reference} must use an immutable sha256 digest`)
      continue
    }
    const separator = reference.lastIndexOf('@')
    if (separator <= 0 || !/^[a-f0-9]{40}$/.test(reference.slice(separator + 1))) {
      errors.push(`external GitHub Action ${reference} must use a full commit SHA`)
    }
  }
}

export function checkSupplyChain() {
  const errors = []
  checkPackage('plugins/codex-paper/package.json', errors)
  checkPackage('plugins/codex-paper/src/web/package.json', errors)

  const requirements = readFileSync(path.join(repoRoot, 'plugins/codex-paper/runtime/python/requirements.lock'), 'utf8')
  if (!/^PyMuPDF==1\.28\.0\b/m.test(requirements) || !requirements.includes('--hash=sha256:')) errors.push('Python requirements must be exact and hash-locked')
  if (requirements.includes('git+') || requirements.includes('http://') || requirements.includes('https://')) errors.push('Python requirements must not use remote direct references')

  const dockerfile = readFileSync(path.join(repoRoot, 'plugins/codex-paper/sandbox/Dockerfile'), 'utf8')
  for (const name of ['BASE_IMAGE', 'PYTHON_BASE_IMAGE']) {
    if (!new RegExp(`^ARG ${name}=[^\\s]+@sha256:[a-f0-9]{64}$`, 'm').test(dockerfile)) errors.push(`Docker ${name} must be digest-pinned`)
  }
  if (/apt-get|apk add|yum install/.test(dockerfile)) errors.push('sandbox Dockerfile must not install mutable OS packages')

  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  checkWorkflowUses(workflow, errors)

  const dependencyPolicy = readJson('security/dependency-policy.json', errors)
  if (dependencyPolicy) validateDependencyPolicy(dependencyPolicy, errors)

  const secretPolicy = readJson('security/secret-scan-policy.json', errors)
  for (const entry of secretPolicy?.allowlist || []) {
    if (typeof entry.file !== 'string'
      || !Number.isInteger(entry.line)
      || typeof entry.rule !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.contentSha256 || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn || '')
      || typeof entry.reason !== 'string'
      || entry.reason.trim().length < 10) {
      errors.push('secret scan allowlist entries must be exact, hashed, expiring, and justified')
    }
  }

  if (!Array.isArray(review.artifacts) || review.artifacts.length === 0) errors.push('supply-chain review must contain protected artifact hashes')
  for (const artifact of review.artifacts || []) {
    if (!existsSync(path.join(repoRoot, artifact.path))) errors.push(`reviewed supply-chain artifact is missing: ${artifact.path}`)
    else if (sha256File(artifact.path) !== artifact.sha256) errors.push(`supply-chain artifact changed without review: ${artifact.path}`)
  }
  return { status: errors.length ? 'fail' : 'pass', policyVersion: review.policyVersion, errors }
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--json')) process.exit(EXIT.CONFIG)
  const report = checkSupplyChain()
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Supply-chain review: ${report.status}`)
    for (const error of report.errors) console.log(`- ${error}`)
  }
  process.exit(report.status === 'pass' ? EXIT.OK : EXIT.POLICY)
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
