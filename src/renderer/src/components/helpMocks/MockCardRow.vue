<script setup lang="ts">
// One row of a settings list: name, one-line blurb, and the button or badge
// on the right. Used for the MCP catalog cards and for the installed-server
// rows, which share this shape.
//
// Boundary with MockPanel: that one is a titled CONTAINER, this one is a ROW.
// See MockPanel.vue's own note.
//
// Mirrors SettingsModal.vue's `.mcp-catalog-card`: `.mcp-catalog-info` holding
// `.mcp-catalog-name` over `.mcp-catalog-desc` (:2163), with either the
// disabled `.mcp-installed-badge` or the primary `.mcp-add-btn` at the end
// (:2171).
defineProps<{
  title: string
  text?: string
  /** Button label. Drawn as the primary action. */
  action?: string
  /** Flat badge instead of a button — the "already installed" state. */
  badge?: string
  mark?: string
}>()
</script>

<template>
  <div class="mk-card">
    <span class="mk-card-info">
      <span class="mk-card-title">{{ title }}</span>
      <span v-if="text" class="mk-card-text">{{ text }}</span>
    </span>
    <span v-if="badge" class="mk-card-badge">{{ badge }}</span>
    <span v-else-if="action" class="mk-card-btn">{{ action }}</span>
    <span v-if="mark" class="mk-card-mark">{{ mark }}</span>
  </div>
</template>

<style scoped>
.mk-card {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.45em 0.55em;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  min-width: 0;
}
.mk-card-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15em;
}
.mk-card-title {
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-card-text {
  color: var(--text-muted);
  font-size: 0.92em;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.mk-card-badge {
  flex: none;
  padding: 0.1em 0.45em;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-muted);
  white-space: nowrap;
}
.mk-card-btn {
  flex: none;
  padding: 0.1em 0.5em;
  border-radius: var(--radius-xs);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  white-space: nowrap;
}
.mk-card-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }
</style>
