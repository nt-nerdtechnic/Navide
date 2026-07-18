<script setup lang="ts">
// Plan review window (?window=plans&workspace_path=…): plan list on the left,
// the opened plan document on the right. HTML plans render in the existing
// sandboxed preview (FilePreviewPane) with the review toolbar stacked above;
// legacy markdown plans reuse PlanFileView. Plans only — no file tree,
// terminal, or git.
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from './composables/useBackend'
import { initSettingsBackend, onSettingsChanged } from './lib/settings'
import { useTheme } from './composables/useTheme'
import PlansPane from './editor/PlansPane.vue'
import PlanReviewToolbar from './editor/PlanReviewToolbar.vue'
import PlanFileView from './editor/PlanFileView.vue'
import FilePreviewPane from './editor/FilePreviewPane.vue'
import NotificationHost from './components/NotificationHost.vue'

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const workspaceBaseName = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath

const backend = useBackend()
// Hook the settings cache to this window's own ws connection so theme changes
// made in other windows arrive as ui.settings_changed broadcasts.
initSettingsBackend(backend)
const { loadTheme } = useTheme()
const { t } = useI18n()

const openDoc = ref<{ relPath: string; name: string } | null>(null)

// Reviewable plan doc: top-level, non-infrastructure `.agent-team/plans/*.html`.
function isHtmlPlanDoc(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  if (!normalized.startsWith('.agent-team/plans/')) return false
  const name = normalized.slice('.agent-team/plans/'.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

// Bumped after a plan-meta write so the sandboxed preview iframe remounts.
const planPreviewRefresh = ref(0)

function onOpenFile(payload: { filepath: string; name: string }): void {
  openDoc.value = { relPath: payload.filepath, name: payload.name }
}

let offThemeSettingsChange: (() => void) | null = null

onMounted(() => {
  document.title = `Plans · ${workspaceBaseName}`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
  })
})
onUnmounted(() => {
  offThemeSettingsChange?.()
})
</script>

<template>
  <div class="plan-window">
    <aside class="plan-window-side">
      <PlansPane :workspace-path="workspacePath" :backend="backend" @open-file="onOpenFile" />
    </aside>
    <main class="plan-window-main">
      <template v-if="openDoc">
        <div v-if="openDoc.relPath.endsWith('.html')" class="plan-window-doc">
          <PlanReviewToolbar
            v-if="isHtmlPlanDoc(openDoc.relPath)"
            :workspace-path="workspacePath"
            :rel-path="openDoc.relPath"
            :backend="backend"
            @updated="planPreviewRefresh++"
          />
          <FilePreviewPane
            :key="openDoc.relPath + ':' + planPreviewRefresh"
            :workspace-path="workspacePath"
            :rel-path="openDoc.relPath"
            :name="openDoc.name"
            :backend="backend"
          />
        </div>
        <PlanFileView
          v-else
          :key="openDoc.relPath"
          :workspace-path="workspacePath"
          :rel-path="openDoc.relPath"
          :backend="backend"
        />
      </template>
      <div v-else class="plan-window-empty">{{ t('pane.plans.window-empty') }}</div>
    </main>
    <NotificationHost />
  </div>
</template>

<style scoped>
.plan-window {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.plan-window-side {
  border-right: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow: hidden;
  width: 300px;
}

.plan-window-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Every direct child (doc stack, markdown view, empty state) fills the pane. */
.plan-window-main > * {
  flex: 1 1 0;
  min-height: 0;
}

.plan-window-doc {
  display: flex;
  flex-direction: column;
}

/* Same stretch rule as the editor's .ide-preview-stack: the preview pane
   (last child, below the optional toolbar) takes all remaining height. */
.plan-window-doc > :last-child {
  flex: 1 1 0;
  min-height: 0;
}

.plan-window-empty {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: 13px;
  justify-content: center;
}
</style>
