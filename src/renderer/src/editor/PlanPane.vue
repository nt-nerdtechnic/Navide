<script setup lang="ts">
// Embedded plan review pane (main-window Plans tab): plan list on the left,
// the opened plan document on the right. Extracted from PlanWindowApp.vue so
// the same review surface renders inside the main window's stage area instead
// of a detached window. Plan docs stack the shared review toolbar
// (PlanReviewToolbar, format-agnostic via PlanStore) above a body that switches
// on format: HTML plans render in the interactive srcdoc preview
// (PlanDocPreview, render-time injected runtime); markdown plans render in
// PlanMarkdownBody. Other HTML docs keep the plain sandboxed FilePreviewPane;
// plain markdown (no frontmatter meta) falls back to the read-only PlanFileView.
// Workspace + backend arrive as props from App.vue; theme/settings are already
// wired by the host window, so this pane owns none of that lifecycle.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from '../composables/useBackend'
import { useNotify } from '../composables/useNotify'
import { resolvePlanStore, type PlanCtx, type WriteResult } from '../composables/planStore'
import { sanitizePlanSectionHtml } from './planRuntime'
import PlansPane from './PlansPane.vue'
import PlanReviewToolbar from './PlanReviewToolbar.vue'
import PlanFileView from './PlanFileView.vue'
import PlanMarkdownBody from './PlanMarkdownBody.vue'
import FilePreviewPane from './FilePreviewPane.vue'
import PlanDocPreview from './PlanDocPreview.vue'

const { workspacePath, backend } = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
}>()

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

// Format-agnostic persistence adapter for the open doc; the review toolbar and
// the body write-back below both go through it instead of the backend directly.
// `.html` plans resolve to the HTML store (the only branch that mounts the
// toolbar / interactive preview in this stage).
const planStore = computed(() => resolvePlanStore(openDoc.value?.relPath ?? ''))

const toolbarRef = ref<InstanceType<typeof PlanReviewToolbar> | null>(null)
const previewRef = ref<InstanceType<typeof PlanDocPreview> | null>(null)
const mdBodyRef = ref<InstanceType<typeof PlanMarkdownBody> | null>(null)
const plansPaneRef = ref<InstanceType<typeof PlansPane> | null>(null)

// For an open markdown doc: 'loading' while probing frontmatter, then 'plan'
// (carries valid plan meta → shared review toolbar + PlanMarkdownBody) or 'doc'
// (plain markdown with no meta → legacy read-only PlanFileView, no toolbar).
// HTML docs route by path (isHtmlPlanDoc) and never consult this.
const mdKind = ref<'loading' | 'plan' | 'doc'>('loading')

function isMarkdownDoc(relPath: string): boolean {
  return !relPath.endsWith('.html')
}

// Probe the markdown doc's meta once per open: a valid frontmatter plan mounts
// the toolbar, a plain markdown file stays a read-only doc. Re-probing is not
// needed on live refresh — a plain .md does not gain frontmatter from in-window
// actions, and legacy .plan.md already carry frontmatter from the first read.
async function probeMarkdownKind(relPath: string): Promise<void> {
  mdKind.value = 'loading'
  const result = await resolvePlanStore(relPath).readMeta(planCtx(relPath))
  if (openDoc.value?.relPath !== relPath) return // superseded by a newer open
  mdKind.value = result ? 'plan' : 'doc'
}

function onOpenFile(payload: { filepath: string; name: string }): void {
  openDoc.value = { relPath: payload.filepath, name: payload.name }
  snapshotPreview.value = null
  if (isMarkdownDoc(payload.filepath)) void probeMarkdownKind(payload.filepath)
}

// A plan deleted from the list clears the right pane when it's the open one.
function onPlanDeleted(relPath: string): void {
  if (openDoc.value?.relPath === relPath) {
    openDoc.value = null
    snapshotPreview.value = null
  }
}

function onPreviewSnapshot(payload: { relPath: string; label: string }): void {
  snapshotPreview.value = payload
}

function closeSnapshotPreview(): void {
  snapshotPreview.value = null
}

// Drill-down "back": leave the doc preview and return to the plan list. Clears
// any active snapshot too so re-opening the doc starts on the live plan.
function backToList(): void {
  openDoc.value = null
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

// Only one body is mounted per doc (HTML preview or markdown body); scrolling
// the null one is a no-op, so route the toolbar's outline pick to both.
function onOutlineScroll(anchor: string): void {
  previewRef.value?.scrollToAnchor(anchor)
  mdBodyRef.value?.scrollToAnchor(anchor)
}

// Body write-back for inline section edit/delete now goes through the store's
// replaceSectionBody / deleteSection, which mirror the toolbar's optimistic
// lock (re-read fresh content + mtime, apply the byte-surgical mutation to the
// fresh bytes preserving concurrent agent edits, write with expected_mtime,
// retry once on a conflict; a mutation that leaves the content unchanged is a
// silent no-op success). The host still sanitizes untrusted frame HTML first.
function planCtx(relPath: string): PlanCtx {
  return { backend, workspacePath, relPath }
}

function applyBodyWriteResult(result: WriteResult): void {
  if (result.ok) {
    planPreviewRefresh.value++
    return
  }
  if (result.conflict) {
    toast(t('pane.plans.review-save-failed'))
    return
  }
  toast(result.error ?? t('pane.plans.review-save-failed'))
}

// Inline section edit: sanitize the untrusted frame HTML host-side, then
// replace only that section's prose body (never plan-meta/header/todos).
async function onSectionEdit(payload: { anchor: string; html: string }): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const sanitized = sanitizePlanSectionHtml(payload.html)
  const result = await planStore.value.replaceSectionBody(planCtx(relPath), payload.anchor, {
    kind: 'html',
    sanitized,
  })
  applyBodyWriteResult(result)
}

async function onSectionDelete(anchor: string): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const ok = await confirm(t('pane.plans.doc-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  const result = await planStore.value.deleteSection(planCtx(relPath), anchor)
  applyBodyWriteResult(result)
}

// ESC priority in the narrow drill-down: cancel/close the innermost active
// overlay first, then fall back to leaving the doc preview for the plan list.
// Order: an in-frame section edit (when focus is outside the frame — inside it
// the runtime handles ESC itself), then the plan list's context menu / rename
// input, then an unsent review note, then a read-only snapshot, then the
// drill-down back to the list. This handler only ever acts on Escape and never
// touches Cmd+number, so it does not fight ControlPane's Cmd+1/2/3/4 sidebar-tab
// shortcuts. It never closes a window — this is an embedded pane.
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (previewRef.value?.isEditing?.()) {
    previewRef.value.cancelEdit()
    event.preventDefault()
    return
  }
  // Markdown body's inline section edit — same priority as the HTML preview's
  // in-frame edit (only one body is ever mounted).
  if (mdBodyRef.value?.isEditing?.()) {
    mdBodyRef.value.cancelEdit()
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
  // No overlay left: drill back up to the plan list.
  if (openDoc.value) {
    backToList()
    event.preventDefault()
  }
}

let offPlansChanged: (() => void) | null = null

onMounted(() => {
  // Live refresh: a plan changed on disk (any writer) — reload the open
  // preview in place so the scroll position is preserved.
  offPlansChanged = backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    if (p && p.workspace_path === workspacePath) planPreviewRefresh.value++
  })
  window.addEventListener('keydown', onWindowKeydown)
})
onUnmounted(() => {
  offPlansChanged?.()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="plan-pane">
    <!-- List view: fills the narrow sidebar; kept mounted (v-show) so returning
         from a plan is instant and preserves the list's scroll/selection. -->
    <PlansPane
      v-show="!openDoc"
      ref="plansPaneRef"
      class="plan-pane-list"
      :workspace-path="workspacePath"
      :backend="backend"
      @open-file="onOpenFile"
      @deleted="onPlanDeleted"
    />
    <!-- Doc view: a "back to list" header above the opened plan (drill-down).
         The plan body is the same format-branched stack as the window variant. -->
    <div v-if="openDoc" class="plan-pane-doc-view">
      <div class="plan-pane-back-bar">
        <button class="plan-pane-back" @click="backToList">← {{ t('pane.plans.back-to-list') }}</button>
        <span class="plan-pane-doc-name" :title="openDoc.name">{{ openDoc.name }}</span>
      </div>
      <div class="plan-pane-doc-body">
        <div v-if="openDoc.relPath.endsWith('.html')" class="plan-pane-doc">
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
                :store="planStore"
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
        <!-- Markdown plan: the shared review toolbar + PlanMarkdownBody when the
             file carries valid frontmatter meta; plain markdown (no meta) keeps
             the legacy read-only PlanFileView with no meta-driven toolbar. -->
        <template v-else>
          <div v-if="mdKind === 'plan'" class="plan-pane-doc">
            <!-- Read-only markdown snapshot view: no toolbar, edits ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanFileView
                :key="snapshotPreview.relPath"
                :workspace-path="workspacePath"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :readonly="true"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :store="planStore"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
              />
              <PlanMarkdownBody
                ref="mdBodyRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @updated="planPreviewRefresh++"
              />
            </template>
          </div>
          <PlanFileView
            v-else-if="mdKind === 'doc'"
            :key="openDoc.relPath"
            :workspace-path="workspacePath"
            :rel-path="openDoc.relPath"
            :backend="backend"
          />
          <div v-else class="plan-pane-doc" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-pane {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Both the list and the doc view fill the pane (only one is visible at a time). */
.plan-pane-list,
.plan-pane-doc-view {
  flex: 1 1 0;
  min-height: 0;
}

.plan-pane-doc-view {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.plan-pane-back-bar {
  align-items: center;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 6px 10px;
}

.plan-pane-back {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 10px;
}

.plan-pane-back:hover {
  background: var(--bg-hover-strong);
}

.plan-pane-doc-name {
  color: var(--text-muted);
  flex: 1;
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-pane-doc-body {
  flex: 1 1 0;
  min-height: 0;
}

/* The doc body's single child (doc stack, markdown view) fills it. */
.plan-pane-doc-body > * {
  height: 100%;
}

.plan-pane-doc {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Same stretch rule as the editor's .ide-preview-stack: the preview pane
   (last child, below the optional toolbar) takes all remaining height. */
.plan-pane-doc > :last-child {
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
