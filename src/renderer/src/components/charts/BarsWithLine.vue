<script setup lang="ts">
// BarsWithLine — bars on a left value axis plus a percent line (0–100) on a
// right axis, with a red dot on exhausted cycles. Pure inline SVG; every
// string comes in through props so the caller owns translation.
import { computed } from 'vue'

export interface BarWithLine { label: string; note?: string; value: number | null; percent: number | null; exhausted: boolean }

const props = withDefaults(defineProps<{
  bars: BarWithLine[]
  valueFormat?: (n: number) => string
  percentFormat?: (p: number) => string
  selected?: number | null
  height?: number
  ariaLabel: string
  emptyText: string
}>(), { valueFormat: undefined, percentFormat: undefined, selected: null, height: 200 })

const emit = defineEmits<{ select: [index: number] }>()

const WIDTH = 800
const PAD_LEFT = 56
const PAD_RIGHT = 48
const PAD_TOP = 20
const PAD_BOTTOM = 36

const format = computed(() => props.valueFormat ?? ((n: number) => n.toLocaleString('en-US')))
const formatPercent = computed(() => props.percentFormat ?? ((p: number) => `${Math.round(p)}%`))
const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT
const plotHeight = computed(() => Math.max(1, props.height - PAD_TOP - PAD_BOTTOM))
const baseline = computed(() => PAD_TOP + plotHeight.value)

const maximum = computed(() => Math.max(1, ...props.bars.map((bar) => bar.value ?? 0)))
const slot = computed(() => plotWidth / Math.max(1, props.bars.length))
const barWidth = computed(() => Math.max(2, Math.min(48, Math.round(slot.value * 0.6))))
const barX = (i: number): number => Math.round(PAD_LEFT + slot.value * i + (slot.value - barWidth.value) / 2)
const barCenter = (i: number): number => barX(i) + barWidth.value / 2
const scaleY = (value: number): number => baseline.value - Math.round(value / maximum.value * plotHeight.value)
const scalePercent = (p: number): number => baseline.value - Math.round(Math.min(100, Math.max(0, p)) / 100 * plotHeight.value)

const layout = computed(() => props.bars.map((bar, i) => {
  const y = scaleY(bar.value ?? 0)
  return { bar, index: i, x: barX(i), y, height: baseline.value - y }
}))

const ticks = computed(() => [0, maximum.value / 2, maximum.value].map((value) => ({ value, y: scaleY(value) })))
const percentTicks = computed(() => [0, 50, 100].map((p) => ({ p, y: scalePercent(p) })))

/** One point per bar whose percent is known; the line skips the others. */
const points = computed(() => props.bars.flatMap((bar, i) => bar.percent === null
  ? []
  : [{ index: i, cx: barCenter(i), cy: scalePercent(bar.percent), exhausted: bar.exhausted }]))
const linePoints = computed(() => points.value.map((p) => `${p.cx},${p.cy}`).join(' '))

const title = (bar: BarWithLine): string =>
  `${bar.label}: ${bar.value === null ? '—' : format.value(bar.value)}` + (bar.percent !== null ? ` · ${formatPercent.value(bar.percent)}` : '') + (bar.note ? ` · ${bar.note}` : '')
</script>
<template>
  <p v-if="bars.length === 0" class="chart-empty" data-part="empty">{{ emptyText }}</p>
  <svg v-else :viewBox="`0 0 ${WIDTH} ${height}`" role="img" :aria-label="ariaLabel">
    <g v-for="tick in ticks" :key="tick.value">
      <line :x1="PAD_LEFT" :y1="tick.y" :x2="WIDTH - PAD_RIGHT" :y2="tick.y" class="grid" data-part="grid" />
      <text :x="PAD_LEFT - 6" :y="tick.y + 3" text-anchor="end" class="tick" data-part="tick">{{ format(tick.value) }}</text>
    </g>
    <text v-for="tick in percentTicks" :key="tick.p" :x="WIDTH - PAD_RIGHT + 6" :y="tick.y + 3" class="pct" data-part="pct-label">{{ formatPercent(tick.p) }}</text>
    <line :x1="PAD_LEFT" :y1="baseline" :x2="WIDTH - PAD_RIGHT" :y2="baseline" class="axis" data-part="axis" />
    <g
      v-for="entry in layout"
      :key="entry.index"
      class="bar-group"
      data-part="bar-group"
      role="button"
      tabindex="0"
      :aria-label="title(entry.bar)"
      :aria-pressed="selected === entry.index"
      @keydown.enter="emit('select', entry.index)"
      @keydown.space.prevent="emit('select', entry.index)"
      @click="emit('select', entry.index)"
    >
      <title>{{ title(entry.bar) }}</title>
      <rect :x="entry.x - 4" :y="PAD_TOP" :width="barWidth + 8" :height="plotHeight" class="hit" data-part="hit" />
      <rect
        v-if="entry.bar.value !== null"
        :x="entry.x"
        :y="entry.y"
        :width="barWidth"
        :height="entry.height"
        class="bar"
        data-part="bar"
        :data-index="entry.index"
        :data-selected="selected === entry.index ? 'true' : undefined"
      />
      <text :x="barCenter(entry.index)" :y="entry.y - 4" text-anchor="middle" class="total" data-part="bar-total">{{ entry.bar.value === null ? '—' : format(entry.bar.value) }}</text>
      <text :x="barCenter(entry.index)" :y="baseline + 14" text-anchor="middle" class="x-label" data-part="x-label">{{ entry.bar.label }}</text>
      <text v-if="entry.bar.note" :x="barCenter(entry.index)" :y="baseline + 26" text-anchor="middle" class="x-note" data-part="x-note">{{ entry.bar.note }}</text>
    </g>
    <polyline v-if="points.length" :points="linePoints" class="line" data-part="line" />
    <template v-for="p in points" :key="p.index">
      <circle v-if="p.exhausted" :cx="p.cx" :cy="p.cy" r="4" class="dot" data-part="dot" data-exhausted="true" />
      <circle v-else :cx="p.cx" :cy="p.cy" r="2.5" class="point" data-part="point" />
    </template>
  </svg>
</template>
<style scoped>
svg { width: 100%; display: block; }
text { fill: var(--text-muted); font-size: var(--font-3xs); }
.grid { stroke: var(--border-muted); }
.axis { stroke: var(--border-default); }
.pct { fill: var(--attention-fg); }
.bar-group { cursor: pointer; }
.hit { fill: transparent; }
.bar-group:hover .hit { fill: var(--bg-hover-faint); }
.bar-group:focus-visible .hit { stroke: var(--accent-fg); stroke-width: 2; }
.bar { fill: var(--accent-fg); opacity: .75; }
.bar[data-selected="true"] { stroke: var(--accent-fg); stroke-width: 1.5; opacity: 1; }
.total { fill: var(--text-secondary); }
.x-label { fill: var(--text-secondary); }
.x-note { fill: var(--text-muted); opacity: .8; }
.line { fill: none; stroke: var(--attention-fg); stroke-width: 2; pointer-events: none; }
.point { fill: var(--attention-fg); pointer-events: none; }
.dot { fill: var(--danger-fg); pointer-events: none; }
.chart-empty { margin: 0; color: var(--text-muted); font-size: var(--font-2xs); }
</style>
