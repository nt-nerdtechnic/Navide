<script setup lang="ts">
// A panel inside a dialog or a settings page: small uppercase label, slotted
// rows, an optional monospace command line and a grey note. Named MockPanel
// rather than MockCard because MockCardRow already owns the "card" word here.
//
// Boundary with MockCardRow: this is a CONTAINER (a titled section other rows
// sit inside), that one is a ROW (title, blurb, trailing button). Similar
// names, disjoint shapes — they are not candidates for merging.
//
// Mirrors CliInstallDialog.vue's `.ci-card` — `.ci-card-label`, the
// `.ci-command` block that prints the install command verbatim, and the
// `.ci-note` under it (:30-95), including the `blocked` / `failed` tones.
defineProps<{
  label?: string
  /** Monospace line under the rows — a command, a path. */
  code?: string
  note?: string
  tone?: 'warn' | 'crit'
}>()
</script>

<template>
  <div class="mk-panel" :class="tone">
    <div v-if="label" class="mk-panel-label">{{ label }}</div>
    <slot />
    <code v-if="code" class="mk-panel-code">{{ code }}</code>
    <div v-if="note" class="mk-panel-note">{{ note }}</div>
  </div>
</template>

<style scoped>
.mk-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  padding: 0.5em 0.6em;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  min-width: 0;
}
.mk-panel.warn { border-color: var(--attention-muted); background: var(--attention-subtle); }
.mk-panel.crit { border-color: var(--danger-muted); background: var(--danger-subtle); }

.mk-panel-label {
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.85em;
}
.mk-panel-code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.3em 0.5em;
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  color: var(--text-primary);
  overflow-x: auto;
  white-space: pre;
}
.mk-panel-note { color: var(--text-muted); font-size: 0.9em; line-height: 1.5; }
</style>
