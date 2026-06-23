<template>
  <span class="evidence-badge" :class="`evidence-badge--${sourceType || 'unknown'}`">
    <span class="evidence-badge__icon">{{ icon }}</span>
    <span>{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  sourceType?: string
}>()

const labelMap: Record<string, string> = {
  paper_claim: '论文主张',
  literature_fact: '外部事实',
  inference: '分析推断',
  speculation: '研究猜想'
}

const iconMap: Record<string, string> = {
  paper_claim: 'P',
  literature_fact: 'E',
  inference: 'I',
  speculation: '?'
}

const label = computed(() => labelMap[props.sourceType || ''] || '未标注')
const icon = computed(() => iconMap[props.sourceType || ''] || '!')
</script>

<style scoped>
.evidence-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  padding: 0.18rem 0.55rem;
  font: 0.78rem/1.2 Inter, sans-serif;
  color: #374151;
  background: #ffffff;
  white-space: nowrap;
}

.evidence-badge__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: #f3f4f6;
  font-size: 0.65rem;
  font-weight: 700;
}

.evidence-badge--paper_claim {
  border-color: #bfdbfe;
  color: #1d4ed8;
}

.evidence-badge--literature_fact {
  border-color: #bbf7d0;
  color: #166534;
}

.evidence-badge--inference {
  border-color: #fde68a;
  color: #92400e;
}

.evidence-badge--speculation {
  border-color: #ddd6fe;
  color: #6d28d9;
}
</style>
