#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateDependencyPolicy } from './supply-chain-check.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policyPath = path.join(repoRoot, 'security/dependency-policy.json')
let policy
let policyLoadError = null
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'))
} catch (error) {
  policyLoadError = `dependency policy is invalid JSON: ${error.message}`
}
const EXIT = Object.freeze({ OK: 0, POLICY: 1, CONFIG: 2, UNAVAILABLE: 3 })
const targets = Object.freeze([
  { id: 'plugin', directory: 'plugins/codex-paper', lockfile: 'plugins/codex-paper/package-lock.json' },
  { id: 'web', directory: 'plugins/codex-paper/src/web', lockfile: 'plugins/codex-paper/src/web/package-lock.json' },
])

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

function exceptionFor(lockfile, dependencyPolicy = policy) {
  return dependencyPolicy?.exceptions?.find((entry) => entry.lockfile === lockfile) || null
}

function validUtcDay(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function exactFindingSet(vulnerabilities) {
  return Object.entries(vulnerabilities || {})
    .filter(([, value]) => ['critical', 'high'].includes(value.severity))
    .map(([name, value]) => ({
      name,
      severity: value.severity,
      range: value.range,
      nodes: [...(value.nodes || [])].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.range.localeCompare(b.range))
}

export function evaluateAudit({ lockfile, audit, now = new Date(), dependencyPolicy = policy }) {
  if (!audit?.metadata?.vulnerabilities || typeof audit.vulnerabilities !== 'object') {
    return { ok: false, kind: 'config', errors: ['npm audit response is missing vulnerability metadata'] }
  }
  const findings = exactFindingSet(audit.vulnerabilities)
  const errors = []
  if (findings.some((finding) => finding.severity === 'critical')) errors.push('critical vulnerabilities cannot be excepted')
  const high = findings.filter((finding) => finding.severity === 'high')
  const exception = exceptionFor(lockfile, dependencyPolicy)
  if (!exception && high.length) errors.push('high vulnerabilities have no exact exception')
  if (exception) {
    if (!validUtcDay(exception.expiresOn)) errors.push('dependency exception has an invalid or missing expiresOn date')
    else if (exception.expiresOn < utcDay(now)) errors.push(`dependency exception expired on ${exception.expiresOn}`)
    const expected = [...exception.packages]
      .map((item) => ({
        name: item.name,
        severity: 'high',
        range: item.range,
        nodes: [...item.nodes].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.range.localeCompare(b.range))
    const observedByName = new Map(high.map((finding) => [finding.name, finding]))
    const expectedByName = new Map(expected.map((finding) => [finding.name, finding]))
    const added = high.filter((finding) => !expectedByName.has(finding.name))
    const removed = expected.filter((finding) => !observedByName.has(finding.name))
    const changed = high.filter((finding) => {
      const reviewed = expectedByName.get(finding.name)
      return reviewed && JSON.stringify(finding) !== JSON.stringify(reviewed)
    })
    if (added.length) errors.push(`unreviewed high vulnerabilities added: ${added.map((item) => item.name).join(', ')}`)
    if (removed.length) errors.push(`reviewed high vulnerabilities disappeared; prune the exception: ${removed.map((item) => item.name).join(', ')}`)
    if (changed.length) errors.push(`reviewed high vulnerability shape changed: ${changed.map((item) => item.name).join(', ')}`)
  }
  return { ok: errors.length === 0, kind: errors.length ? 'policy' : 'ok', errors, findings }
}

function runAudit(target, env = process.env) {
  const npm = env.NPM_BIN || 'npm'
  const result = spawnSync(npm, ['audit', '--json'], {
    cwd: path.join(repoRoot, target.directory),
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error?.code === 'ENOENT') return { unavailable: `npm is unavailable for ${target.id}` }
  let audit
  try {
    audit = JSON.parse(result.stdout)
  } catch {
    return { unavailable: `npm audit did not return JSON for ${target.id}` }
  }
  if (audit.error && !audit.metadata) return { unavailable: `npm audit registry failure for ${target.id}` }
  return { audit }
}

export function auditDependencies({ env = process.env, now = new Date(), dependencyPolicy = policy } = {}) {
  const policyErrors = []
  if (policyLoadError) policyErrors.push(policyLoadError)
  else validateDependencyPolicy(dependencyPolicy, policyErrors)
  if (policyErrors.length) return { status: 'configuration_error', error: policyErrors.join('; '), reports: [] }
  const reports = []
  for (const target of targets) {
    const result = runAudit(target, env)
    if (result.unavailable) return { status: 'unavailable', error: result.unavailable, reports }
    reports.push({
      target: target.id,
      lockfile: target.lockfile,
      metadata: result.audit.metadata.vulnerabilities,
      ...evaluateAudit({ lockfile: target.lockfile, audit: result.audit, now, dependencyPolicy }),
    })
  }
  return { status: reports.every((report) => report.ok) ? 'pass' : 'fail', reports }
}

function printReport(report, json) {
  if (json) return console.log(JSON.stringify(report, null, 2))
  console.log(`Dependency audit: ${report.status}`)
  for (const item of report.reports || []) {
    console.log(`- ${item.target}: ${item.ok ? 'PASS' : 'FAIL'}; critical=${item.metadata?.critical || 0}; high=${item.metadata?.high || 0}`)
    for (const error of item.errors || []) console.log(`  ${error}`)
  }
  if (report.error) console.error(report.error)
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--json')) process.exit(EXIT.CONFIG)
  const report = auditDependencies()
  printReport(report, args.includes('--json'))
  process.exit(report.status === 'pass'
    ? EXIT.OK
    : report.status === 'unavailable'
      ? EXIT.UNAVAILABLE
      : report.status === 'configuration_error'
        ? EXIT.CONFIG
        : EXIT.POLICY)
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
