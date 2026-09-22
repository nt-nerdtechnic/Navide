<script setup lang="ts">
// The right-hand panel in its shipped, collapsed form: one icon per tab with
// its name set vertically beside it.
//
// Mirrors TokenStatsPanel.vue's `.rail` (:339) — the emoji from its own TABS
// table (:90) and the `writing-mode: vertical-rl` label that keeps CJK upright
// (:578). Width tracks the `--token-panel-width` track's 36px default
// (App.vue:17955).
defineProps<{
  items: { icon: string; label: string }[]
  /** Index of the tab the panel would open on. */
  active?: number
  mark?: string
}>()
</script>

<template>
  <div class="mk-rail">
    <span v-if="mark" class="mk-rail-mark">{{ mark }}</span>
    <span
      v-for="(item, i) in items"
      :key="item.label"
      class="mk-rail-btn"
      :class="{ on: i === (active ?? -1) }"
    >
      <span class="mk-rail-icon">{{ item.icon }}</span>
      <span class="mk-rail-label">{{ item.label }}</span>
    </span>
  </div>
</template>

<style scoped>
.mk-rail {
  flex: 0 0 2.6em;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7em;
  padding: 0.5em 0;
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  overflow: hidden;
}
.mk-rail-mark { color: var(--accent-fg); font-size: 1.1em; }
.mk-rail-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35em;
  color: var(--text-secondary);
}
.mk-rail-btn.on { color: var(--accent-fg); }
.mk-rail-icon { font-size: 1.05em; }
.mk-rail-label {
  writing-mode: vertical-rl;
  letter-spacing: 0.5px;
  font-size: 0.82em;
  text-transform: uppercase;
}
</style>
