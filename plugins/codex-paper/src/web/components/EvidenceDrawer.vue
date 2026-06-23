<template>
  <div v-if="open" class="drawer-shell">
    <button class="drawer-backdrop" type="button" @click="$emit('close')" aria-label="Close evidence drawer"></button>
    <aside class="drawer">
      <header class="drawer__header">
        <div>
          <p class="drawer__eyebrow">Evidence</p>
          <h2>{{ evidence?.id || '未选择证据' }}</h2>
        </div>
        <button class="drawer__close" type="button" @click="$emit('close')">×</button>
      </header>

      <div v-if="evidence" class="drawer__body">
        <dl class="meta-grid">
          <div>
            <dt>类型</dt>
            <dd>{{ evidence.kind }}</dd>
          </div>
          <div>
            <dt>置信度</dt>
            <dd>{{ evidence.confidence }}</dd>
          </div>
          <div>
            <dt>位置</dt>
            <dd>{{ locator }}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>{{ (evidence.roles || []).join(', ') || 'none' }}</dd>
          </div>
        </dl>

        <blockquote>{{ evidence.quote || evidence.text }}</blockquote>
        <a v-if="evidence.location?.page" class="pdf-link" :href="`/api/papers/${slug}/raw?path=paper.pdf#page=${evidence.location.page}`" target="_blank">
          打开 paper.pdf p.{{ evidence.location.page }}
        </a>
      </div>

      <p v-else class="drawer__empty">选择一个证据引用查看短摘录和自然位置。</p>
    </aside>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  open: boolean
  evidence: any
  slug: string
}>()

defineEmits<{
  close: []
}>()

const locator = computed(() => {
  const location = props.evidence?.location || {}
  const labels = location.labels || {}
  return [
    location.page ? `论文 p.${location.page}` : '论文位置未知',
    location.sectionTitle ? `§${location.sectionTitle}` : '',
    labels.tableNumber,
    labels.figureNumber,
    labels.equationNumber
  ].filter(Boolean).join('，')
})
</script>

<style scoped>
.drawer-shell {
  position: fixed;
  inset: 0;
  z-index: 300;
  pointer-events: none;
}

.drawer-backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(15, 23, 42, 0.18);
  pointer-events: auto;
}

.drawer {
  position: absolute;
  top: 0;
  right: 0;
  width: min(460px, 100vw);
  height: 100%;
  background: #ffffff;
  border-left: 1px solid #e5e7eb;
  box-shadow: -16px 0 40px rgba(15, 23, 42, 0.14);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
}

.drawer__header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem;
  border-bottom: 1px solid #e5e7eb;
}

.drawer__eyebrow {
  margin: 0 0 0.25rem;
  color: #6b7280;
  font: 0.75rem/1 Inter, sans-serif;
  text-transform: uppercase;
}

.drawer h2 {
  margin: 0;
  color: #111827;
  font: 600 1rem/1.3 Inter, sans-serif;
}

.drawer__close {
  width: 32px;
  height: 32px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  cursor: pointer;
}

.drawer__body {
  padding: 1.25rem;
  overflow-y: auto;
}

.meta-grid {
  display: grid;
  gap: 0.75rem;
  margin: 0 0 1rem;
}

.meta-grid div {
  border-bottom: 1px solid #f3f4f6;
  padding-bottom: 0.6rem;
}

.meta-grid dt {
  color: #6b7280;
  font: 0.75rem/1.2 Inter, sans-serif;
}

.meta-grid dd {
  margin: 0.2rem 0 0;
  color: #111827;
  font: 0.9rem/1.45 Inter, sans-serif;
}

blockquote {
  margin: 1rem 0;
  border-left: 3px solid #111827;
  padding: 0.75rem 1rem;
  background: #f9fafb;
  color: #374151;
  line-height: 1.6;
}

.pdf-link {
  color: #2563eb;
  text-decoration: none;
}

.drawer__empty {
  padding: 1.25rem;
  color: #6b7280;
}
</style>
