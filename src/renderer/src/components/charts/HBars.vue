<script setup lang="ts">
// HBars — horizontal bars whose width is proportional to value / max
// (e.g. CLI version comparison). Pure inline SVG; every string comes in
// through props so the caller owns translation.
import { computed } from 'vue'

export interface HBarRow { label: string; value: number; sub?: string; color?: string; title?: string }

const props = withDefaults(defineProps<{
  rows: HBarRow[]
  valueFormat?: (n: number) => string
  selected?: number | null
  rowHeight?: number
  ariaLabel: string
  emptyText: string
}>(), { valueFormat: undefined, selected: null, rowHeight: 26 })

const emit = defineEmits<{ select: [index: number] }>()

const WIDTH = 700
const LABEL_WIDTH = 140
const PLOT_WIDTH = 400
const PAD_TOP = 8
const PAD_BOTTOM = 8
const BAR_X = LABEL_WIDTH

const format = computed(() => props.valueFormat ?? ((n: number) => n.toLocaleString('en-US')))
const svgHeight = computed(() => props.rows.length * props.rowHeight + PAD_TOP + PAD_BOTTOM)
const maximum = computed(() => Math.max(1, ...props.rows.map((row) => row.value)))
const barHeight = computed(() => Math.max(2, Math.round(props.rowHeight * 0.6)))

const layout = computed(() => props.rows.map((row, i) => {
  const top = PAD_TOP + i * props.rowHeight
  const y = top + Math.round((props.rowHeight - barHeight.value) / 2)
  const width = Math.round(row.value / maximum.value * PLOT_WIDTH)
  return { row, index: i, top, y, width, textY: top + props.rowHeight / 2 + 4 }
}))

const title = (row: HBarRow): string => row.title ?? `${row.label}: ${format.value(row.value)}`
</script>
<template>
  <p v-if="rows.length === 0" class="chart-empty" data-part="empty">{{ emptyText }}</p>
  <svg v-else :viewBox="`0 0 ${WIDTH} ${svgHeight}`" role="img" :aria-label="ariaLabel">
    <line :x1="BAR_X" :y1="PAD_TOP" :x2="BAR_X" :y2="svgHeight - PAD_BOTTOM" class="axis" data-part="axis" />
    <g
      v-for="entry in layout"
      :key="entry.index"
      class="row"
      data-part="row"
      @click="emit('select', entry.index)"
    >
      <title>{{ title(entry.row) }}</title>
      <rect x="0" :y="entry.top" :width="WIDTH" :height="rowHeight" class="hit" data-part="hit" />
      <text :x="BAR_X - 8" :y="entry.textY" text-anchor="end" class="y-label" data-part="y-label">{{ entry.row.label }}</text>
      <rect
        :x="BAR_X"
        :y="entry.y"
        :width="entry.width"
        :height="barHeight"
        class="bar"
        data-part="bar"
        :data-index="entry.index"
        :data-selected="selected === entry.index ? 'true' : undefined"
        :style="{ fill: entry.row.color ?? 'var(--accent-fg)' }"
      />
      <text :x="BAR_X + entry.width + 6" :y="entry.textY" class="value" data-part="value">{{ format(entry.row.value) }}<tspan v-if="entry.row.sub" class="sub" data-part="sub"> · {{ entry.row.sub }}</tspan></text>
    </g>
  </svg>
</template>
<style scoped>
svg { width: 100%; display: block; }
text { fill: var(--text-muted); font-size: var(--font-3xs); }
.axis { stroke: var(--border-default); }
.row { cursor: pointer; }
.hit { fill: transparent; }
.row:hover .hit { fill: var(--bg-hover-faint); }
.bar { opacity: .85; }
.bar[data-selected="true"] { stroke: var(--accent-fg); stroke-width: 1.5; opacity: 1; }
.y-label { fill: var(--text-secondary); }
.value { fill: var(--text-secondary); }
.sub { fill: var(--text-muted); }
.chart-empty { margin: 0; color: var(--text-muted); font-size: var(--font-2xs); }
</style>
