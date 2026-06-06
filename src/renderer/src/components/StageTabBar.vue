<script setup lang="ts">
export interface TabItem {
  key: string
  label: string
  count: number
  type: 'all' | 'stage' | 'manual'
}

defineProps<{ tabs: TabItem[]; modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <div class="stage-tab-bar" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      role="tab"
      :aria-selected="tab.key === modelValue"
      :class="['tab-btn', `tab-type-${tab.type}`, { active: tab.key === modelValue }]"
      @click="emit('update:modelValue', tab.key)"
    >
      <span class="tab-label">{{ tab.label }}</span>
      <span class="tab-count">{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.stage-tab-bar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  padding: 0 8px;
  gap: 2px;
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.stage-tab-bar::-webkit-scrollbar { display: none; }

.tab-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  border-radius: 4px 4px 0 0;
  margin-bottom: -1px; /* overlap the bar's bottom border */
}
.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.tab-btn.active {
  color: var(--accent-bright);
  border-bottom-color: var(--accent-focus);
}

.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--bg-muted);
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  transition: background 0.12s, color 0.12s;
}
.tab-btn.active .tab-count {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}
</style>
