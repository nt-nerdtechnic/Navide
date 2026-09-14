<script setup lang="ts">
// A floating menu: an optional picker row at the top, the list of options with
// a ✓ column, and plain entries pinned under a divider at the foot.
//
// Mirrors ControlPane.vue's `.ws-add-menu` (:3392) — the role `<select>`, the
// `.ws-add-div` hairlines, `.ws-add-opt` rows whose ✓ marks the remembered
// agent, and the two `.ws-add-more` entries (Terminal and Manual spawn) that
// sit below the scrolling list rather than inside it.
defineProps<{
  /** Text shown in the picker row; omit for a menu with no picker. */
  select?: string
  items: { label: string; checked?: boolean; dim?: boolean }[]
  /** Entries under the closing divider. */
  footer?: string[]
  mark?: string
}>()
</script>

<template>
  <div class="mk-menu">
    <span v-if="mark" class="mk-menu-mark">{{ mark }}</span>
    <div v-if="select" class="mk-menu-select">
      <span>{{ select }}</span>
      <span class="mk-menu-caret" aria-hidden="true">▾</span>
    </div>
    <div v-if="select" class="mk-menu-div" />
    <div
      v-for="item in items"
      :key="item.label"
      class="mk-menu-opt"
      :class="{ on: item.checked, dim: item.dim }"
    >
      <span class="mk-menu-ck">{{ item.checked ? '✓' : '' }}</span>
      <span class="mk-menu-lb">{{ item.label }}</span>
    </div>
    <template v-if="footer?.length">
      <div class="mk-menu-div" />
      <div v-for="entry in footer" :key="entry" class="mk-menu-opt mk-menu-more">
        <span class="mk-menu-lb">{{ entry }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mk-menu {
  position: relative;
  align-self: flex-start;
  min-width: 0;
  width: min(18em, 100%);
  display: flex;
  flex-direction: column;
  padding: 0.35em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
  box-shadow: 0 2px 8px var(--shadow-overlay);
}
.mk-menu-mark {
  position: absolute;
  top: -0.2em;
  right: -1.2em;
  color: var(--accent-fg);
  font-size: 1.1em;
}

.mk-menu-select {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.25em 0.5em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-secondary);
  min-width: 0;
}
.mk-menu-select span:first-child {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-menu-caret { flex: none; }

.mk-menu-div {
  height: 1px;
  margin: 0.35em 0;
  background: var(--border-muted);
}

.mk-menu-opt {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.22em 0.35em;
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  min-width: 0;
  white-space: nowrap;
}
.mk-menu-opt.on { background: var(--bg-hover); color: var(--text-bright); }
.mk-menu-opt.dim { color: var(--text-muted); }
.mk-menu-ck { flex: none; width: 0.8em; color: var(--accent-fg); }
.mk-menu-lb { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mk-menu-more { color: var(--text-secondary); }
</style>
