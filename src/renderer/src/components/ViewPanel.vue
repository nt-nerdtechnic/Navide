<script setup lang="ts">
export type LayoutMode = 'auto' | 'grid' | 'spotlight' | 'fullscreen'

defineProps<{ modelValue: LayoutMode }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: LayoutMode): void }>()

const modes: [LayoutMode, string, string][] = [
  ['grid',       '⊞', 'Grid'],
  ['auto',       '✦', 'Auto (dynamic)'],
  ['spotlight',  '◎', 'Spotlight'],
  ['fullscreen', '⧉', 'Fullscreen + floating panel'],
]
</script>

<template>
  <div class="view-panel" role="toolbar" aria-label="View mode">
    <button
      v-for="[mode, icon, label] in modes"
      :key="mode"
      :class="['mode-btn', { active: modelValue === mode }]"
      :title="label"
      :aria-pressed="modelValue === mode"
      @click="emit('update:modelValue', mode)"
    >{{ icon }}</button>
  </div>
</template>

<style scoped>
.view-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: flex;
  gap: 2px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 3px;
  backdrop-filter: blur(4px);
}
.mode-btn {
  width: 28px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s, color 0.1s;
}
.mode-btn:hover {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.mode-btn.active {
  background: #1f6feb33;
  color: var(--accent-bright);
}
</style>
