<script setup lang="ts">
import { computed } from 'vue'
import type { OnboardDep } from '../composables/useOnboarding'

const props = defineProps<{ dep: OnboardDep; installing: string }>()
const emit = defineEmits<{ (e: 'install'): void }>()

const icon = computed(() =>
  props.dep.status === 'ok' ? '✓' : props.dep.status === 'outdated' ? '!' : '○'
)
const btnLabel = computed(() =>
  props.installing === props.dep.id
    ? '安裝中…'
    : props.dep.needs_terminal
      ? '在終端機安裝'
      : '安裝'
)
</script>

<template>
  <div class="ob-dep" :class="`st-${dep.status}`">
    <span class="ob-dep-icon">{{ icon }}</span>
    <div class="ob-dep-info">
      <div class="ob-dep-name">
        {{ dep.label }}
        <span v-if="dep.optional" class="ob-dep-opt">選用</span>
        <span v-if="dep.version" class="ob-dep-ver">{{ dep.version }}</span>
        <span v-if="dep.status === 'outdated'" class="ob-dep-warn">需 ≥ {{ dep.min_version }}</span>
      </div>
      <div class="ob-dep-desc">{{ dep.description }}</div>
    </div>
    <button
      v-if="dep.status !== 'ok' && dep.can_install"
      class="ob-btn small"
      :disabled="!!installing"
      @click="emit('install')"
    >{{ btnLabel }}</button>
  </div>
</template>

<style scoped>
.ob-dep {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  margin-bottom: 8px;
}
.ob-dep-icon {
  width: 22px; height: 22px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; font-size: 12px; font-weight: 700;
  background: var(--bg-muted); color: var(--text-muted);
}
.ob-dep.st-ok .ob-dep-icon { background: var(--success-subtle); color: var(--success-fg); }
.ob-dep.st-outdated .ob-dep-icon { background: var(--attention-subtle); color: var(--attention-fg); }
.ob-dep-info { flex: 1; min-width: 0; }
.ob-dep-name { font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.ob-dep-ver { font-size: 10.5px; color: var(--text-muted); font-family: ui-monospace, monospace; }
.ob-dep-opt { font-size: 9.5px; color: var(--text-muted); border: 1px solid var(--border-default); border-radius: 3px; padding: 0 4px; }
.ob-dep-warn { font-size: 10px; color: var(--attention-fg); }
.ob-dep-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.ob-btn.small {
  font-size: 11px; padding: 4px 10px;
  border: 1px solid var(--border-default); border-radius: 5px;
  background: transparent; color: var(--text-secondary); cursor: pointer; flex-shrink: 0;
}
.ob-btn.small:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ob-btn.small:disabled { opacity: 0.5; }
</style>
