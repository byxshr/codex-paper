import crypto from 'node:crypto'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

export function validationReportIntrinsic(report) {
  return {
    schemaVersion: report.schemaVersion,
    status: report.status,
    phase: report.phase,
    publishable: report.publishable,
    scope: report.scope,
    validator: report.validator,
    findings: report.findings,
    referenceCoverage: report.referenceCoverage,
  }
}

export function validationReportIntrinsicHash(report) {
  return crypto.createHash('sha256').update(stableJson(validationReportIntrinsic(report))).digest('hex')
}
