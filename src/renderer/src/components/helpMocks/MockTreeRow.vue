<script setup lang="ts">
// One row of the sidebar's agent list. Three shapes, matching the three the
// real list draws: the workspace heading, the group heading and a pane.
//
// Mirrors ControlPane.vue: `.ws-head` with its caret, folder icon, name and
// ＋ (:3024), `.ws-grp` with its caret, state key, name, count and ＋ (:3134),
// and `.agent-item` / `.agent-line` with the status dot, the name badge and
// the "type · role" sub-line (:3174). Dot colours follow `.status-dot`
// (ControlPane.vue:5548).
defineProps<{
  kind: 'workspace' | 'group' | 'pane'
  label: string
  /** Pane count, on the two heading kinds. */
  count?: number
  /** "type · role" sub-line, on a pane row. */
  sub?: string
  status?: 'running' | 'idle' | 'awaiting'
  /** Lineage depth of a pane row: 1 is a pane an agent opened. */
  depth?: number
  /** Drawn as the focused row. */
  active?: boolean
}>()
</script>

<template>
  <div
    class="mk-row"
    :class="[`mk-row--${kind}`, { 'is-active': active, 'is-nested': kind === 'pane' }]"
    :style="depth ? { marginLeft: depth * 1.1 + 'em' } : undefined"
  >
    <span v-if="kind !== 'pane'" class="mk-row-caret" aria-hidden="true">⌄</span>
    <svg
      v-if="kind === 'workspace'"
      class="mk-row-folder"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z" />
    </svg>
    <span v-else-if="kind === 'group'" class="mk-row-key" />
    <span v-else class="mk-row-dot" :data-state="status ?? 'idle'" />

    <span class="mk-row-label">{{ label }}</span>
    <span v-if="sub" class="mk-row-sub">{{ sub }}</span>
    <span class="mk-row-gap" />
    <span v-if="count != null" class="mk-row-count">{{ count }}</span>
    <span v-if="kind !== 'pane'" class="mk-row-add" aria-hidden="true">＋</span>
  </div>
</template>

<style scoped>
.mk-row {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.25em 0.4em;
  border-radius: var(--radius-xs);
  min-width: 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}
.mk-row--workspace { color: var(--text-bright); font-weight: 600; }
.mk-row--group { color: var(--text-secondary); }
/* The group spine: neutral on purpose — colour on this list means run state,
   not identity (ControlPane.vue:3128). */
.mk-row.is-nested { box-shadow: inset 0.55em 0 0 -0.45em var(--border-default); }
.mk-row.is-active { background: var(--bg-selected); }

.mk-row-caret { flex: none; color: var(--text-muted); }
.mk-row-folder { flex: none; color: var(--text-secondary); }
.mk-row-key {
  flex: none;
  width: 0.25em;
  height: 0.9em;
  border-radius: 1px;
  background: var(--success-fg);
}
.mk-row-dot {
  flex: none;
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: var(--text-muted);
}
.mk-row-dot[data-state='running'] { background: var(--success-fg); }
.mk-row-dot[data-state='idle'] { background: var(--status-idle-fg); }
.mk-row-dot[data-state='awaiting'] {
  background: var(--warning-fg);
  box-shadow: 0 0 0 0.15em color-mix(in srgb, var(--warning-fg) 25%, transparent);
}

.mk-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-row-sub {
  min-width: 0;
  color: var(--text-muted);
  font-size: 0.9em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-row-gap { flex: 1 1 auto; min-width: 0; }
.mk-row-count { flex: none; color: var(--text-muted); }
.mk-row-add { flex: none; color: var(--text-muted); }
</style>
