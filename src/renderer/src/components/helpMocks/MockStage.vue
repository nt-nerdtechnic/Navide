<script setup lang="ts">
// The stage: the run-group tab bar across the top and the pane grid under it.
// Callers put MockPaneCard panes in the default slot.
//
// Mirrors StageTabBar.vue's `.stage-tab-bar` — the status dot, label, count
// and ✕ on each tab, the trailing ＋ and rebuild buttons, and the actions slot
// that holds ViewPanel's four mode glyphs (StageTabBar.vue:63, ViewPanel.vue:7)
// — plus App.vue's `.grid` inside `<main class="stage">` (App.vue:16962).
withDefaults(
  defineProps<{
    tabs: { label: string; count: number; status?: 'running' | 'idle' | 'awaiting' }[]
    /** Index of the open tab; its panes are the ones on the grid. */
    active?: number
    /** Columns the grid splits into. */
    columns?: number
    tabMark?: string
    addMark?: string
    gridMark?: string
  }>(),
  { active: 0, columns: 2 },
)
</script>

<template>
  <div class="mk-stage">
    <div class="mk-stage-tabs">
      <span
        v-for="(tab, i) in tabs"
        :key="tab.label"
        class="mk-tab"
        :class="{ on: i === active }"
      >
        <span class="mk-tab-dot" :data-state="tab.status ?? 'idle'" />
        <span class="mk-tab-label">{{ tab.label }}</span>
        <span class="mk-tab-count">{{ tab.count }}</span>
        <span class="mk-tab-x" aria-hidden="true">✕</span>
        <span v-if="i === active && tabMark" class="mk-mark">{{ tabMark }}</span>
      </span>
      <span class="mk-tab-add" aria-hidden="true">+</span>
      <span v-if="addMark" class="mk-mark">{{ addMark }}</span>
      <span class="mk-stage-gap" />
      <span class="mk-stage-modes" aria-hidden="true">
        <span class="on">⊞</span><span>◧</span><span>◎</span><span>⧉</span>
      </span>
    </div>
    <div class="mk-stage-grid" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
      <slot />
      <span v-if="gridMark" class="mk-mark mk-mark--grid">{{ gridMark }}</span>
    </div>
  </div>
</template>

<style scoped>
.mk-stage {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
}

.mk-stage-tabs {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.3em 0.5em;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  flex: none;
  padding: 0.2em 0.5em;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  min-width: 0;
}
.mk-tab.on {
  color: var(--text-bright);
  background: var(--bg-muted);
  box-shadow: inset 0 -2px 0 var(--accent-fg);
}
.mk-tab-dot {
  width: 0.45em;
  height: 0.45em;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}
.mk-tab-dot[data-state='running'] { background: var(--success-fg); }
.mk-tab-dot[data-state='idle'] { background: var(--status-idle-fg); }
.mk-tab-dot[data-state='awaiting'] { background: var(--warning-fg); }
.mk-tab-label { overflow: hidden; text-overflow: ellipsis; }
.mk-tab-count,
.mk-tab-x { color: var(--text-muted); font-size: 0.9em; }
.mk-tab-add { flex: none; color: var(--text-secondary); padding: 0 0.3em; }
.mk-stage-gap { flex: 1; }
.mk-stage-modes { display: inline-flex; gap: 0.25em; flex: none; color: var(--text-muted); }
.mk-stage-modes .on { color: var(--accent-fg); }

.mk-stage-grid {
  position: relative;
  display: grid;
  gap: 0.45em;
  padding: 0.45em;
  min-width: 0;
}

.mk-mark { color: var(--accent-fg); font-size: 1.1em; flex: none; }
.mk-mark--grid {
  position: absolute;
  right: 0.3em;
  bottom: 0.1em;
}
</style>
