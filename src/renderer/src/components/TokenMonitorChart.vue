<script setup lang="ts">
import { computed } from 'vue'
import { chartPoints, movingAverage } from '../utils/tokenMonitor'
const props = defineProps<{ values: number[]; label: string; averageLabel: string; fixedMax?: number }>()
const maximum = computed(() => props.fixedMax ?? Math.max(1, ...props.values))
const average = computed(() => movingAverage(props.values))
</script>
<template>
  <figure>
    <figcaption>{{ label }} <span>— {{ averageLabel }}</span></figcaption>
    <svg viewBox="0 0 800 200" role="img" :aria-label="label">
      <text x="24" y="16">{{ maximum.toLocaleString() }}</text>
      <text x="8" y="180">0</text>
      <line x1="24" y1="176" x2="776" y2="176" class="axis" />
      <polyline :points="chartPoints(values, maximum)" class="raw" />
      <polyline :points="chartPoints(average, maximum)" class="average" />
      <circle v-if="values.length === 1" cx="400" :cy="176 - values[0] / maximum * 152" r="3" class="point" />
    </svg>
  </figure>
</template>
<style scoped>
figure { margin: 0; min-width: 0; }
figcaption { font-weight: 600; } figcaption span { color: var(--text-muted); font-weight: normal; }
svg { width: 100%; display: block; } text { fill: var(--text-muted); font-size: 12px; }
.axis { stroke: var(--border-default); } polyline { fill: none; stroke-width: 2; }
.raw { stroke: var(--text-muted); opacity: .6; } .average { stroke: var(--accent-fg); } .point { fill: var(--accent-fg); }
</style>
