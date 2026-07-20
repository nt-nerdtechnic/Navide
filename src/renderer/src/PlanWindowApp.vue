<script setup lang="ts">
// Plan review window (?window=plans&workspace_path=…): plan list on the left,
// the opened plan document on the right. Plan HTML docs render in the
// interactive srcdoc preview (PlanDocPreview, render-time injected runtime)
// with the review toolbar stacked above; other HTML docs keep the plain
// sandboxed FilePreviewPane; legacy markdown plans reuse PlanFileView.
// Plans only — no file tree, terminal, or git.
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from './composables/useBackend'
import { initSettingsBackend, onSettingsChanged } from './lib/settings'
import { useTheme } from './composables/useTheme'
import { useNotify } from './composables/useNotify'
import { replaceSectionBody, deleteSection } from './composables/usePlanHtml'
import { sanitizePlanSectionHtml } from './editor/planRuntime'
import PlansPane from './editor/PlansPane.vue'
import PlanReviewToolbar from './editor/PlanReviewToolbar.vue'
import PlanFileView from './editor/PlanFileView.vue'
import FilePreviewPane from './editor/FilePreviewPane.vue'
import PlanDocPreview from './editor/PlanDocPreview.vue'
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
const { toast, confirm } = useNotify()

const openDoc = ref<{ relPath: string; name: string } | null>(null)
// Read-only history snapshot shown instead of the live plan (Phase C); the
// snapshot preview renders without a toolbar and ignores write interactions.
const snapshotPreview = ref<{ relPath: string; label: string } | null>(null)

// Reviewable plan doc: top-level, non-infrastructure `.agent-team/plans/*.html`.
function isHtmlPlanDoc(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  if (!normalized.startsWith('.agent-team/plans/')) return false
  const name = normalized.slice('.agent-team/plans/'.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

// Bumped after a plan-meta write; PlanDocPreview reloads in place (keeping
// the reported scroll position) instead of remounting.
const planPreviewRefresh = ref(0)

const toolbarRef = ref<InstanceType<typeof PlanReviewToolbar> | null>(null)
const previewRef = ref<InstanceType<typeof PlanDocPreview> | null>(null)
const plansPaneRef = ref<InstanceType<typeof PlansPane> | null>(null)

function onOpenFile(payload: { filepath: string; name: string }): void {
  openDoc.value = { relPath: payload.filepath, name: payload.name }
  snapshotPreview.value = null
}

function onPreviewSnapshot(payload: { relPath: string; label: string }): void {
  snapshotPreview.value = payload
}

function closeSnapshotPreview(): void {
  snapshotPreview.value = null
}

// file:line references clicked inside the plan document (validated by the
// runtime protocol) open the editor window at that line.
type AgentApi = { openEditorWindow?: (a: Record<string, unknown>) => Promise<unknown> }
function onOpenCode(payload: { path: string; line: number }): void {
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  void api.openEditorWindow({
    workspace_path: workspacePath,
    filepath: payload.path,
    line: payload.line,
  })
}

// In-document interactions, already validated by PlanDocPreview against the
// whitelist protocol, are routed through the toolbar's existing write paths.
function onDocTodoClicked(payload: { todoId: string; alt: boolean }): void {
  const toolbar = toolbarRef.value
  if (!toolbar) return
  if (payload.alt) void toolbar.toggleSkipTodo(payload.todoId)
  else void toolbar.cycleTodo(payload.todoId)
}

function onDocSectionComment(anchor: string): void {
  toolbarRef.value?.startNoteWithAnchor(anchor)
}

function onOutlineScroll(anchor: string): void {
  previewRef.value?.scrollToAnchor(anchor)
}

// Body write-back for inline section edit/delete. Mirrors the toolbar's
// optimistic lock: re-read fresh content + mtime, apply the byte-surgical
// mutation to the fresh bytes (preserving concurrent agent edits), write with
// expected_mtime, retry once on a conflict. A mutation that leaves the content
// unchanged (anchor gone / refused region) is a silent no-op.
async function writePlanBody(mutate: (fresh: string) => string): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  for (let attempt = 0; attempt < 2; attempt++) {
    const readResp = await backend.send<{ ok: boolean; content?: string; mtime?: number; error?: string }>(
      'fs.read_file',
      { workspace_path: workspacePath, rel_path: relPath },
    )
    if (!readResp.payload?.ok || readResp.payload.content === undefined) {
      toast(readResp.payload?.error ?? t('pane.plans.review-save-failed'))
      return
    }
    const fresh = readResp.payload.content
    const expectedMtime = readResp.payload.mtime
    const next = mutate(fresh)
    if (next === fresh) return // no-op: anchor not found or region refused
    const resp = await backend.send<{ ok: boolean; conflict?: boolean; error?: string }>('fs.write_file', {
      workspace_path: workspacePath,
      rel_path: relPath,
      content: next,
      ...(typeof expectedMtime === 'number' ? { expected_mtime: expectedMtime } : {}),
    })
    if (resp.payload?.ok) {
      planPreviewRefresh.value++
      return
    }
    if (resp.payload?.conflict) {
      if (attempt === 0) continue // re-read and retry once
      toast(t('pane.plans.review-save-failed'))
      return
    }
    toast(resp.payload?.error ?? t('pane.plans.review-save-failed'))
    return
  }
}

// Inline section edit: sanitize the untrusted frame HTML host-side, then
// replace only that section's prose body (never plan-meta/header/todos).
async function onSectionEdit(payload: { anchor: string; html: string }): Promise<void> {
  const sanitized = sanitizePlanSectionHtml(payload.html)
  await writePlanBody((fresh) => replaceSectionBody(fresh, payload.anchor, sanitized))
}

async function onSectionDelete(anchor: string): Promise<void> {
  const ok = await confirm(t('pane.plans.doc-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  await writePlanBody((fresh) => deleteSection(fresh, anchor))
}

// ESC overlay priority: cancel/close the innermost active overlay before
// falling through to closing the window. Order: an in-frame section edit
// (when focus is outside the frame — inside it the runtime handles ESC
// itself), then the plan list's context menu / rename input, then an unsent
// review note, then a read-only snapshot; otherwise close the window.
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (previewRef.value?.isEditing?.()) {
    previewRef.value.cancelEdit()
    event.preventDefault()
    return
  }
  if (plansPaneRef.value?.closeActiveOverlay?.()) {
    event.preventDefault()
    return
  }
  if (toolbarRef.value?.closeActiveOverlay?.()) {
    event.preventDefault()
    return
  }
  if (snapshotPreview.value) {
    closeSnapshotPreview()
    event.preventDefault()
    return
  }
  event.preventDefault()
  window.close()
}

let offThemeSettingsChange: (() => void) | null = null
let offPlansChanged: (() => void) | null = null

onMounted(() => {
  document.title = `Plans · ${workspaceBaseName}`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
  })
  // Live refresh: a plan changed on disk (any writer) — reload the open
  // preview in place so the scroll position is preserved.
  offPlansChanged = backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    if (p && p.workspace_path === workspacePath) planPreviewRefresh.value++
  })
  window.addEventListener('keydown', onWindowKeydown)
})
onUnmounted(() => {
  offThemeSettingsChange?.()
  offPlansChanged?.()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="plan-window">
    <aside class="plan-window-side">
      <PlansPane ref="plansPaneRef" :workspace-path="workspacePath" :backend="backend" @open-file="onOpenFile" />
    </aside>
    <main class="plan-window-main">
      <template v-if="openDoc">
        <div v-if="openDoc.relPath.endsWith('.html')" class="plan-window-doc">
          <template v-if="isHtmlPlanDoc(openDoc.relPath)">
            <!-- Read-only snapshot view: no toolbar, write interactions ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanDocPreview
                :key="snapshotPreview.relPath"
                :workspace-path="workspacePath"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :refresh="0"
                @open-code="onOpenCode"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
              />
              <PlanDocPreview
                ref="previewRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @todo-clicked="onDocTodoClicked"
                @section-comment="onDocSectionComment"
                @section-edit="onSectionEdit"
                @section-delete="onSectionDelete"
                @open-code="onOpenCode"
              />
            </template>
          </template>
          <FilePreviewPane
            v-else
            :key="openDoc.relPath"
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

.plan-snapshot-banner {
  align-items: center;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  flex-shrink: 0;
  font-size: 12px;
  gap: 10px;
  padding: 6px 12px;
}

.plan-snapshot-label {
  font-weight: 650;
}

.plan-snapshot-note {
  color: var(--text-muted);
  flex: 1;
  font-size: 11px;
}

.plan-snapshot-close {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11px;
  padding: 3px 10px;
}

.plan-snapshot-close:hover {
  background: var(--bg-hover-strong);
}

.plan-window-empty {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: 13px;
  justify-content: center;
}
</style>
