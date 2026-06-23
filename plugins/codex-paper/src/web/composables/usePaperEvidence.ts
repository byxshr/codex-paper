export interface PaperReasoning {
  available: boolean
  packageVersion?: string
  contextMode?: string
  paperType?: string
  difficulty?: string
  evidenceQuality?: string
  validationStatus?: string | null
  centralClaims?: any[]
  researchQuestion?: any
  authorReasoningPath?: any[]
  validations?: any[]
  weakestAssumption?: any
  minimalReproduction?: any
  strongestCounterexample?: any
  followUpIdea?: any
  uncertaintyZones?: any[]
  warnings?: any[]
  reason?: string
}

export const usePaperEvidence = (slug: string) => {
  const reasoning = ref<PaperReasoning | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const loadReasoning = async () => {
    loading.value = true
    error.value = null
    try {
      reasoning.value = await $fetch<PaperReasoning>(`/api/papers/${slug}/reasoning`)
    } catch (e: any) {
      error.value = e.data?.statusMessage || e.statusMessage || e.message || 'Failed to load reasoning'
      reasoning.value = { available: false, reason: error.value }
    } finally {
      loading.value = false
    }
  }

  const loadEvidence = async (evidenceId: string) => {
    return await $fetch(`/api/papers/${slug}/evidence/${encodeURIComponent(evidenceId)}`)
  }

  return {
    reasoning,
    loading,
    error,
    loadReasoning,
    loadEvidence
  }
}
