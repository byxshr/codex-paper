<template>
  <div class="reviewer-panel">
    <section>
      <h3>最弱假设</h3>
      <p>{{ reasoning?.weakestAssumption?.statement || '未提供' }}</p>
      <small>{{ reasoning?.weakestAssumption?.observableFailure }}</small>
    </section>
    <section>
      <h3>最小复现</h3>
      <p><strong>支持:</strong> {{ join(reasoning?.minimalReproduction?.supportCriteria) }}</p>
      <p><strong>证伪:</strong> {{ join(reasoning?.minimalReproduction?.falsificationCriteria) }}</p>
    </section>
    <section>
      <h3>最强反例</h3>
      <p>{{ reasoning?.strongestCounterexample?.setup || '未提供' }}</p>
      <small>{{ reasoning?.strongestCounterexample?.predictedObservation }}</small>
    </section>
    <section>
      <h3>非增量后续研究</h3>
      <p>{{ reasoning?.followUpIdea?.novelFraming || '未提供' }}</p>
      <small>{{ reasoning?.followUpIdea?.whyNonIncremental }}</small>
    </section>
    <section>
      <h3>不确定区域</h3>
      <ul>
        <li v-for="zone in reasoning?.uncertaintyZones || []" :key="zone.topic">
          <strong>{{ zone.topic }}:</strong> {{ zone.reason }}
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  reasoning: any
}>()

const join = (value: any) => Array.isArray(value) ? value.join('; ') : (value || '未提供')
</script>

<style scoped>
.reviewer-panel {
  display: grid;
  gap: 1rem;
}

section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  background: #ffffff;
}

h3 {
  margin: 0 0 0.5rem;
  font: 700 0.95rem/1.3 Inter, sans-serif;
  color: #111827;
}

p,
li {
  color: #374151;
  line-height: 1.55;
}

p {
  margin: 0.35rem 0;
}

small {
  color: #6b7280;
  line-height: 1.5;
}

ul {
  margin: 0;
  padding-left: 1.1rem;
}
</style>
