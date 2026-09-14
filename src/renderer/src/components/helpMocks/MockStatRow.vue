<script setup lang="ts">
// One row of a monitoring table: name with its "workspace · vendor" line, a
// trend sparkline, the numeric columns, and the row's single action.
//
// Mirrors ResourceManagerModal.vue's `.rm-row` — the `.rm-jump` name button
// with `.rm-dot` and `.rm-meta`, the `.c-trend` sparkline drawn as an SVG
// polyline, the `.c-cpu` / `.c-mem` columns, and the `.rm-mini` Reclaim button
// (:418-446). The header above them is `.rm-head-row` (:410).
//
// Distinct from MockFormRow on purpose: that one is a settings row (grip,
// checkbox, flag, dropdown), this one is a readout (figures over time). They
// share no columns, so folding them together would give one row component with
// two disjoint halves.
const props = defineProps<{
  name: string
  /** The "workspace · vendor" line under the name. */
  meta?: string
  /** Sparkline samples, oldest first. Drawn as the real one is: a polyline. */
  trend?: number[]
  /** The numeric columns, in the order the table prints them. */
  values?: string[]
  /** Chip before the values. */
  tag?: string
  /** The row's one button. */
  action?: string
  /** Dot colour, matching the pane's run state. */
  state?: 'running' | 'idle'
  mark?: string
}>()

/** Same shape the real sparkline uses: a 60×16 viewBox, oldest sample left. */
function points(trend: number[]): string {
  const max = Math.max(...trend, 1)
  const step = trend.length > 1 ? 60 / (trend.length - 1) : 60
  return trend.map((v, i) => `${(i * step).toFixed(1)},${(16 - (v / max) * 14).toFixed(1)}`).join(' ')
}
</script>

<template>
  <div class="mk-stat">
    <span class="mk-stat-name">
      <span class="mk-stat-dot" :data-state="state ?? 'running'" />
      <span class="mk-stat-text">
        <span class="mk-stat-title">{{ name }}</span>
        <span v-if="meta" class="mk-stat-meta">{{ meta }}</span>
      </span>
    </span>
    <span class="mk-stat-trend">
      <svg v-if="props.trend?.length" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
        <polyline :points="points(props.trend)" />
      </svg>
    </span>
    <span v-if="tag" class="mk-stat-tag">{{ tag }}</span>
    <span v-for="value in values ?? []" :key="value" class="mk-stat-value">{{ value }}</span>
    <span v-if="action" class="mk-stat-btn">{{ action }}</span>
    <span v-if="mark" class="mk-stat-mark">{{ mark }}</span>
  </div>
</template>

<style scoped>
.mk-stat {
  display: flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.3em 0.5em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  white-space: nowrap;
}
.mk-stat:last-child { border-bottom: none; }

.mk-stat-name {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.35em;
}
.mk-stat-dot {
  flex: none;
  width: 0.5em;
  height: 0.5em;
  border-radius: 50%;
  background: var(--attention-fg);
}
.mk-stat-dot[data-state='running'] { background: var(--success-fg); }
/* The real dot defaults to attention and only turns green for a running
   pane (ResourceManagerModal.vue:645), so idle is the default here too. */
.mk-stat-dot[data-state='idle'] { background: var(--attention-fg); }
.mk-stat-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.mk-stat-title {
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-stat-meta {
  color: var(--text-muted);
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mk-stat-trend { flex: none; width: 3.4em; height: 1em; }
.mk-stat-trend svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: var(--accent-fg);
  stroke-width: 1.4;
  vector-effect: non-scaling-stroke;
}

.mk-stat-tag {
  flex: none;
  padding: 0 0.4em;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-muted);
  font-size: 0.8em;
  letter-spacing: 0.05em;
}
.mk-stat-value {
  flex: none;
  min-width: 3.2em;
  text-align: right;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.mk-stat-btn {
  flex: none;
  padding: 0 0.45em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-secondary);
}
.mk-stat-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }
</style>
