<script setup lang="ts">
// A modal dialog: kicker and title on the left of the header, an optional step
// rail on the right, the slotted body, and a button row along the foot.
//
// Mirrors CliInstallDialog.vue's `.ci-dialog` — `.ci-top` with `.ci-kicker`
// and `.ci-steps` (whose done steps print ✓ and the rest their number), and
// `.ci-footer` with the ghost buttons before the primary one (:1-30, :170-210).
defineProps<{
  kicker?: string
  title: string
  steps?: { label: string; state: 'done' | 'active' | 'todo' }[]
  buttons?: { label: string; primary?: boolean }[]
  mark?: string
}>()
</script>

<template>
  <div class="mk-dlg">
    <div class="mk-dlg-top">
      <div class="mk-dlg-heading">
        <div v-if="kicker" class="mk-dlg-kicker">{{ kicker }}</div>
        <div class="mk-dlg-title">{{ title }}</div>
      </div>
      <ol v-if="steps?.length" class="mk-dlg-steps">
        <li v-for="(step, i) in steps" :key="step.label" :class="step.state">
          <span class="mk-dlg-step-n">{{ step.state === 'done' ? '✓' : i + 1 }}</span>
          {{ step.label }}
        </li>
      </ol>
      <span v-if="mark" class="mk-dlg-mark">{{ mark }}</span>
    </div>
    <div class="mk-dlg-body"><slot /></div>
    <div v-if="buttons?.length" class="mk-dlg-foot">
      <span class="mk-dlg-gap" />
      <span
        v-for="button in buttons"
        :key="button.label"
        class="mk-dlg-btn"
        :class="{ primary: button.primary }"
      >{{ button.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.mk-dlg {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  box-shadow: 0 4px 16px var(--shadow-overlay);
  overflow: hidden;
}

.mk-dlg-top {
  display: flex;
  align-items: flex-start;
  gap: 0.8em;
  padding: 0.7em 0.8em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  flex-wrap: wrap;
}
.mk-dlg-heading { flex: 1 1 8em; min-width: 0; }
.mk-dlg-kicker {
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.85em;
}
.mk-dlg-title { color: var(--text-bright); font-weight: 700; font-size: 1.15em; }

.mk-dlg-steps {
  display: flex;
  gap: 0.6em;
  margin: 0;
  padding: 0;
  list-style: none;
  flex: none;
  color: var(--text-muted);
}
.mk-dlg-steps li { display: inline-flex; align-items: center; gap: 0.3em; }
.mk-dlg-steps li.active { color: var(--accent-fg); }
.mk-dlg-steps li.done { color: var(--success-fg); }
.mk-dlg-step-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35em;
  height: 1.35em;
  border-radius: 50%;
  border: 1px solid currentColor;
}
.mk-dlg-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }

.mk-dlg-body {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  padding: 0.7em 0.8em;
  background: var(--bg-base);
  min-width: 0;
}

.mk-dlg-foot {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.55em 0.8em;
  border-top: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-dlg-gap { flex: 1; }
.mk-dlg-btn {
  flex: none;
  padding: 0.2em 0.7em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  color: var(--text-primary);
  white-space: nowrap;
}
.mk-dlg-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
</style>
