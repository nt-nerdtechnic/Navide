<script setup lang="ts">
// StackedBars — vertical bars whose height is the sum of their segments
// (e.g. monthly totals stacked per account). Pure inline SVG; every string
// comes in through props so the caller owns translation.
import { computed } from 'vue'

export interface StackedBarSegment { key: string; label: string; value: number; color: string }
export interface StackedBar { label: string; note?: string; segments: StackedBarSegment[] }
export interface StackedBarsLegendItem { key: string; label: string; color: string }

const props = withDefaults(defineProps<{
  bars: StackedBar[]
  legend?: StackedBarsLegendItem[]
  valueFormat?: (n: number) => string
  selected?: number | null
  height?: number
  ariaLabel: string
  emptyText: string
}>(), { legend: undefined, valueFormat: undefined, selected: null, height: 200 })

const emit = defineEmits<{ select: [index: number] }>()

const WIDTH = 800
const PAD_LEFT = 56
const PAD_RIGHT = 16
const PAD_TOP = 20
const PAD_BOTTOM = 36

const format = computed(() => props.valueFormat ?? ((n: number) => n.toLocaleString('en-US')))
const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT
const plotHeight = computed(() => Math.max(1, props.height - PAD_TOP - PAD_BOTTOM))
const baseline = computed(() => PAD_TOP + plotHeight.value)

const totals = computed(() => props.bars.map((bar) => bar.segments.reduce((sum, s) => sum + s.value, 0)))
const maximum = computed(() => Math.max(1, ...totals.value))

const slot = computed(() => plotWidth / Math.max(1, props.bars.length))
const barWidth = computed(() => Math.max(2, Math.min(48, Math.round(slot.value * 0.6))))
const barX = (i: number): number => Math.round(PAD_LEFT + slot.value * i + (slot.value - barWidth.value) / 2)
const barCenter = (i: number): number => barX(i) + barWidth.value / 2
const scaleY = (value: number): number => baseline.value - Math.round(value / maximum.value * plotHeight.value)

/** Segment geometry per bar — stacked bottom-up from cumulative sums so segment heights add up exactly to the bar height. */
const layout = computed(() => props.bars.map((bar, i) => {
  let cumulative = 0
  let previousY = baseline.value
  const segments = bar.segments.map((segment) => {
    cumulative += segment.value
    const y = scaleY(cumulative)
    const rect = { x: barX(i), y, height: previousY - y, segment }
    previousY = y
    return rect
  })
  return { bar, index: i, total: totals.value[i], top: previousY, segments }
}))

const ticks = computed(() => [0, maximum.value / 2, maximum.value].map((value) => ({ value, y: scaleY(value) })))

const legendItems = computed<StackedBarsLegendItem[]>(() => {
  if (props.legend) return props.legend
  const seen = new Map<string, StackedBarsLegendItem>()
  for (const bar of props.bars) for (const s of bar.segments) if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, color: s.color })
  return [...seen.values()]
})
</script>
<template>
  <p v-if="bars.length === 0" class="chart-empty" data-part="empty">{{ emptyText }}</p>
  <div v-else class="chart">
    <svg :viewBox="`0 0 ${WIDTH} ${height}`" role="img" :aria-label="ariaLabel">
      <g v-for="tick in ticks" :key="tick.value">
        <line :x1="PAD_LEFT" :y1="tick.y" :x2="WIDTH - PAD_RIGHT" :y2="tick.y" class="grid" data-part="grid" />
        <text :x="PAD_LEFT - 6" :y="tick.y + 3" text-anchor="end" class="tick" data-part="tick">{{ format(tick.value) }}</text>
      </g>
      <line :x1="PAD_LEFT" :y1="baseline" :x2="WIDTH - PAD_RIGHT" :y2="baseline" class="axis" data-part="axis" />
      <g
        v-for="entry in layout"
        :key="entry.index"
        class="bar"
        data-part="bar"
        :data-index="entry.index"
        :data-selected="selected === entry.index ? 'true' : undefined"
        @click="emit('select', entry.index)"
      >
        <rect :x="barX(entry.index) - 4" :y="PAD_TOP" :width="barWidth + 8" :height="plotHeight" class="hit" data-part="hit" />
        <rect
          v-for="(seg, j) in entry.segments"
          :key="j"
          :x="seg.x"
          :y="seg.y"
          :width="barWidth"
          :height="seg.height"
          class="segment"
          data-part="segment"
          :data-key="seg.segment.key"
          :style="{ fill: seg.segment.color }"
        >
          <title>{{ entry.bar.label }} · {{ seg.segment.label }}: {{ format(seg.segment.value) }}</title>
        </rect>
        <text :x="barCenter(entry.index)" :y="entry.top - 4" text-anchor="middle" class="total" data-part="bar-total">{{ format(entry.total) }}</text>
        <text :x="barCenter(entry.index)" :y="baseline + 14" text-anchor="middle" class="x-label" data-part="x-label">{{ entry.bar.label }}</text>
        <text v-if="entry.bar.note" :x="barCenter(entry.index)" :y="baseline + 26" text-anchor="middle" class="x-note" data-part="x-note">{{ entry.bar.note }}</text>
      </g>
    </svg>
    <ul class="chart-legend">
      <li v-for="item in legendItems" :key="item.key" data-part="legend-item" :data-key="item.key">
        <span class="swatch" :style="{ background: item.color }" />{{ item.label }}
      </li>
    </ul>
  </div>
</template>
<style scoped>
.chart { min-width: 0; }
svg { width: 100%; display: block; }
text { fill: var(--text-muted); font-size: var(--font-3xs); }
.grid { stroke: var(--border-muted); }
.axis { stroke: var(--border-default); }
.bar { cursor: pointer; }
.hit { fill: transparent; }
.bar:hover .hit { fill: var(--bg-hover-faint); }
.segment { stroke: none; }
.bar[data-selected="true"] .segment { stroke: var(--accent-fg); stroke-width: 1.5; }
.total { fill: var(--text-secondary); font-size: var(--font-3xs); }
.x-label { fill: var(--text-secondary); }
.x-note { fill: var(--text-muted); font-size: var(--font-3xs); opacity: .8; }
.chart-empty { margin: 0; color: var(--text-muted); font-size: var(--font-2xs); }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; padding: 0; list-style: none; color: var(--text-secondary); font-size: var(--font-3xs); }
.chart-legend li { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
</style>
