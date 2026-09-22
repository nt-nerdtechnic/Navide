<script setup lang="ts">
// A labelled bar: name on the left, figure on the right, the bar under them
// and an optional note below.
//
// Mirrors UsageBadge.vue's `.usage-row` — `.usage-row-label` beside
// `.usage-row-left`, the `.usage-bar` / `.usage-bar-fill` pair and the
// `.usage-row-reset` line (:80-95).
withDefaults(
  defineProps<{
    label: string
    /** The figure printed on the right, already localised. */
    value: string
    /** Bar fill, 0-100. */
    percent: number
    tier?: 'ok' | 'warn' | 'crit'
    /** Grey line under the bar, e.g. when the window resets. */
    note?: string
  }>(),
  { tier: 'ok' },
)
</script>

<template>
  <div class="mk-meter">
    <div class="mk-meter-top">
      <span class="mk-meter-label">{{ label }}</span>
      <span class="mk-meter-value" :class="tier">{{ value }}</span>
    </div>
    <div class="mk-meter-bar">
      <span class="mk-meter-fill" :class="tier" :style="{ width: `${percent}%` }" />
    </div>
    <div v-if="note" class="mk-meter-note">{{ note }}</div>
  </div>
</template>

<style scoped>
.mk-meter {
  display: flex;
  flex-direction: column;
  gap: 0.25em;
  min-width: 0;
}
.mk-meter-top {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  min-width: 0;
}
.mk-meter-label {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-meter-value { flex: none; color: var(--success-fg); }
.mk-meter-value.warn { color: var(--attention-fg); }
.mk-meter-value.crit { color: var(--danger-fg); }

.mk-meter-bar {
  height: 0.4em;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
}
.mk-meter-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--success-fg);
}
.mk-meter-fill.warn { background: var(--attention-fg); }
.mk-meter-fill.crit { background: var(--danger-fg); }

.mk-meter-note { color: var(--text-muted); font-size: 0.9em; }
</style>
