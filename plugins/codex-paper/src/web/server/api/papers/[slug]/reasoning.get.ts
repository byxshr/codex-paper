import { readJsonPath, readOptionalInternalJson, resolveInternalFile, truncateText, validateSlug } from '../../../utils/librarySecurity.mjs'
import { classifyStoredPackageCompatibility } from '../../../utils/storedPackageCompatibility.mjs'

function trimNode(node: any) {
  if (!node || typeof node !== 'object') return node
  return {
    id: node.id,
    statement: truncateText(node.statement, 360),
    scope: node.scope ? truncateText(node.scope, 240) : undefined,
    type: node.type,
    kind: node.kind,
    sourceType: node.sourceType,
    confidence: node.confidence,
    evidenceRefs: Array.isArray(node.evidenceRefs) ? node.evidenceRefs.slice(0, 8) : [],
    dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
    supportsClaimIds: Array.isArray(node.supportsClaimIds) ? node.supportsClaimIds : []
  }
}

function trimValidation(validation: any) {
  return {
    id: validation.id,
    kind: validation.kind,
    question: truncateText(validation.question, 260),
    design: truncateText(validation.design, 320),
    observation: truncateText(validation.observation, 320),
    conclusion: truncateText(validation.conclusion, 320),
    scope: truncateText(validation.scope, 240),
    sourceType: validation.sourceType,
    confidence: validation.confidence,
    evidenceRefs: Array.isArray(validation.evidenceRefs) ? validation.evidenceRefs.slice(0, 8) : [],
    supportsClaimIds: Array.isArray(validation.supportsClaimIds) ? validation.supportsClaimIds : []
  }
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  }

  const meta = readOptionalInternalJson(slug!, 'meta.json', 'meta.json') || {}
  let reasoningFile
  let ledgerFile
  try {
    reasoningFile = resolveInternalFile(slug!, 'reasoning-analysis.json')
    ledgerFile = resolveInternalFile(slug!, 'evidence-ledger.json')
  } catch (error: any) {
    if (error?.statusCode !== 404) throw error
    return {
      available: false,
      reason: 'v2 reasoning is not available for this package',
      packageVersion: meta.packageVersion || 'legacy',
      compatibility: classifyStoredPackageCompatibility(slug!, { meta, reasoning: null })
    }
  }

  const reasoning = readJsonPath(reasoningFile.path, 'reasoning-analysis.json')
  const validationReport = readOptionalInternalJson(slug!, '.codex-paper/validation-report.json', 'validation-report.json')

  return {
    available: true,
    packageVersion: meta.packageVersion || reasoning.schemaVersion || '2.0.0',
    compatibility: classifyStoredPackageCompatibility(slug!, { meta, reasoning }),
    contextMode: reasoning.contextMode,
    paperType: reasoning.paperType,
    difficulty: reasoning.difficulty,
    evidenceQuality: reasoning.evidenceQuality,
    validationStatus: validationReport?.status || meta.validationStatus || null,
    centralClaims: (reasoning.centralClaims || []).map(trimNode),
    researchQuestion: {
      question: trimNode(reasoning.researchQuestion?.question),
      importance: trimNode(reasoning.researchQuestion?.importance)
    },
    authorReasoningPath: (reasoning.authorReasoningPath || []).map(trimNode),
    validations: (reasoning.validations || []).map(trimValidation),
    weakestAssumption: reasoning.weakestAssumption || null,
    minimalReproduction: reasoning.minimalReproduction || null,
    strongestCounterexample: reasoning.strongestCounterexample || null,
    followUpIdea: reasoning.followUpIdea || null,
    uncertaintyZones: reasoning.uncertaintyZones || [],
    warnings: validationReport?.warnings?.slice(0, 20) || []
  }
})
