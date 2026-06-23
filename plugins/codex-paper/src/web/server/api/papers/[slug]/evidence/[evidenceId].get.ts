import path from 'path'
import { readJsonFile, requirePaperDir, truncateText, validateEvidenceId, validateSlug } from '../../../../utils/paperAccess'

function sectionTitle(ledger: any, sectionId: string | null | undefined) {
  if (!sectionId) return null
  return (ledger.sections || []).find((section: any) => section.id === sectionId)?.title || null
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  const evidenceId = getRouterParam(event, 'evidenceId')
  if (!validateSlug(slug) || !validateEvidenceId(evidenceId)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid slug and evidence id are required' })
  }

  const paperDir = requirePaperDir(slug!)
  const ledger = readJsonFile(path.join(paperDir, 'evidence-ledger.json'), 'evidence-ledger.json')
  const evidence = (ledger.evidence || []).find((item: any) => item.id === evidenceId)

  if (!evidence) {
    throw createError({ statusCode: 404, statusMessage: 'Evidence not found' })
  }

  return {
    id: evidence.id,
    kind: evidence.kind,
    roles: evidence.roles || [],
    text: truncateText(evidence.text || evidence.quote, 700),
    quote: truncateText(evidence.quote || evidence.text, 500),
    confidence: evidence.confidence,
    location: {
      page: evidence.location?.page || null,
      sectionId: evidence.location?.sectionId || null,
      sectionTitle: sectionTitle(ledger, evidence.location?.sectionId),
      labels: evidence.labels || {}
    },
    source: evidence.source || 'paper'
  }
})
