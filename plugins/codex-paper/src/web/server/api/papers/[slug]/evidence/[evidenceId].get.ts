import { readJsonPath, readOptionalInternalJson, resolveInternalFile, truncateText, validateEvidenceId, validateSlug } from '../../../../utils/librarySecurity.mjs'

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

  if (evidenceId!.startsWith('ext-')) {
    const external = readOptionalInternalJson(slug!, '.codex-paper/external-evidence.json', 'external-evidence.json')
    const evidence = (external?.evidence || []).find((item: any) => item.id === evidenceId)
    const source = (external?.sources || []).find((item: any) => item.id === evidence?.sourceId)

    if (!evidence) {
      throw createError({ statusCode: 404, statusMessage: 'Evidence not found' })
    }

    return {
      id: evidence.id,
      kind: 'external',
      roles: ['external_context'],
      text: truncateText(evidence.statement || evidence.quote, 700),
      quote: truncateText(evidence.quote || evidence.statement, 500),
      confidence: evidence.confidence,
      location: {
        page: null,
        sectionId: null,
        sectionTitle: truncateText(evidence.naturalLocation, 180),
        labels: {
          sourceTitle: source?.title || evidence.sourceId,
          sourceKind: source?.kind || null
        }
      },
      source: 'external'
    }
  }

  const ledger = readJsonPath(resolveInternalFile(slug!, 'evidence-ledger.json').path, 'evidence-ledger.json')
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
