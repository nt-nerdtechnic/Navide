<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'

export interface TabItem {
  key: string
  label: string
  count: number
  type: 'stage' | 'manual'
}

const props = defineProps<{ tabs: TabItem[]; modelValue: string }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'add'): void
  (e: 'rename', key: string, name: string): void
  (e: 'delete', key: string): void
  (e: 'move-pane', paneId: string, targetKey: string): void
}>()

// The ✕ shows when there are at least 2 visible tabs. Actual deletion rules
// live in App.vue because "手動" is a synthetic tab, not a persisted RunGroup.

// Drag-to-move: a pane dropped onto a tab reassigns it to that tab's run group.
const dragOverKey = ref<string | null>(null)
function onTabDrop(e: DragEvent, key: string): void {
  dragOverKey.value = null
  const paneId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (paneId) emit('move-pane', paneId, key)
}

const editingKey = ref<string | null>(null)
const editingName = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
let _cancelledRename = false

async function startRename(tab: TabItem): Promise<void> {
  if (tab.type === 'manual') return
  _cancelledRename = false
  editingKey.value = tab.key
  editingName.value = tab.label
  await nextTick()
  inputRef.value?.select()
}

function commitRename(key: string): void {
  if (_cancelledRename) return
  const name = editingName.value.trim()
  if (name) emit('rename', key, name)
  editingKey.value = null
}

function onRenameKeydown(e: KeyboardEvent, key: string): void {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(key) }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledRename = true; editingKey.value = null }
}
</script>

<template>
  <div class="stage-tab-bar" role="tablist">
    <template v-for="tab in tabs" :key="tab.key">
      <button
        role="tab"
        :aria-selected="tab.key === modelValue"
        :class="['tab-btn', `tab-type-${tab.type}`, { active: tab.key === modelValue, 'drag-over': dragOverKey === tab.key }]"
        @click="emit('update:modelValue', tab.key)"
        @dblclick.prevent="startRename(tab)"
        @dragover.prevent
        @dragenter.prevent="dragOverKey = tab.key"
        @dragleave="dragOverKey = (dragOverKey === tab.key ? null : dragOverKey)"
        @drop.prevent="onTabDrop($event, tab.key)"
      >
        <template v-if="editingKey === tab.key">
          <input
            ref="inputRef"
            class="tab-rename-input"
            v-model="editingName"
            @keydown="onRenameKeydown($event, tab.key)"
            @blur="commitRename(tab.key)"
            @click.stop
          />
        </template>
        <template v-else>
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-count">{{ tab.count }}</span>
          <span
            v-if="tab.type !== 'manual' || tabs.length > 1"
            class="tab-close"
            title="刪除此 tab（pane 會移到可承接的分組）"
            @click.stop="emit('delete', tab.key)"
          >✕</span>
        </template>
      </button>
    </template>
    <button class="tab-add-btn" title="新增 Pipeline 區塊" @click="emit('add')">+</button>
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
.tab-btn.drag-over {
  background: var(--accent-subtle);
  border-bottom-color: var(--accent-focus);
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 10px;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.tab-btn:hover .tab-close { opacity: 0.7; }
.tab-close:hover {
  opacity: 1;
  color: var(--text-primary);
  background: var(--bg-muted);
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

.tab-rename-input {
  width: 80px;
  background: var(--bg-base);
  border: 1px solid var(--accent-focus);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  padding: 0 4px;
  height: 18px;
  outline: none;
}

.tab-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 4px;
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.tab-add-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent-focus);
  background: var(--bg-hover);
}
</style>
