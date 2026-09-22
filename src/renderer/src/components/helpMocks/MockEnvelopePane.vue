<script setup lang="ts">
// A pane with the envelope Navide typed into it, rather than MockPaneCard's
// blank transcript lines. The distinction matters: a CLI's own output is
// whatever it printed and cannot honestly be invented, but the envelope is a
// string Navide itself writes, so quoting it is the one piece of terminal
// content a picture is allowed to show.
//
// Header mirrors TerminalPane.vue's `.pane` / `.pane-header` with the title
// and the trailing `.status` pill (:559, colours at :869), the same shape
// MockPaneCard.vue draws. The body is the injected envelope: its first line is
// MSG_ENVELOPE_PREFIX (`[Navide MSG] from:`) followed by the sender handle,
// assembled in agentMessaging.ts:334.
withDefaults(
  defineProps<{
    title: string
    /** Localised status word — the same one the real pill prints. */
    statusLabel: string
    status?: 'running' | 'idle' | 'awaiting'
    /** Transcript lines. `dim` renders as Navide's own framing, not agent text. */
    lines: { text: string; dim?: boolean }[]
    /** Draw a caret after the last line, as a pane waiting at the prompt does. */
    caret?: boolean
    focus?: boolean
    /** Key mark on the header, beside the status pill. */
    mark?: string
    /** Key mark on the transcript itself. */
    bodyMark?: string
  }>(),
  { status: 'idle' },
)
</script>

<template>
  <div class="mk-env" :class="{ 'is-focus': focus }">
    <div class="mk-env-head">
      <span class="mk-env-title">{{ title }}</span>
      <span class="mk-env-loop" aria-hidden="true">∞</span>
      <span class="mk-env-status" :data-status="status">{{ statusLabel }}</span>
      <span v-if="mark" class="mk-env-mark">{{ mark }}</span>
    </div>
    <div class="mk-env-body">
      <span v-if="bodyMark" class="mk-env-mark mk-env-mark--body">{{ bodyMark }}</span>
      <span
        v-for="(line, i) in lines"
        :key="i"
        class="mk-env-line"
        :class="{ dim: line.dim }"
      >{{ line.text }}</span>
      <span v-if="caret" class="mk-env-caret" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.mk-env {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  overflow: hidden;
}
.mk-env.is-focus { border-color: var(--accent-fg); }

.mk-env-head {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.25em 0.5em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
}
.mk-env-title {
  color: var(--text-bright);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-env-loop { flex: none; color: var(--text-muted); }
.mk-env-status {
  flex: none;
  margin-left: auto;
  font-size: 0.82em;
  text-transform: uppercase;
  padding: 0 0.5em;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.mk-env-status[data-status='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.mk-env-status[data-status='idle'] {
  background: var(--status-idle-muted);
  color: var(--status-idle-fg);
}
.mk-env-status[data-status='awaiting'] {
  background: color-mix(in srgb, var(--warning-fg) 20%, transparent);
  color: var(--warning-fg);
}
.mk-env-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }
.mk-env-mark--body {
  position: absolute;
  right: 0.3em;
  top: 0.25em;
}

.mk-env-body {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15em;
  padding: 0.5em;
  background: var(--bg-inset);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  line-height: 1.5;
  min-width: 0;
}
.mk-env-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.mk-env-line.dim { color: var(--text-muted); }
.mk-env-caret {
  width: 0.45em;
  height: 0.55em;
  background: var(--accent-fg);
}
</style>
