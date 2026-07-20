import { readOptionalInternalJson } from './librarySecurity.mjs'

const VALID_STATUS = new Set(['pass', 'pass_with_warnings', 'fail'])
const VALID_PHASE = new Set(['draft', 'complete'])
const VALID_OUTCOME = new Set(['allow_authoring', 'allow_publish', 'block'])

function diagnostic(code, message) {
  return { code, message }
}

function validReport(report) {
  return report?.schemaVersion === '1.0.0'
    && VALID_STATUS.has(report.status)
    && VALID_PHASE.has(report.phase)
    && typeof report.publishable === 'boolean'
    && VALID_OUTCOME.has(report.gate?.outcome)
    && Array.isArray(report.findings)
    && report.referenceCoverage
    && /^[a-f0-9]{64}$/.test(report.reportHash?.value || '')
}

function legacyReport(report) {
  const errors = Array.isArray(report?.errors) ? report.errors : []
  const warnings = Array.isArray(report?.warnings) ? report.warnings : []
  return {
    available: true,
    legacy: true,
    schemaVersion: 'legacy',
    status: report?.status === 'fail' || errors.length > 0 ? 'fail' : (warnings.length > 0 ? 'pass_with_warnings' : 'pass'),
    phase: 'draft',
    publishable: false,
    gate: { policy: 'standard', outcome: 'block', blockingFindingCodes: ['VALIDATION_REPORT_LEGACY'] },
    scope: { included: [], excluded: [] },
    findings: [],
    findingCount: 0,
    truncated: false,
    referenceCoverage: null,
    reportHash: null,
    diagnostics: [diagnostic('VALIDATION_REPORT_LEGACY', 'Legacy validation reports are not publication-health evidence; run the current validator.')]
  }
}

export function readStoredValidationReport(slug) {
  let report
  try {
    report = readOptionalInternalJson(slug, '.codex-paper/validation-report.json', 'validation-report.json')
  } catch (error) {
    if (error?.statusCode === 422) {
      return {
        available: false,
        legacy: false,
        diagnostics: [diagnostic('VALIDATION_REPORT_INVALID', 'The validation report is not valid JSON.')]
      }
    }
    throw error
  }
  if (!report) {
    return {
      available: false,
      legacy: false,
      diagnostics: [diagnostic('VALIDATION_REPORT_MISSING', 'No Validation Report 1.0 is available for this paper.')]
    }
  }
  if (!report.schemaVersion && (Array.isArray(report.errors) || Array.isArray(report.warnings))) {
    return legacyReport(report)
  }
  if (!validReport(report)) {
    return {
      available: false,
      legacy: false,
      diagnostics: [diagnostic('VALIDATION_REPORT_INVALID', 'The stored report does not satisfy the Validation Report 1.0 interface.')]
    }
  }
  const findings = report.findings.slice(0, 100)
  return {
    available: true,
    legacy: false,
    schemaVersion: report.schemaVersion,
    status: report.status,
    phase: report.phase,
    publishable: report.publishable,
    gate: report.gate,
    scope: report.scope,
    findings,
    findingCount: report.findings.length,
    truncated: report.findings.length > findings.length,
    referenceCoverage: report.referenceCoverage,
    reportHash: report.reportHash,
    generatedAt: report.generatedAt,
    diagnostics: []
  }
}
