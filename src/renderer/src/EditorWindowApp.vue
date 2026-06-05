<script setup lang="ts">
import { useBackend } from './composables/useBackend'
import EditorPane from './editor/EditorPane.vue'
import NotificationHost from './components/NotificationHost.vue'

// ── window params (Electron appends ?window=editor&workspace_path=…&filepath=…) ──
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const relPath = params.get('filepath') ?? ''
const name = params.get('name') ?? (relPath.split('/').pop() || relPath)
const initialLine = Number(params.get('line')) || 0

const backend = useBackend()
</script>

<template>
  <EditorPane
    v-if="workspacePath && relPath"
    :workspace-path="workspacePath"
    :backend="backend"
    :rel-path="relPath"
    :name="name"
    :initial-line="initialLine"
  />
  <div v-else class="ew-empty">缺少檔案參數</div>
  <NotificationHost />
</template>

<style scoped>
.ew-empty {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  color: var(--text-muted);
  font-size: 13px;
}
</style>
