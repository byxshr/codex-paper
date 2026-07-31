export interface Paper {
  title: string
  slug: string
  authors: string[]
  abstract: string
  year?: number | null
  githubLinks?: string[]
  codeLinks?: string[]
  url?: string
  date?: string
  tags?: string[]
  sourceFilename?: string
  parserVersion?: string
  qualityFlags?: string[]
}

export interface TrashItem {
  trashId: string
  slug: string
  deletedAt: string
  title?: string
}

export const usePapers = () => {
  const papers = ref<Paper[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const trash = ref<TrashItem[]>([])
  const trashError = ref<string | null>(null)
  const { mutationHeaders } = useSecuritySession()

  const loadPapers = async () => {
    loading.value = true
    error.value = null

    try {
      const data = await $fetch<Paper[]>('/api/papers')
      papers.value = data
    } catch (e: any) {
      error.value = e.message || 'Failed to load papers'
      papers.value = []
    } finally {
      loading.value = false
    }
  }

  const getPaper = (slug: string): Paper | null => {
    return papers.value.find(p => p.slug === slug) || null
  }

  const getPaperMarkdown = async (slug: string): Promise<string | null> => {
    try {
      const data = await $fetch<{ slug: string; markdown: string }>(`/api/papers/${slug}`)
      return data.markdown
    } catch (e) {
      return null
    }
  }

  const removePaper = async (slug: string): Promise<boolean> => {
    try {
      const prepared = await $fetch<{ confirmationToken: string }>(`/api/papers/${slug}/delete/prepare`, {
        method: 'POST',
        headers: mutationHeaders()
      })
      await $fetch(`/api/papers/${slug}/delete`, {
        method: 'DELETE',
        headers: {
          ...mutationHeaders(),
          'X-Codex-Paper-Confirmation': prepared.confirmationToken
        }
      })
      papers.value = papers.value.filter(p => p.slug !== slug)
      await loadTrash()
      return true
    } catch (e) {
      console.error('Failed to remove paper:', e)
      return false
    }
  }

  const updatePaperTags = async (slug: string, tags: string[]): Promise<boolean> => {
    try {
      await $fetch(`/api/papers/${slug}/tags`, {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: { tags }
      })

      const paper = papers.value.find(p => p.slug === slug)
      if (paper) {
        paper.tags = tags
      }

      return true
    } catch (e) {
      console.error('Failed to update tags:', e)
      return false
    }
  }

  const loadTrash = async () => {
    trashError.value = null
    try {
      trash.value = await $fetch<TrashItem[]>('/api/trash')
    } catch (e: any) {
      trashError.value = e.data?.statusMessage || e.message || 'Failed to load trash'
      trash.value = []
    }
  }

  const restorePaper = async (trashId: string): Promise<boolean> => {
    try {
      await $fetch(`/api/trash/${trashId}/restore`, {
        method: 'POST',
        headers: mutationHeaders()
      })
      await Promise.all([loadPapers(), loadTrash()])
      return true
    } catch (e: any) {
      trashError.value = e.data?.statusMessage || e.message || 'Failed to restore paper'
      return false
    }
  }

  return {
    papers,
    loading,
    error,
    trash,
    trashError,
    loadPapers,
    getPaper,
    getPaperMarkdown,
    removePaper,
    updatePaperTags,
    loadTrash,
    restorePaper
  }
}
