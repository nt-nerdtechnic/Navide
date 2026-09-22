<script setup lang="ts">
// The left sidebar: ControlPane's icon-only tab strip across the top and the
// list underneath. Callers put MockTreeRow rows in the default slot.
//
// Mirrors ControlPane.vue: `<aside class="sidebar">` (:2512), the icon tab
// strip `.sidebar-tabs` with its trailing collapse chevron (:2573, :2634) and
// the `.agent-list` below it (:3027). Width tracks the shipped default of the
// `--left-width` track (App.vue:17952).
defineProps<{
  /** One glyph per tab, in the sidebar's own order. */
  icons: string[]
  /** Index of the selected tab. */
  active?: number
  mark?: string
}>()
</script>

<template>
  <div class="mk-side">
    <div class="mk-side-tabs">
      <span
        v-for="(icon, i) in icons"
        :key="icon"
        class="mk-side-tab"
        :class="{ on: i === (active ?? 0) }"
      >{{ icon }}</span>
      <span class="mk-side-gap" />
      <span class="mk-side-fold" aria-hidden="true">‹</span>
      <span v-if="mark" class="mk-side-mark">{{ mark }}</span>
    </div>
    <div class="mk-side-list"><slot /></div>
  </div>
</template>

<style scoped>
.mk-side {
  flex: 0 0 34%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  border-right: 1px solid var(--border-muted);
}

.mk-side-tabs {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.35em 0.5em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-side-tab {
  flex: none;
  opacity: 0.55;
  filter: grayscale(1);
}
.mk-side-tab.on {
  opacity: 1;
  filter: none;
}
.mk-side-gap { flex: 1; }
.mk-side-fold { flex: none; color: var(--text-muted); }
.mk-side-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }

.mk-side-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.4em 0.35em;
  min-width: 0;
}
</style>
