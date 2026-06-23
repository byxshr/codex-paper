<template>
  <div class="reasoning-path">
    <article v-for="node in nodes" :key="node.id" class="reasoning-node">
      <div class="reasoning-node__top">
        <span class="node-type">{{ node.type }}</span>
        <EvidenceBadge :source-type="node.sourceType" />
      </div>
      <h3>{{ node.statement }}</h3>
      <p v-if="node.dependsOn?.length" class="node-deps">depends on: {{ node.dependsOn.join(', ') }}</p>
      <div v-if="node.evidenceRefs?.length" class="node-evidence">
        <button v-for="ref in node.evidenceRefs" :key="ref" type="button" @click="$emit('selectEvidence', ref)">
          {{ refLabel(ref) }}
        </button>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  nodes: any[]
}>()

defineEmits<{
  selectEvidence: [evidenceId: string]
}>()

const refLabel = (ref: string) => ref.startsWith('ev-') ? '论文证据' : '外部证据'
</script>

<style scoped>
.reasoning-path {
  display: grid;
  gap: 0.75rem;
}

.reasoning-node {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  background: #ffffff;
}

.reasoning-node__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
}

.node-type {
  color: #6b7280;
  font: 700 0.72rem/1 Inter, sans-serif;
  text-transform: uppercase;
}

h3 {
  margin: 0;
  color: #111827;
  font: 600 1rem/1.45 Inter, sans-serif;
}

.node-deps {
  margin: 0.5rem 0 0;
  color: #6b7280;
  font: 0.82rem/1.45 Inter, sans-serif;
}

.node-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.75rem;
}

.node-evidence button {
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #ffffff;
  color: #374151;
  cursor: pointer;
  font: 0.78rem/1 Inter, sans-serif;
  padding: 0.35rem 0.55rem;
}
</style>
