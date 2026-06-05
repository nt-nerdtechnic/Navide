<script setup lang="ts">
import { useBackend } from './composables/useBackend'
import SearchPane from './components/SearchPane.vue'

// Electron main appends ?window=search&workspace_path=…
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''

const backend = useBackend()
</script>

<template>
  <SearchPane v-if="workspacePath" :workspace-path="workspacePath" :backend="backend" />
  <div v-else class="sw-empty">缺少 workspace 參數</div>
</template>

<style scoped>
.sw-empty {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  color: var(--text-muted);
  font-size: 13px;
}
</style>
