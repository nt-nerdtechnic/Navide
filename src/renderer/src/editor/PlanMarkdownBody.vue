<script setup lang="ts">
// Prose renderer for markdown plan documents (`.plan.md`) in the plan review
// window, the markdown counterpart to PlanDocPreview's HTML iframe. Renders
// each `## section` body via the shared line-based markdownRender, and offers
// per-section inline edit/delete. Todos / notes / stage live in frontmatter and
// are driven by the shared PlanReviewToolbar — this component owns prose only.
//
// All writes go through the injected PlanStore (resolved by extension), never
// the backend fs API directly: section edit → replaceSectionBody({kind:
// 'markdown'}), delete → deleteSection, both carrying the store's optimistic
// lock. Reads still use fs.read_file (read-only, mirrors PlanFileView).
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parsePlanFile } from '../composables/usePlanFile'
import type { PlanSection } from '../composables/usePlanFile'
import type { useBackend } from '../composables/useBackend'
import { resolvePlanStore, type PlanCtx } from '../composables/planStore'
import { useNotify } from '../composables/useNotify'
import { renderLines, InlineText } from './markdownRender'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
  /** Bumped by the host after any write (own edit / external change) to reload. */
  refresh: number
}>()

// Emitted after a successful section write so the host can bump its shared
// refresh counter (which the toolbar and this body both observe).
const emit = defineEmits<{ (e: 'updated'): void }>()

const { t } = useI18n()
const { toast, confirm } = useNotify()

// Format-agnostic persistence adapter, resolved by extension; every write goes
// through it so concurrent agent edits to other sections are preserved.
const store = computed(() => resolvePlanStore(props.relPath))
const ctx = computed<PlanCtx>(() => ({
  backend: props.backend,
  workspacePath: props.workspacePath,
  relPath: props.relPath,
}))

const rawContent = ref('')
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const root = ref<HTMLElement | null>(null)

async function loadContent(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; content?: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    )
    if (resp.payload?.ok && resp.payload.content !== undefined) {
      rawContent.value = resp.payload.content
    } else {
      loadError.value = resp.payload?.error ?? 'Failed to load file'
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load file'
  } finally {
    loading.value = false
  }
}

onMounted(() => void loadContent())
watch(() => props.relPath, loadContent)
watch(() => props.refresh, loadContent)

const parsed = computed(() => (rawContent.value ? parsePlanFile(rawContent.value) : null))
// Prose sections (## headings with a non-empty body); todos live in frontmatter.
const sections = computed<PlanSection[]>(() =>
  parsed.value?.sections.filter((sec) => sec.body.trim()) ?? [],
)
// No parseable frontmatter → render the whole file as read-only markdown.
const fallbackLines = computed(() =>
  !parsed.value && rawContent.value.trim() ? renderLines(rawContent.value) : [],
)

// Lazy-render a ```mermaid fence; the mermaid lib is dynamically imported so it
// never loads unless a plan actually contains a diagram.
const MermaidBlock = defineComponent({
  props: { code: { type: String, default: '' } },
  setup(props) {
    const svg = ref('')
    const error = ref(false)
    let seq = 0
    watch(
      () => props.code,
      async (code) => {
        const id = ++seq
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', fontFamily: 'inherit' })
          const { svg: out } = await mermaid.render(`pmb-mermaid-${Math.random().toString(36).slice(2, 9)}`, code)
          if (id === seq) svg.value = out
        } catch {
          if (id === seq) error.value = true
        }
      },
      { immediate: true },
    )
    return () => {
      if (error.value) return h('pre', { class: 'pmb-line pmb-line--code' }, props.code)
      if (!svg.value) return h('div', { class: 'pmb-mermaid pmb-mermaid--loading' }, 'Rendering diagram…')
      return h('div', { class: 'pmb-mermaid', innerHTML: svg.value })
    }
  },
})

// ── Inline section body editing ───────────────────────────────────────────
const editingSection = ref<string | null>(null)
const editSectionText = ref('')

function startEditSection(section: PlanSection): void {
  editingSection.value = section.heading
  editSectionText.value = section.body
}

function cancelEditSection(): void {
  editingSection.value = null
  editSectionText.value = ''
}

function reportResult(result: { ok: boolean; conflict?: boolean; error?: string }): boolean {
  if (result.ok) return true
  toast(result.conflict ? t('pane.plans.review-save-failed') : result.error ?? t('pane.plans.review-save-failed'))
  return false
}

async function saveEditSection(heading: string): Promise<void> {
  if (saving.value) return
  saving.value = true
  const result = await store.value.replaceSectionBody(ctx.value, heading, {
    kind: 'markdown',
    text: editSectionText.value,
  })
  saving.value = false
  if (reportResult(result)) {
    cancelEditSection()
    await loadContent()
    emit('updated')
  }
}

async function deleteSection(heading: string): Promise<void> {
  if (saving.value) return
  const ok = await confirm(t('pane.plans.doc-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  saving.value = true
  const result = await store.value.deleteSection(ctx.value, heading)
  saving.value = false
  if (reportResult(result)) {
    if (editingSection.value === heading) cancelEditSection()
    await loadContent()
    emit('updated')
  }
}

// ── Host integration (ESC overlay priority + outline nav) ──────────────────
/** True while a section textarea is open, so the host cancels edit before close. */
function isEditing(): boolean {
  return editingSection.value !== null
}

/** Ask to discard the in-progress section edit (ESC from the host). */
function cancelEdit(): void {
  cancelEditSection()
}

/** Outline navigation: scroll the section card with this heading into view. */
function scrollToAnchor(anchor: string): void {
  const el = root.value?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`)
  el?.scrollIntoView({ block: 'start' })
}

defineExpose({ isEditing, cancelEdit, scrollToAnchor })
</script>

<template>
  <div ref="root" class="pmb">
    <div v-if="loading" class="pmb-state">Loading…</div>
    <div v-else-if="loadError" class="pmb-state pmb-state--error">{{ loadError }}</div>

    <div v-else-if="parsed" class="pmb-inner">
      <div
        v-for="section in sections"
        :key="section.heading"
        :data-anchor="section.heading"
        class="pmb-section"
      >
        <div class="pmb-section-head">
          <div class="pmb-section-title">{{ section.heading }}</div>
          <div v-if="editingSection !== section.heading" class="pmb-section-actions">
            <button class="pmb-btn" @click="startEditSection(section)">{{ t('pane.plans.edit') }}</button>
            <button class="pmb-btn pmb-btn--danger" @click="deleteSection(section.heading)">
              {{ t('pane.plans.delete') }}
            </button>
          </div>
        </div>

        <div v-if="editingSection === section.heading" class="pmb-section-edit">
          <textarea
            v-model="editSectionText"
            class="pmb-textarea"
            :placeholder="t('pane.plans.doc-edit-placeholder')"
          />
          <div class="pmb-edit-actions">
            <button class="pmb-btn" :disabled="saving" @click="cancelEditSection">
              {{ t('pane.plans.cancel') }}
            </button>
            <button class="pmb-btn pmb-btn--primary" :disabled="saving" @click="saveEditSection(section.heading)">
              {{ t('pane.plans.save') }}
            </button>
          </div>
        </div>

        <div v-else class="pmb-doc-body">
          <template v-for="(line, idx) in renderLines(section.body)" :key="section.heading + ':' + idx">
            <div v-if="line.kind === 'blank'" class="pmb-line pmb-line--blank" />
            <div v-else-if="line.kind === 'heading'" :class="['pmb-line', 'pmb-line--heading', 'pmb-line--h' + line.level]"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'quote'" class="pmb-line pmb-line--quote"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'bullet'" class="pmb-line pmb-line--bullet"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'ordered'" class="pmb-line pmb-line--ordered">
              <span class="pmb-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
            </div>
            <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
            <pre v-else-if="line.kind === 'codeblock'" class="pmb-line pmb-line--code">{{ line.text }}</pre>
            <div v-else class="pmb-line"><InlineText :text="line.text" /></div>
          </template>
        </div>
      </div>

      <div v-if="sections.length === 0" class="pmb-state">No document sections yet.</div>
    </div>

    <!-- Fallback: no frontmatter — render the whole file as read-only markdown. -->
    <div v-else-if="fallbackLines.length" class="pmb-doc-body pmb-inner">
      <template v-for="(line, idx) in fallbackLines" :key="'md:' + idx">
        <div v-if="line.kind === 'blank'" class="pmb-line pmb-line--blank" />
        <div v-else-if="line.kind === 'heading'" :class="['pmb-line', 'pmb-line--heading', 'pmb-line--h' + line.level]"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'quote'" class="pmb-line pmb-line--quote"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'bullet'" class="pmb-line pmb-line--bullet"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'ordered'" class="pmb-line pmb-line--ordered">
          <span class="pmb-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
        </div>
        <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
        <pre v-else-if="line.kind === 'codeblock'" class="pmb-line pmb-line--code">{{ line.text }}</pre>
        <div v-else class="pmb-line"><InlineText :text="line.text" /></div>
      </template>
    </div>

    <div v-else class="pmb-state">This plan has no document body.</div>
  </div>
</template>

<style scoped>
.pmb {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 32px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-base);
  font-family: var(--font-ui, system-ui, sans-serif);
}

.pmb-state {
  color: var(--text-secondary);
  font-style: italic;
  padding: 20px 0;
}

.pmb-state--error {
  color: var(--danger-fg);
}

.pmb-inner {
  margin: 0 auto;
  max-width: 860px;
}

.pmb-section {
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 18px;
  padding-bottom: 16px;
}

.pmb-section-head {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.pmb-section-title {
  color: var(--text-bright);
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 10px;
}

.pmb-section-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.pmb-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 9px;
}

.pmb-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.pmb-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.pmb-btn--primary {
  border-color: var(--accent-focus);
}

.pmb-btn--danger:hover:not(:disabled) {
  color: var(--danger-fg);
}

.pmb-section-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pmb-textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 12px;
  line-height: 1.5;
  min-height: 120px;
  padding: 8px;
  resize: vertical;
  width: 100%;
}

.pmb-textarea:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.pmb-edit-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.pmb-line {
  color: var(--text-primary);
  line-height: 1.55;
  margin: 3px 0;
}

.pmb-line--blank {
  height: 8px;
}

.pmb-line--heading {
  color: var(--text-bright);
  font-weight: 650;
  margin-top: 10px;
}

.pmb-line--h1 {
  font-size: 19px;
  margin-top: 20px;
}

.pmb-line--h2 {
  font-size: 16px;
  margin-top: 16px;
}

.pmb-line--h3 {
  font-size: 14px;
  margin-top: 12px;
}

.pmb-line--h4 {
  font-size: 13px;
}

.pmb-line--quote {
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
  margin: 4px 0;
  padding-left: 10px;
}

.pmb-line code {
  background: var(--bg-muted);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 12px;
}

.pmb-line--bullet {
  padding-left: 18px;
  position: relative;
}

.pmb-line--bullet::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 0.75em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.pmb-line--ordered {
  padding-left: 4px;
}

.pmb-ordered-marker {
  color: var(--text-secondary);
  margin-right: 4px;
}

.pmb-line--code {
  background: var(--bg-inset);
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  margin: 4px 0;
  overflow-x: auto;
  padding: 6px 8px;
}

/* InlineText (shared markdownRender) tags links with `pfv-link`; reach into the
   child component's output so links stay styled here too. */
:deep(.pfv-link) {
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: none;
}

:deep(.pfv-link:hover) {
  text-decoration: underline;
}

.pmb-mermaid {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  margin: 8px 0;
  overflow-x: auto;
  padding: 12px;
}

.pmb-mermaid svg {
  height: auto;
  max-width: 100%;
}

.pmb-mermaid--loading {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}
</style>
