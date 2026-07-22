<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { parsePlanMeta, writePlanMeta } from '../composables/usePlanFile'
import { resolvePlanStore } from '../composables/planStore'
import type { PlanMeta } from '../composables/planModel'
import {
  htmlPlanProgress,
  injectPlanMeta,
  parseHtmlPlanMeta,
  type HtmlPlanMeta,
  type PlanStage,
} from '../composables/usePlanHtml'
import { sharePlanToGit } from '../composables/planShare'
import { useNotify } from '../composables/useNotify'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
}>()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; name: string }): void
  (e: 'deleted', relPath: string): void
}>()

interface FsEntry {
  name: string
  rel_path: string
  is_dir: boolean
}

// `meta` carries the unified plan model for BOTH formats: HTML plans parse
// their `plan-meta` island, markdown plans parse their YAML frontmatter
// (`resolvePlanStore(relPath).parseMeta`). It is null for files with no valid
// plan meta of their format — those are listed as plain docs (badge 'doc', no
// progress, no stage group), the same treatment for markdown and HTML.
interface PlanItem {
  relPath: string
  name: string
  meta: PlanMeta | null
}

const { t } = useI18n()
const { toast, confirm } = useNotify()
const loading = ref(false)
const waitingForBackend = ref(false)
const error = ref('')
const plans = ref<PlanItem[]>([])

async function loadPlans(): Promise<void> {
  if (!props.workspacePath) return
  if (props.backend.status?.value && props.backend.status.value !== 'connected') {
    waitingForBackend.value = true
    loading.value = true
    error.value = ''
    return
  }

  waitingForBackend.value = false
  loading.value = true
  error.value = ''
  try {
    const loaded: PlanItem[] = []

    // Legacy markdown plans: .cursor/plans/*.plan.md
    const list = await props.backend.send<{ ok: boolean; entries?: FsEntry[]; error?: string }>('fs.list_dir', {
      workspace_path: props.workspacePath,
      rel_path: '.cursor/plans',
      show_hidden: true,
    })
    if (!list.payload?.ok) {
      error.value = list.payload?.error === 'not a directory'
        ? ''
        : (list.payload?.error || 'Failed to list plans')
    } else {
      const entries = (list.payload.entries ?? [])
        .filter((entry) => !entry.is_dir && entry.name.endsWith('.plan.md'))
        .sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        const read = await props.backend.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: entry.rel_path,
        })
        if (!read.payload?.ok) continue
        loaded.push({
          relPath: entry.rel_path,
          name: entry.name,
          meta: resolvePlanStore(entry.rel_path).parseMeta(read.payload.content ?? ''),
        })
      }
    }

    // HTML plans: .agent-team/plans/*.html (underscore-prefixed files are
    // infrastructure — spec/template — never listed). Missing directory is
    // simply an empty set, no error surfaced.
    const htmlList = await props.backend.send<{ ok: boolean; entries?: FsEntry[]; error?: string }>('fs.list_dir', {
      workspace_path: props.workspacePath,
      rel_path: '.agent-team/plans',
      show_hidden: true,
    })
    if (!htmlList.payload?.ok) {
      // Missing directory is intentional silence; real errors surface.
      if (htmlList.payload?.error !== 'not a directory') {
        error.value = htmlList.payload?.error || 'Failed to list plans'
      }
    } else {
      const htmlEntries = (htmlList.payload.entries ?? [])
        .filter(
          (entry) =>
            !entry.is_dir &&
            entry.name.endsWith('.html') &&
            !entry.name.startsWith('_') &&
            !entry.name.startsWith('.'),
        )
        .sort((a, b) => a.name.localeCompare(b.name))

      const htmlItems = await Promise.all(
        htmlEntries.map(async (entry): Promise<PlanItem | null> => {
          const read = await props.backend.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', {
            workspace_path: props.workspacePath,
            rel_path: entry.rel_path,
          })
          if (!read.payload?.ok) return null
          return {
            relPath: entry.rel_path,
            name: entry.name,
            meta: resolvePlanStore(entry.rel_path).parseMeta(read.payload.content ?? ''),
          }
        })
      )
      loaded.push(...htmlItems.filter((item): item is PlanItem => item !== null))
    }

    plans.value = loaded
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load plans'
  } finally {
    loading.value = false
  }
}

// Backend broadcasts plans.changed when any plan document under
// .agent-team/plans changes on disk (own writes or external agents).
let offPlansChanged: (() => void) | null = null
onMounted(() => {
  void loadPlans()
  offPlansChanged = props.backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    if (p && p.workspace_path === props.workspacePath) void loadPlans()
  })
})
onUnmounted(() => {
  offPlansChanged?.()
  offPlansChanged = null
})
watch(() => props.workspacePath, () => void loadPlans())
watch(() => props.backend.status?.value, (status) => {
  if (status === 'connected' && waitingForBackend.value) void loadPlans()
})

// Files without valid plan meta (markdown or HTML) are plain docs — listed
// under Active with a 'doc' badge, no progress, never stage-grouped.
const docItems = computed(() => plans.value.filter((p) => !p.meta))

interface PlanStageRow {
  item: PlanItem
  meta: PlanMeta
  done: number
  total: number
}

// Both formats group by `meta.stage`; progress uses `htmlPlanProgress`
// (skipped counts toward neither done nor total-done), consistent across
// markdown and HTML.
function stageRows(stages: PlanStage[]): PlanStageRow[] {
  return plans.value.flatMap((p) => {
    if (!p.meta || !stages.includes(p.meta.stage)) return []
    const progress = htmlPlanProgress(p.meta.todos)
    return [{ item: p, meta: p.meta, done: progress.done, total: progress.total }]
  })
}

const stageGroups = computed(() =>
  (
    [
      { key: 'draft', label: t('pane.plans.stage-draft'), stages: ['draft'], finished: false },
      { key: 'in-review', label: t('pane.plans.stage-in-review'), stages: ['in-review'], finished: false },
      { key: 'approved', label: t('pane.plans.stage-approved'), stages: ['approved'], finished: false },
      { key: 'in-progress', label: t('pane.plans.stage-in-progress'), stages: ['in-progress'], finished: false },
      { key: 'done', label: t('pane.plans.stage-done'), stages: ['done'], finished: true },
      { key: 'abandoned', label: t('pane.plans.stage-abandoned'), stages: ['abandoned'], finished: true },
    ] as { key: string; label: string; stages: PlanStage[]; finished: boolean }[]
  )
    .map((group) => ({ ...group, rows: stageRows(group.stages) }))
    .filter((group) => group.rows.length > 0)
)

// Batch-deletable = finished stages (done/abandoned), markdown and HTML alike.
const deletablePlans = computed(() =>
  plans.value.filter((p) => p.meta && (p.meta.stage === 'done' || p.meta.stage === 'abandoned'))
)

function openPlan(item: PlanItem): void {
  emit('open-file', { filepath: item.relPath, name: item.name })
}

async function deleteCompleted(): Promise<void> {
  if (!deletablePlans.value.length) return
  const ok = await confirm(`Delete ${deletablePlans.value.length} completed plan(s)?`, {
    title: 'Delete Completed Plans',
    confirmText: 'Delete',
  })
  if (!ok) return

  let deleted = 0
  for (const item of deletablePlans.value) {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.delete', {
      workspace_path: props.workspacePath,
      rel_path: item.relPath,
    })
    if (resp.payload?.ok) deleted++
    else toast(resp.payload?.error || `Failed to delete ${item.name}`, { type: 'error' })
  }
  toast(`Deleted ${deleted} completed plan(s)`, { type: 'success' })
  await loadPlans()
}

// ── Context menu ──────────────────────────────────────────────────────────
// Opens for HTML items (plans and docs) and for meta-less markdown docs (so
// they can be promoted). Legacy markdown plans (with meta) stay frozen.
// Backdrop + absolutely-positioned menu, following the GitPane convention.
const ctxMenu = ref<{ show: boolean; x: number; y: number; item: PlanItem | null }>({
  show: false,
  x: 0,
  y: 0,
  item: null,
})

function isHtmlItem(item: PlanItem): boolean {
  return item.name.endsWith('.html')
}

function openCtxMenu(e: MouseEvent, item: PlanItem): void {
  // Frozen: legacy markdown plans (non-HTML with meta) get no menu.
  if (!isHtmlItem(item) && item.meta) return
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 220)
  ctxMenu.value = { show: true, x, y, item }
}

function closeCtxMenu(): void {
  ctxMenu.value = { ...ctxMenu.value, show: false, item: null }
}

function ctxOpen(): void {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (item) openPlan(item)
}

async function ctxShareToGit(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  const result = await sharePlanToGit(props.backend, props.workspacePath, item.relPath)
  if (result.ok) toast(t('pane.plans.share-git-success'), { type: 'success' })
  else toast(result.error ?? t('pane.plans.share-git-failed'), { type: 'error' })
}

// ── Rename (keeps the `<kebab-slug>_<6-hex>.html` naming contract) ────────
const PLAN_FILENAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*_[0-9a-f]{6}\.html$/
const renameTarget = ref<PlanItem | null>(null)
const renameValue = ref('')

function ctxRename(): void {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  renameTarget.value = item
  renameValue.value = item.name
}

function cancelRename(): void {
  renameTarget.value = null
  renameValue.value = ''
}

// ESC overlay support (queried by PlanWindowApp): close the topmost open
// overlay — the context menu first, then the rename dialog. Returns whether
// one was actually closed so the host knows to stop there.
function closeActiveOverlay(): boolean {
  if (ctxMenu.value.show) {
    closeCtxMenu()
    return true
  }
  if (renameTarget.value) {
    cancelRename()
    return true
  }
  return false
}

defineExpose({ closeActiveOverlay })

async function submitRename(): Promise<void> {
  const item = renameTarget.value
  if (!item) return
  const newName = renameValue.value.trim()
  if (newName === item.name) {
    cancelRename()
    return
  }
  if (!PLAN_FILENAME_RE.test(newName)) {
    toast(t('pane.plans.rename-invalid'), { type: 'error' })
    return
  }
  const dir = item.relPath.slice(0, item.relPath.lastIndexOf('/'))
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.rename', {
    workspace_path: props.workspacePath,
    src_path: item.relPath,
    dst_path: `${dir}/${newName}`,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.rename-failed'), { type: 'error' })
    return
  }
  cancelRename()
  await loadPlans()
}

// Guard against IME composition: Enter committing a candidate must not submit.
function onRenameEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitRename()
}

// ── Delete single (in-review/approved plans need a second confirmation) ───
// Shared by the context menu and the always-visible per-row delete button.
async function deletePlan(item: PlanItem): Promise<void> {
  const ok = await confirm(t('pane.plans.delete-confirm', { name: item.meta?.name ?? item.name }), {
    title: t('pane.plans.menu-delete'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return
  const stage = item.meta?.stage
  if (stage === 'in-review' || stage === 'approved') {
    const ok2 = await confirm(t('pane.plans.delete-confirm-review', { stage }), {
      title: t('pane.plans.menu-delete'),
      confirmText: t('pane.plans.menu-delete'),
    })
    if (!ok2) return
  }
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.delete', {
    workspace_path: props.workspacePath,
    rel_path: item.relPath,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.delete-failed'), { type: 'error' })
    return
  }
  emit('deleted', item.relPath)
  await loadPlans()
}

async function ctxDelete(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (item) await deletePlan(item)
}

// ── Promote doc → plan ────────────────────────────────────────────────────
// HTML docs get a `plan-meta` island injected; markdown docs get a YAML
// frontmatter block prepended (body preserved byte-for-byte). Both start at
// `stage: draft` with empty todos/reviewNotes.

/** First non-heading paragraph of a markdown doc, whitespace-collapsed, or ''. */
function firstMarkdownParagraph(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const text = block.trim()
    if (!text || text.startsWith('#')) continue
    return text.replace(/\s+/g, ' ')
  }
  return ''
}

/** Build the upgraded content for a doc, or null when it is already a plan. */
function upgradedContent(relPath: string, name: string, content: string): string | null {
  if (relPath.endsWith('.html')) {
    if (parseHtmlPlanMeta(content)) return null // already a plan
    const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim()
    const meta: HtmlPlanMeta = {
      schemaVersion: 1,
      name: title || name,
      overview: '',
      stage: 'draft',
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    }
    return injectPlanMeta(content, meta)
  }
  // Markdown doc: prepend frontmatter, keeping the original body verbatim.
  if (parsePlanMeta(content)) return null // already has frontmatter
  const title = content.match(/^#\s+(.+)$/m)?.[1].trim() || name.replace(/\.(?:plan\.md|md)$/, '')
  const meta: PlanMeta = {
    schemaVersion: 1,
    format: 'markdown',
    name: title,
    overview: firstMarkdownParagraph(content),
    stage: 'draft',
    approvedAt: null,
    todos: [],
    reviewNotes: [],
    isProject: false,
  }
  // writePlanMeta needs an existing frontmatter block; a synthetic empty one
  // makes it serialize our meta and keep `content` as the preserved body.
  return writePlanMeta(meta, `---\n---\n${content}`)
}

async function ctxUpgradeToPlan(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  const read = await props.backend.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', {
    workspace_path: props.workspacePath,
    rel_path: item.relPath,
  })
  if (!read.payload?.ok || read.payload.content === undefined) {
    toast(read.payload?.error ?? t('pane.plans.upgrade-failed'), { type: 'error' })
    return
  }
  const next = upgradedContent(item.relPath, item.name, read.payload.content)
  if (next === null) {
    // Already a plan (e.g. promoted externally since the last refresh).
    await loadPlans()
    return
  }
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
    workspace_path: props.workspacePath,
    rel_path: item.relPath,
    content: next,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.upgrade-failed'), { type: 'error' })
    return
  }
  toast(t('pane.plans.upgrade-success'), { type: 'success' })
  await loadPlans()
}
</script>

<template>
  <div class="plans-pane">
    <header class="plans-head">
      <div>
        <div class="plans-title">Plans</div>
        <div class="plans-subtitle">.agent-team/plans · .cursor/plans</div>
      </div>
      <button class="plans-icon-btn" title="Refresh" @click="loadPlans">↻</button>
    </header>

    <div v-if="loading" class="plans-muted">
      {{ waitingForBackend ? 'Waiting for backend…' : 'Loading plans…' }}
    </div>
    <div v-else-if="error" class="plans-error">{{ error }}</div>

    <template v-else>
      <section class="plans-section">
        <div class="plans-section-head">
          <span>Active</span>
          <span>{{ docItems.length }}</span>
        </div>
        <button
          v-for="item in docItems"
          :key="item.relPath"
          class="plan-row"
          @click="openPlan(item)"
          @contextmenu.prevent="openCtxMenu($event, item)"
        >
          <span class="plan-row-name">{{ item.name }}</span>
          <span class="plan-row-path" :title="item.relPath">{{ item.relPath }}</span>
          <span class="plan-row-meta">
            <span>{{ item.name.endsWith('.html') ? 'html' : 'markdown' }}</span>
            <span class="plan-chip">doc</span>
          </span>
          <span
            class="plan-row-delete"
            role="button"
            :title="t('pane.plans.menu-delete')"
            @click.stop="deletePlan(item)"
          >✕</span>
        </button>
        <div v-if="!docItems.length" class="plans-empty">No active plans.</div>
      </section>

      <section v-for="group in stageGroups" :key="group.key" class="plans-section">
        <div class="plans-section-head">
          <span>{{ group.label }}</span>
          <span>{{ group.rows.length }}</span>
        </div>
        <button
          v-for="row in group.rows"
          :key="row.item.relPath"
          class="plan-row"
          :class="{ 'plan-row--done': group.finished }"
          @click="openPlan(row.item)"
          @contextmenu.prevent="openCtxMenu($event, row.item)"
        >
          <span class="plan-row-name">{{ row.meta.name }}</span>
          <span v-if="row.meta.overview" class="plan-row-overview">{{ row.meta.overview }}</span>
          <span class="plan-row-path" :title="row.item.relPath">{{ row.item.relPath }}</span>
          <span class="plan-row-meta">
            <span>{{ t('pane.plans.progress-done', { done: row.done, total: row.total }) }}</span>
            <span class="plan-chip" :class="{ 'plan-chip--done': group.finished }">{{ row.meta.stage }}</span>
          </span>
          <span
            class="plan-row-delete"
            role="button"
            :title="t('pane.plans.menu-delete')"
            @click.stop="deletePlan(row.item)"
          >✕</span>
        </button>
      </section>

      <section class="plans-section">
        <div class="plans-section-head">
          <span>Completed</span>
          <button
            class="plans-link-btn"
            :disabled="!deletablePlans.length"
            @click="deleteCompleted"
          >Delete all</button>
        </div>
      </section>
    </template>

    <template v-if="ctxMenu.show && ctxMenu.item">
      <div class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <div class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpen">{{ t('pane.plans.menu-open') }}</button>
        <template v-if="isHtmlItem(ctxMenu.item)">
          <button class="menu-item" @click="ctxShareToGit">{{ t('pane.plans.share-git') }}</button>
          <button class="menu-item" @click="ctxRename">{{ t('pane.plans.menu-rename') }}</button>
        </template>
        <template v-if="!ctxMenu.item.meta">
          <div class="menu-sep" />
          <button class="menu-item" @click="ctxUpgradeToPlan">{{ t('pane.plans.menu-upgrade') }}</button>
        </template>
        <div class="menu-sep" />
        <button class="menu-item danger" @click="ctxDelete">{{ t('pane.plans.menu-delete') }}</button>
      </div>
    </template>

    <template v-if="renameTarget">
      <div class="ctx-backdrop" @click="cancelRename" />
      <div class="rename-dialog">
        <div class="rename-title">{{ t('pane.plans.rename-title') }}</div>
        <input
          v-model="renameValue"
          class="rename-input"
          :placeholder="t('pane.plans.rename-placeholder')"
          @keydown.enter="onRenameEnter"
          @keydown.escape="cancelRename"
        />
        <div class="rename-hint">{{ t('pane.plans.rename-hint') }}</div>
        <div class="rename-actions">
          <button class="rename-btn" @click="cancelRename">{{ t('pane.plans.rename-cancel') }}</button>
          <button class="rename-btn rename-btn--primary" @click="submitRename">
            {{ t('pane.plans.rename-confirm') }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plans-pane {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  font-size: 12px;
  height: 100%;
  overflow-y: auto;
}

.plans-head {
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 12px;
}

.plans-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.plans-subtitle {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 2px;
}

.plans-icon-btn,
.plans-link-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 3px 7px;
}

.plans-link-btn {
  border: none;
  padding: 0;
}

.plans-link-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

.plans-icon-btn:hover,
.plans-link-btn:not(:disabled):hover {
  color: var(--text-primary);
}

.plans-muted,
.plans-error,
.plans-empty {
  color: var(--text-muted);
  padding: 12px;
}

.plans-error {
  color: var(--danger-fg);
}

.plans-section {
  padding: 10px 8px 4px;
}

.plans-section-head {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: 11px;
  font-weight: 700;
  justify-content: space-between;
  letter-spacing: 0.05em;
  padding: 0 4px 6px;
  text-transform: uppercase;
}

.plan-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 5px;
  padding: 8px;
  position: relative;
  text-align: left;
  width: 100%;
}

.plan-row:hover {
  background: var(--bg-hover);
  border-color: var(--border-subtle);
}

.plan-row-delete {
  align-items: center;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: 12px;
  height: 20px;
  justify-content: center;
  opacity: 0;
  position: absolute;
  right: 6px;
  top: 6px;
  width: 20px;
}

.plan-row:hover .plan-row-delete {
  opacity: 1;
}

.plan-row-delete:hover {
  background: var(--bg-hover-strong);
  color: var(--danger-fg);
}

.plan-row-name {
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-row-overview {
  color: var(--text-muted);
  display: -webkit-box;
  font-size: 11px;
  line-height: 1.35;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.plan-row-path {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-row-meta {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: 11px;
  gap: 8px;
  justify-content: space-between;
}

.plan-chip {
  background: var(--attention-subtle);
  border-radius: 999px;
  color: var(--attention-bright);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  text-transform: uppercase;
}

.plan-chip--done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.ctx-backdrop {
  inset: 0;
  position: fixed;
  z-index: 40;
}

.ctx-menu {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  min-width: 180px;
  padding: 4px;
  position: fixed;
  z-index: 41;
}

.ctx-menu .menu-item {
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--text-primary);
  cursor: pointer;
  display: block;
  font-size: 12px;
  padding: 6px 10px;
  text-align: left;
  width: 100%;
}

.ctx-menu .menu-item:hover {
  background: var(--bg-hover);
}

.ctx-menu .menu-item.danger {
  color: var(--danger-fg);
}

.ctx-menu .menu-sep {
  background: var(--border-subtle);
  height: 1px;
  margin: 4px 6px;
}

.rename-dialog {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  left: 50%;
  padding: 14px;
  position: fixed;
  top: 30%;
  transform: translateX(-50%);
  width: min(360px, 90vw);
  z-index: 41;
}

.rename-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px;
}

.rename-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  padding: 5px 8px;
  width: 100%;
}

.rename-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.rename-hint {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 6px;
}

.rename-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}

.rename-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11px;
  padding: 4px 12px;
}

.rename-btn:hover {
  background: var(--bg-hover-strong);
}

.rename-btn--primary {
  border-color: var(--accent-focus);
}
</style>
