<script setup lang="ts">
// One pane on the stage: the header strip (name, ∞ loop button, status pill)
// over the terminal body. The body is drawn as blank lines rather than text —
// a pane's transcript is whatever the CLI printed, so inventing sentences
// would be the one part of the picture that could not be true.
//
// Boundary with MockEnvelopePane: that one prints real text in the body and
// is only for the envelope Navide itself writes. This one draws blank bars and
// is for everything else. Keeping them apart is what stops invented CLI output
// from reaching a picture — do not fold them together behind a flag.
//
// Mirrors TerminalPane.vue: `.pane` / `.pane-header` / `.header-main` with the
// title, the ∞ button and the trailing `.status` pill (:559), whose colours
// follow `.status[data-status]` (:869).
withDefaults(
  defineProps<{
    title: string
    /** Localised status word — the same one the real pill prints. */
    statusLabel: string
    status?: 'running' | 'idle' | 'awaiting'
    /** Draw it as the focused pane. */
    focus?: boolean
    /** How many transcript lines to suggest. */
    lines?: number
  }>(),
  { status: 'idle', lines: 4 },
)
</script>

<template>
  <div class="mk-pane" :class="{ 'is-focus': focus }">
    <div class="mk-pane-head">
      <span class="mk-pane-title">{{ title }}</span>
      <span class="mk-pane-loop" aria-hidden="true">∞</span>
      <span class="mk-pane-status" :data-status="status">{{ statusLabel }}</span>
    </div>
    <div class="mk-pane-body" aria-hidden="true">
      <span v-for="n in lines" :key="n" class="mk-pane-line" :style="{ width: 92 - n * 13 + '%' }" />
      <span class="mk-pane-caret" />
    </div>
  </div>
</template>

<style scoped>
.mk-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  overflow: hidden;
}
.mk-pane.is-focus { border-color: var(--accent-fg); }

.mk-pane-head {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.25em 0.5em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
}
.mk-pane-title {
  color: var(--text-bright);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-pane-loop { flex: none; color: var(--text-muted); }
.mk-pane-status {
  flex: none;
  margin-left: auto;
  font-size: 0.82em;
  text-transform: uppercase;
  padding: 0 0.5em;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.mk-pane-status[data-status='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.mk-pane-status[data-status='idle'] {
  background: var(--status-idle-muted);
  color: var(--status-idle-fg);
}
.mk-pane-status[data-status='awaiting'] {
  background: color-mix(in srgb, var(--warning-fg) 20%, transparent);
  color: var(--warning-fg);
}

.mk-pane-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  padding: 0.55em 0.5em;
  background: var(--bg-inset);
}
.mk-pane-line {
  height: 0.3em;
  border-radius: 999px;
  background: var(--border-default);
}
.mk-pane-caret {
  width: 0.45em;
  height: 0.55em;
  background: var(--accent-fg);
}
</style>
