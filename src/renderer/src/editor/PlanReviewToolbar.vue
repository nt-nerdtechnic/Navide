<script setup lang="ts">
// Plan review toolbar shown above the sandboxed HTML preview of
// `.agent-team/plans/*.html` documents. Reads/writes only the `plan-meta`
// JSON island via usePlanHtml — every other byte of the file is preserved.
// Renders nothing when the file has no valid plan-meta block.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseHtmlPlanMeta, replaceHtmlPlanMeta, htmlPlanProgress } from '../composables/usePlanHtml'
import type { HtmlPlanMeta, HtmlPlanReviewNote } from '../composables/usePlanHtml'
import type { useBackend } from '../composables/useBackend'
import { useNotify } from '../composables/useNotify'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
}>()

// Emitted after the file content changed (own write or external edit detected
// on window focus) so the host can refresh the HTML preview.
const emit = defineEmits<{
  (e: 'updated'): void
}>()

const { t } = useI18n()
const { toast } = useNotify()

const rawContent = ref('')
const meta = ref<HtmlPlanMeta | null>(null)
const notesOpen = ref(false)
const newNoteText = ref('')
const saving = ref(false)

function applyContent(content: string, notifyHost: boolean): void {
  const changed = content !== rawContent.value
  rawContent.value = content
  meta.value = parseHtmlPlanMeta(content)?.meta ?? null
  if (notifyHost && changed) emit('updated')
}

async function loadContent(notifyHost = false): Promise<void> {
  // In-flight guard: while a write is running, a focus-triggered re-read
  // could resolve with stale content and clobber the just-written state.
  if (saving.value) return
  try {
    const resp = await props.backend.send<{ ok: boolean; content?: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    )
    if (resp.payload?.ok && resp.payload.content !== undefined) {
      applyContent(resp.payload.content, notifyHost)
    }
  } catch {
    // Toolbar simply stays hidden when the file cannot be read.
  }
}

// No fs-watch exists in the app; re-read on window focus so external edits
// (e.g. by an agent) refresh the toolbar and, via `updated`, the preview.
function onWindowFocus(): void {
  void loadContent(true)
}

onMounted(() => {
  void loadContent()
  window.addEventListener('focus', onWindowFocus)
})
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))
watch(
  () => props.relPath,
  () => {
    rawContent.value = ''
    meta.value = null
    void loadContent()
  },
)

const progress = computed(() => htmlPlanProgress(meta.value?.todos ?? []))
const unresolvedCount = computed(() => (meta.value?.reviewNotes ?? []).filter((n) => !n.resolved).length)
const canApprove = computed(() => meta.value?.stage === 'in-review' && unresolvedCount.value === 0)

// Read-before-write: re-read the file and re-apply the mutation on the fresh
// meta so external edits made since our last read (e.g. by an AI agent) are
// preserved instead of clobbered. `mutate` returns null to abort when its
// precondition no longer holds against the fresh meta; the UI is then
// refreshed from the fresh content.
async function writeMeta(mutate: (fresh: HtmlPlanMeta) => HtmlPlanMeta | null): Promise<boolean> {
  saving.value = true
  try {
    const readResp = await props.backend.send<{ ok: boolean; content?: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    )
    if (!readResp.payload?.ok || readResp.payload.content === undefined) {
      toast(readResp.payload?.error ?? t('pane.plans.review-save-failed'))
      return false
    }
    const freshContent = readResp.payload.content
    const freshMeta = parseHtmlPlanMeta(freshContent)?.meta ?? null
    if (!freshMeta) {
      toast(t('pane.plans.review-save-failed'))
      return false
    }
    const next = mutate(freshMeta)
    if (!next) {
      applyContent(freshContent, true)
      return false
    }
    const content = replaceHtmlPlanMeta(freshContent, next)
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      content,
    })
    if (!resp.payload?.ok) {
      toast(resp.payload?.error ?? t('pane.plans.review-save-failed'))
      return false
    }
    rawContent.value = content
    meta.value = next
    emit('updated')
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.review-save-failed'))
    return false
  } finally {
    saving.value = false
  }
}

async function approve(): Promise<void> {
  if (!meta.value || !canApprove.value || saving.value) return
  await writeMeta((fresh) => {
    if (fresh.stage !== 'in-review' || fresh.reviewNotes.some((n) => !n.resolved)) return null
    return { ...fresh, stage: 'approved', approvedAt: new Date().toISOString() }
  })
}

async function resolveNote(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  await writeMeta((fresh) => ({
    ...fresh,
    reviewNotes: fresh.reviewNotes.map((n) => (n.id === id ? { ...n, resolved: true } : n)),
  }))
}

function nextNoteId(notes: HtmlPlanReviewNote[]): string {
  let max = 0
  for (const note of notes) {
    const m = note.id.match(/^n(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

async function submitNote(): Promise<void> {
  const text = newNoteText.value.trim()
  if (!meta.value || !text || saving.value) return
  const ok = await writeMeta((fresh) => {
    const note: HtmlPlanReviewNote = {
      id: nextNoteId(fresh.reviewNotes),
      author: 'user',
      text,
      resolved: false,
      reply: '',
    }
    return { ...fresh, reviewNotes: [...fresh.reviewNotes, note] }
  })
  if (ok) newNoteText.value = ''
}

// Guard against IME composition: pressing Enter to commit a candidate must
// not submit the half-composed note.
function onNoteEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitNote()
}
</script>

<template>
  <div v-if="meta" class="prt">
    <div class="prt-bar">
      <span class="prt-stage" :class="`prt-stage--${meta.stage}`">{{ t(`pane.plans.stage-${meta.stage}`) }}</span>
      <span class="prt-progress">{{ t('pane.plans.progress-done', { done: progress.done, total: progress.total }) }}</span>
      <span class="prt-spacer" />
      <button class="prt-notes-btn" :class="{ 'prt-notes-btn--open': notesOpen }" @click="notesOpen = !notesOpen">
        {{ t('pane.plans.review-notes') }} · {{ t('pane.plans.review-unresolved', { count: unresolvedCount }) }}
      </button>
      <button
        class="prt-approve"
        :disabled="!canApprove || saving"
        :title="canApprove ? '' : t('pane.plans.review-approve-hint')"
        @click="approve"
      >{{ t('pane.plans.review-approve') }}</button>
    </div>

    <div v-if="notesOpen" class="prt-panel">
      <div v-if="meta.reviewNotes.length === 0" class="prt-empty">{{ t('pane.plans.review-empty') }}</div>
      <div
        v-for="note in meta.reviewNotes"
        :key="note.id"
        class="prt-note"
        :class="{ 'prt-note--resolved': note.resolved }"
      >
        <span class="prt-note-author">{{ note.author }}</span>
        <div class="prt-note-main">
          <div class="prt-note-text">{{ note.text }}</div>
          <div v-if="note.reply" class="prt-note-reply">{{ note.reply }}</div>
        </div>
        <span v-if="note.resolved" class="prt-note-done">{{ t('pane.plans.review-resolved') }}</span>
        <button v-else class="prt-note-resolve" :disabled="saving" @click="resolveNote(note.id)">
          {{ t('pane.plans.review-resolve') }}
        </button>
      </div>
      <div class="prt-new">
        <input
          v-model="newNoteText"
          class="prt-input"
          :placeholder="t('pane.plans.review-add-placeholder')"
          @keydown.enter="onNoteEnter"
        />
        <button class="prt-send" :disabled="saving || !newNoteText.trim()" @click="submitNote">
          {{ t('pane.plans.review-send') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prt {
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12px;
}

.prt-bar {
  align-items: center;
  display: flex;
  gap: 10px;
  padding: 6px 12px;
}

.prt-stage {
  border-radius: 10px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  text-transform: uppercase;
}

.prt-stage--draft {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.prt-stage--in-review {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.prt-stage--approved {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.prt-stage--in-progress {
  background: var(--attention-subtle);
  color: var(--warning-fg);
}

.prt-stage--done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.prt-stage--abandoned {
  background: var(--danger-subtle);
  color: var(--danger-fg);
}

.prt-progress {
  color: var(--text-secondary);
  font-size: 11px;
}

.prt-spacer {
  flex: 1;
}

.prt-notes-btn,
.prt-approve,
.prt-note-resolve,
.prt-send {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11px;
  padding: 3px 10px;
}

.prt-notes-btn:hover,
.prt-note-resolve:hover:not(:disabled),
.prt-send:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.prt-notes-btn--open {
  border-color: var(--accent-focus);
}

.prt-approve {
  background: var(--success-subtle);
  border-color: var(--success-fg);
  color: var(--success-fg);
  font-weight: 600;
}

.prt-approve:disabled,
.prt-note-resolve:disabled,
.prt-send:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.prt-panel {
  border-top: 1px solid var(--border-muted);
  max-height: 40vh;
  overflow-y: auto;
  padding: 8px 12px;
}

.prt-empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 4px 0;
}

.prt-note {
  align-items: baseline;
  display: flex;
  gap: 8px;
  padding: 5px 0;
}

.prt-note--resolved .prt-note-text {
  color: var(--text-secondary);
}

.prt-note-author {
  color: var(--text-secondary);
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  min-width: 30px;
  text-transform: uppercase;
}

.prt-note-main {
  flex: 1;
  min-width: 0;
}

.prt-note-text {
  color: var(--text-primary);
  line-height: 1.45;
  overflow-wrap: break-word;
}

.prt-note-reply {
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
  line-height: 1.45;
  margin-top: 2px;
  overflow-wrap: break-word;
  padding-left: 8px;
}

.prt-note-done {
  color: var(--success-fg);
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.prt-new {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.prt-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  flex: 1;
  font-size: 12px;
  padding: 4px 8px;
}

.prt-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}
</style>
