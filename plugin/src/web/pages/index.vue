<template>
  <div class="library-container">
    <nav class="top-bar">
      <div class="logo">
        <span class="logo-icon">◈</span>
        <span class="logo-text">Research Library</span>
      </div>
    </nav>

    <div class="library-content">
      <div class="library-header">
        <h1>Your Research Collection</h1>
        <p class="subtitle">All papers stored in: <code>~/codex-papers/papers/</code></p>
      </div>

      <SearchFilterBar
        v-if="!loading && !error && papers.length > 0"
        :available-tags="availableTags"
        :view-mode="viewMode"
        @search="handleSearch"
        @filter="handleFilter"
        @sort="handleSort"
        @view="handleViewChange"
      />

      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <p>Loading papers...</p>
      </div>
      <div v-else-if="error" class="error-state">{{ error }}</div>
      <div v-else-if="papers.length === 0" class="empty-state">
        <p>No papers yet. Use the Codex Paper study skill to add papers.</p>
      </div>
      <div v-else-if="displayedPapers.length === 0" class="empty-state">
        <p>No papers match your filters.</p>
      </div>
      <section v-else class="collection-directory" aria-label="Collection directory">
        <div class="collection-directory__header">
          <div>
            <h2>Collection Directory</h2>
            <p>{{ displayedPapers.length }} {{ displayedPapers.length === 1 ? 'paper' : 'papers' }} in the current view</p>
          </div>
          <button
            class="collection-directory__toggle"
            type="button"
            @click="directoryCollapsed = !directoryCollapsed"
          >
            {{ directoryCollapsed ? 'Show' : 'Hide' }}
          </button>
        </div>

        <div v-if="!directoryCollapsed" class="collection-directory__groups">
          <div
            v-for="group in directoryGroups"
            :key="group.label"
            class="collection-directory__group"
          >
            <h3>{{ group.label }}</h3>
            <ol>
              <li v-for="paper in group.papers" :key="paper.slug">
                <a :href="`#${paperAnchorId(paper.slug)}`">{{ paper.title }}</a>
                <span v-if="paper.tags?.length" class="collection-directory__meta">
                  {{ paper.tags.slice(0, 2).join(' · ') }}
                </span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <div v-if="displayedPapers.length > 0" :class="viewMode === 'grid' ? 'papers-grid' : 'papers-list'">
        <PaperCard
          v-for="paper in displayedPapers"
          :key="paper.slug"
          :id="paperAnchorId(paper.slug)"
          :paper="paper"
          :view-mode="viewMode"
          :expanded="expandedPaperSlugs.includes(paper.slug)"
          @edit-tags="openTagEditor(paper)"
          @remove="handleRemovePaper"
          @toggle-expand="togglePaperExpansion(paper.slug)"
        />
      </div>
    </div>

    <div v-if="editingPaper" class="modal-overlay" @click.self="closeTagEditor">
      <TagEditor
        :initial-tags="editingPaper.tags || []"
        @update="handleTagsUpdate"
        @cancel="closeTagEditor"
      />
      <p v-if="tagSaveError" class="tag-save-error">{{ tagSaveError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Paper } from '~/composables/usePapers'

const { papers, loading, error, loadPapers, updatePaperTags, removePaper } = usePapers()

const searchQuery = ref('')
const selectedTags = ref<string[]>([])
const sortBy = ref('default')
const viewMode = ref<'grid' | 'list'>('grid')
const editingPaper = ref<Paper | null>(null)
const tagSaveError = ref<string | null>(null)
const directoryCollapsed = ref(false)
const expandedPaperSlugs = ref<string[]>([])

onMounted(async () => {
  await loadPapers()
})

const availableTags = computed(() => {
  const tags = new Set<string>()
  papers.value.forEach(paper => {
    if (paper.tags) {
      paper.tags.forEach(tag => tags.add(tag))
    }
  })
  return Array.from(tags).sort()
})

const filteredPapers = computed(() => {
  let result = papers.value

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(paper => {
      return (
        paper.title.toLowerCase().includes(query) ||
        paper.authors.some(author => author.toLowerCase().includes(query)) ||
        paper.abstract.toLowerCase().includes(query)
      )
    })
  }

  if (selectedTags.value.length > 0) {
    result = result.filter(paper => {
      if (!paper.tags || paper.tags.length === 0) return false
      return selectedTags.value.every(tag => paper.tags?.includes(tag))
    })
  }

  return result
})

const displayedPapers = computed(() => {
  let result = [...filteredPapers.value]

  if (sortBy.value === 'a-z') {
    result.sort((a, b) => a.title.localeCompare(b.title))
  } else if (sortBy.value === 'z-a') {
    result.sort((a, b) => b.title.localeCompare(a.title))
  }

  return result
})

const paperAnchorId = (slug: string) => `paper-${slug}`

const directoryGroups = computed(() => {
  const groups = new Map<string, Paper[]>()

  displayedPapers.value.forEach((paper) => {
    const label = paper.year
      ? String(paper.year)
      : paper.date?.slice(0, 4) || 'Undated'
    groups.set(label, [...(groups.get(label) || []), paper])
  })

  return Array.from(groups.entries()).map(([label, groupedPapers]) => ({
    label,
    papers: groupedPapers
  }))
})

const togglePaperExpansion = (slug: string) => {
  expandedPaperSlugs.value = expandedPaperSlugs.value.includes(slug)
    ? expandedPaperSlugs.value.filter((item) => item !== slug)
    : [...expandedPaperSlugs.value, slug]
}

const handleSearch = (query: string) => {
  searchQuery.value = query
}

const handleFilter = (tags: string[]) => {
  selectedTags.value = tags
}

const handleSort = (sort: string) => {
  sortBy.value = sort
}

const handleViewChange = (mode: 'grid' | 'list') => {
  viewMode.value = mode
}

const openTagEditor = (paper: Paper) => {
  tagSaveError.value = null
  editingPaper.value = paper
}

const closeTagEditor = () => {
  tagSaveError.value = null
  editingPaper.value = null
}

const handleTagsUpdate = async (newTags: string[]) => {
  if (!editingPaper.value) return

  const success = await updatePaperTags(editingPaper.value.slug, newTags)
  if (success) {
    closeTagEditor()
  } else {
    tagSaveError.value = 'Failed to save tags. Please try again.'
  }
}

const handleRemovePaper = async (slug: string) => {
  const paper = papers.value.find(p => p.slug === slug)
  const title = paper?.title || slug
  if (!confirm(`Delete "${title}"? This will permanently remove the paper and all its study materials.`)) {
    return
  }
  await removePaper(slug)
}

useHead({
  title: 'Research Library'
})
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');

.library-container {
  min-height: 100vh;
  background: #ffffff;
}

/* Top Navigation */
.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: rgba(255, 255, 255, 0.95);
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  padding: 0 2rem;
  z-index: 100;
  backdrop-filter: blur(10px);
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #1f2937;
  font-weight: 600;
  font-family: 'Inter', sans-serif;
}

.logo-icon {
  font-size: 1.25rem;
  color: #6b7280;
}

.logo-text {
  font-size: 0.95rem;
  letter-spacing: 0.01em;
}

/* Library Content */
.library-content {
  padding-top: 64px;
  max-width: 1400px;
  margin: 0 auto;
  padding-left: 2rem;
  padding-right: 2rem;
  padding-bottom: 4rem;
}

.library-header {
  padding: 3rem 0 2rem 0;
}

h1 {
  font-family: 'Crimson Pro', serif;
  font-size: 2.5rem;
  font-weight: 600;
  color: #111827;
  margin: 0 0 0.75rem 0;
}

.subtitle {
  font-family: 'Inter', sans-serif;
  font-size: 1rem;
  color: #6b7280;
  margin: 0;
}

.subtitle code {
  background: #e5e7eb;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.9em;
  color: #374151;
}

.papers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 1.5rem;
  margin-top: 2rem;
  align-items: start;
}

.papers-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 2rem;
}

.collection-directory {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  padding: 1.25rem;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  margin-top: 1.5rem;
}

.collection-directory__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.collection-directory h2 {
  margin: 0;
  font-family: 'Inter', sans-serif;
  font-size: 1rem;
  color: #111827;
}

.collection-directory p {
  margin: 0.25rem 0 0 0;
  color: #6b7280;
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
}

.collection-directory__toggle {
  border: 1px solid #d1d5db;
  background: #ffffff;
  border-radius: 0.375rem;
  color: #374151;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
  font-size: 0.825rem;
  font-weight: 600;
  padding: 0.375rem 0.65rem;
}

.collection-directory__toggle:hover {
  background: #f3f4f6;
}

.collection-directory__groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem 1.5rem;
  margin-top: 1rem;
}

.collection-directory__group h3 {
  margin: 0 0 0.5rem 0;
  color: #4b5563;
  font-family: 'Inter', sans-serif;
  font-size: 0.85rem;
  font-weight: 700;
}

.collection-directory__group ol {
  margin: 0;
  padding-left: 1.2rem;
}

.collection-directory__group li {
  color: #6b7280;
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
  line-height: 1.45;
  margin: 0.4rem 0;
}

.collection-directory__group a {
  color: #2563eb;
  text-decoration: none;
}

.collection-directory__group a:hover {
  text-decoration: underline;
}

.collection-directory__meta {
  color: #9ca3af;
  display: block;
  font-size: 0.78rem;
  margin-top: 0.1rem;
}

/* States */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  padding: 6rem 2rem;
  color: #374151;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 3px solid #e5e7eb;
  border-top-color: #6b7280;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state,
.error-state {
  padding: 6rem 2rem;
  text-align: center;
  color: #6b7280;
  font-family: 'Inter', sans-serif;
}

.empty-state code {
  background: #e5e7eb;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  color: #374151;
}

.error-state {
  color: #c14a4a;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
  gap: 0.75rem;
}

.tag-save-error {
  margin: 0;
  color: #fef2f2;
  background: rgba(127, 29, 29, 0.9);
  border: 1px solid rgba(248, 113, 113, 0.6);
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  font-family: 'Inter', sans-serif;
  font-size: 0.9rem;
}

@media (max-width: 768px) {
  .library-content {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .papers-grid {
    grid-template-columns: 1fr;
  }

  .collection-directory__header {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
