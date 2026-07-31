import { classifyInvalidPackageArtifacts, classifyPackageCompatibility } from './packageCompatibility.mjs'
import { readOptionalInternalJson } from './librarySecurity.mjs'

function readCompatibilityArtifact(slug, relativePath, label, invalidArtifacts) {
  try {
    return readOptionalInternalJson(slug, relativePath, label)
  } catch (error) {
    if (error?.statusCode !== 422) throw error
    invalidArtifacts.push(label)
    return null
  }
}

export function classifyStoredPackageCompatibility(slug, { meta = undefined, reasoning = undefined } = {}) {
  const invalidArtifacts = []
  const resolvedMeta = meta === undefined
    ? readCompatibilityArtifact(slug, 'meta.json', 'meta.json', invalidArtifacts)
    : meta
  if (invalidArtifacts.length > 0) return classifyInvalidPackageArtifacts(invalidArtifacts)
  if (resolvedMeta?.packageVersion) return classifyPackageCompatibility({ meta: resolvedMeta })
  const resolvedReasoning = reasoning === undefined
    ? readCompatibilityArtifact(slug, 'reasoning-analysis.json', 'reasoning-analysis.json', invalidArtifacts)
    : reasoning
  const ledger = readCompatibilityArtifact(slug, 'evidence-ledger.json', 'evidence-ledger.json', invalidArtifacts)
  if (invalidArtifacts.length > 0) return classifyInvalidPackageArtifacts(invalidArtifacts)
  return classifyPackageCompatibility({ meta: resolvedMeta, reasoning: resolvedReasoning, ledger })
}
