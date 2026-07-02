<script setup lang="ts">
// Crash-restore prompt: shown by the first window after an unexpected exit
// (see main/window-registry.ts). Non-blocking — the user keeps full use of
// the app while deciding; apply reopens every listed workspace window and
// each window's own boot flow resumes its panes.
defineProps<{ workspaces: string[] }>()
const emit = defineEmits<{ (e: 'apply'): void; (e: 'dismiss'): void }>()

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
</script>

<template>
  <div class="restore-banner" role="alert">
    <span class="restore-text">
      {{ $t('restore.banner-text', { count: workspaces.length }) }}
    </span>
    <span class="restore-names" :title="workspaces.join('\n')">
      {{ workspaces.map(basename).join('、') }}
    </span>
    <button class="restore-btn primary" @click="emit('apply')">{{ $t('restore.apply') }}</button>
    <button class="restore-btn" @click="emit('dismiss')">{{ $t('restore.dismiss') }}</button>
  </div>
</template>

<style scoped>
.restore-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--accent-3, #1a2332);
  border-bottom: 1px solid var(--accent-6, #30363d);
  font-size: 12px;
  color: var(--gray-12, #e6edf3);
}
.restore-names {
  color: var(--gray-11, #8b949e);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.restore-btn {
  padding: 3px 12px;
  border-radius: 5px;
  border: 1px solid var(--gray-6, #30363d);
  background: transparent;
  color: var(--gray-12, #e6edf3);
  font-size: 12px;
  cursor: pointer;
}
.restore-btn.primary {
  background: var(--accent-9, #1f6feb);
  border-color: transparent;
  color: #fff;
}
.restore-btn:hover { filter: brightness(1.15); }
</style>
