<script setup lang="ts">
import { computed, defineComponent, h, ref, watch, onMounted } from 'vue'
import { parsePlanFile, writePlanFile, planProgress } from '../composables/usePlanFile'
import type { PlanTodo, PlanSection, TodoStatus } from '../composables/usePlanFile'
import type { useBackend } from '../composables/useBackend'
import { useNotify } from '../composables/useNotify'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
}>()

const emit = defineEmits<{
  (e: 'dirty', value: boolean): void
}>()

const { toast } = useNotify()

const rawContent = ref('')
const loading = ref(true)
const loadError = ref('')
const waitingForBackend = ref(false)

async function loadContent(): Promise<void> {
  if (props.backend.status?.value && props.backend.status.value !== 'connected') {
    loading.value = true
    waitingForBackend.value = true
    loadError.value = ''
    return
  }
  loading.value = true
  waitingForBackend.value = false
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
watch(() => props.backend.status?.value, (status) => {
  if (status === 'connected' && (waitingForBackend.value || loadError.value === 'ws not open')) {
    void loadContent()
  }
})

// Parsed plan derived from rawContent.
const parsed = computed(() => (rawContent.value ? parsePlanFile(rawContent.value) : null))

// Map section heading to its phase prefix for grouping todos.
function sectionPrefix(heading: string): string {
  const m = heading.match(/Phase\s+([A-Za-z0-9])/i)
  if (!m) return ''
  return `phase-${m[1].toLowerCase()}`
}

interface PhaseGroup {
  heading: string
  todos: PlanTodo[]
}

// Build display groups: one group per ## section, collecting matching todos.
const groups = computed((): PhaseGroup[] => {
  const plan = parsed.value
  if (!plan) return []

  const sections: PlanSection[] = plan.sections
  const claimed = new Set<string>()

  const result: PhaseGroup[] = sections.map((sec) => {
    const prefix = sectionPrefix(sec.heading)
    const todos = plan.todos.filter((t) => {
      if (!prefix) return false
      const match = t.id.startsWith(prefix)
      if (match) claimed.add(t.id)
      return match
    })
    return { heading: sec.heading, todos }
  })

  // Unclaimed todos go into a catch-all group.
  const unclaimed = plan.todos.filter((t) => !claimed.has(t.id))
  if (unclaimed.length > 0) {
    if (sections.length === 0) {
      result.push({ heading: 'Tasks', todos: unclaimed })
    } else {
      result.push({ heading: 'Other Tasks', todos: unclaimed })
    }
  }

  // Remove empty groups (sections with no matching todos).
  return result.filter((g) => g.todos.length > 0)
})

const overallProgress = computed(() => planProgress(parsed.value?.todos ?? []))

function isPhaseHeading(heading: string): boolean {
  return /^Phase\s+[A-Za-z0-9]/i.test(heading)
}

const documentSections = computed(() => {
  const plan = parsed.value
  if (!plan) return []
  return plan.sections.filter((sec) => !isPhaseHeading(sec.heading) && sec.body.trim())
})

const fileListSection = computed(() => documentSections.value.find((sec) =>
  /修改檔案清單|modified files?|file changes?|files? to change/i.test(sec.heading)
))

const fileList = computed(() => {
  const section = fileListSection.value
  if (!section) return []
  const files: string[] = []
  for (const line of section.body.split('\n')) {
    const matches = [...line.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|vue|py|md|json|css|scss|html|yml|yaml|toml|sh))`/g)]
    for (const m of matches) files.push(m[1])
    if (matches.length === 0) {
      const bullet = line.match(/^\s*[-*]\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/)
      if (bullet) files.push(bullet[1])
    }
  }
  return [...new Set(files)]
})

type RenderLine =
  | { kind: 'blank'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; marker: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'codeblock'; lang: string; text: string }

function renderLines(body: string): RenderLine[] {
  const lines: RenderLine[] = []
  let codeBlock: { kind: 'codeblock'; lang: string; text: string } | null = null
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    const fence = line.trim().match(/^```(\S*)/)
    if (fence) {
      if (codeBlock) {
        lines.push(codeBlock)
        codeBlock = null
      } else {
        codeBlock = { kind: 'codeblock', lang: fence[1].toLowerCase(), text: '' }
      }
      continue
    }
    if (codeBlock) {
      codeBlock.text += codeBlock.text ? '\n' + line : line
    } else if (!line.trim()) {
      lines.push({ kind: 'blank', text: '' })
    } else if (/^#{1,4}\s+/.test(line.trim())) {
      const m = line.trim().match(/^(#{1,4})\s+(.*)/)!
      lines.push({ kind: 'heading', level: m[1].length, text: m[2] })
    } else if (/^\s*>\s?/.test(line)) {
      lines.push({ kind: 'quote', text: line.replace(/^\s*>\s?/, '') })
    } else if (/^\s*[-*]\s+/.test(line)) {
      lines.push({ kind: 'bullet', text: line.replace(/^\s*[-*]\s+/, '') })
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.+)/)!
      lines.push({ kind: 'ordered', marker: `${m[1]}.`, text: m[2] })
    } else {
      lines.push({ kind: 'paragraph', text: line.trim() })
    }
  }
  if (codeBlock) lines.push(codeBlock)
  return lines
}

// Lazy-render a ```mermaid fence. The mermaid lib is dynamically imported so it
// never loads unless a plan actually contains a diagram (editor-window startup
// deliberately avoids the static mermaid import in AIChatPane).
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
          const { svg: out } = await mermaid.render(`pfv-mermaid-${Math.random().toString(36).slice(2, 9)}`, code)
          if (id === seq) svg.value = out
        } catch {
          if (id === seq) error.value = true
        }
      },
      { immediate: true },
    )
    return () => {
      if (error.value) return h('pre', { class: 'pfv-line pfv-line--code' }, props.code)
      if (!svg.value) return h('div', { class: 'pfv-mermaid pfv-mermaid--loading' }, 'Rendering diagram…')
      return h('div', { class: 'pfv-mermaid', innerHTML: svg.value })
    }
  },
})

// Files without parseable frontmatter render as plain markdown instead of an error.
const fallbackLines = computed(() =>
  !parsed.value && rawContent.value.trim() ? renderLines(rawContent.value) : []
)

// Render inline `code`, **bold** and [text](url) spans inside a markdown line.
type InlineSegment =
  | { kind: 'text' | 'code' | 'bold'; text: string }
  | { kind: 'link'; text: string; href: string }

function inlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) segments.push({ kind: 'link', text: m[1], href: m[2] })
    else if (m[3] !== undefined) segments.push({ kind: 'code', text: m[3] })
    else segments.push({ kind: 'bold', text: m[4] })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

const InlineText = defineComponent({
  props: { text: { type: String, default: '' } },
  setup(props) {
    return () =>
      inlineSegments(props.text).map((seg) => {
        if (seg.kind === 'code') return h('code', seg.text)
        if (seg.kind === 'bold') return h('strong', seg.text)
        if (seg.kind === 'link') {
          return h(
            'a',
            {
              class: 'pfv-link',
              href: seg.href,
              title: seg.href,
              onClick: (e: Event) => {
                e.preventDefault()
                void window.agentTeam?.openExternal(seg.href)
              },
            },
            seg.text,
          )
        }
        return seg.text
      })
  },
})

// Progress counter per group.
function doneCount(group: PhaseGroup): number {
  return group.todos.filter((t) => t.status === 'done').length
}

// Cycle status on click: pending → in-progress → done → pending
const STATUS_CYCLE: Record<TodoStatus, TodoStatus> = {
  pending: 'in-progress',
  'in-progress': 'done',
  done: 'pending',
}

async function saveTodos(updatedTodos: PlanTodo[]): Promise<boolean> {
  const plan = parsed.value
  if (!plan) return false
  const newRaw = writePlanFile({ ...plan, todos: updatedTodos }, rawContent.value)

  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      content: newRaw,
    })
    if (!resp.payload?.ok) {
      toast(resp.payload?.error ?? 'Save failed')
      return false
    }
    rawContent.value = newRaw
    toast('Saved', { type: 'success' })
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Save failed')
    return false
  }
}

async function toggleTodo(todoId: string): Promise<void> {
  const plan = parsed.value
  if (!plan) return
  await saveTodos(plan.todos.map((t) => (t.id === todoId ? { ...t, status: STATUS_CYCLE[t.status] } : t)))
}

// Cursor-style to-do management: add via "+ New", remove via the row's ✕.
const addingTodo = ref(false)
const newTodoText = ref('')

function nextTodoId(todos: PlanTodo[]): string {
  let n = todos.length + 1
  while (todos.some((t) => t.id === `todo-${n}`)) n++
  return `todo-${n}`
}

async function addTodo(): Promise<void> {
  const plan = parsed.value
  const content = newTodoText.value.trim()
  if (!plan || !content) return
  const ok = await saveTodos([...plan.todos, { id: nextTodoId(plan.todos), content, status: 'pending' }])
  if (ok) {
    newTodoText.value = ''
    addingTodo.value = false
  }
}

async function removeTodo(todoId: string): Promise<void> {
  const plan = parsed.value
  if (!plan) return
  await saveTodos(plan.todos.filter((t) => t.id !== todoId))
}

function checkboxGlyph(status: TodoStatus): string {
  if (status === 'done') return '●'
  if (status === 'in-progress') return '◐'
  return '○'
}

// Badge config per status.
function badgeLabel(status: TodoStatus): string {
  return status === 'in-progress' ? 'in progress' : status
}
function badgeClass(status: TodoStatus): string {
  if (status === 'done') return 'pfv-badge pfv-badge--done'
  if (status === 'in-progress') return 'pfv-badge pfv-badge--in-progress'
  return 'pfv-badge pfv-badge--pending'
}
</script>

<template>
  <div class="pfv">
    <div v-if="loading" class="pfv-loading">
      {{ waitingForBackend ? 'Waiting for backend…' : 'Loading…' }}
    </div>

    <div v-else-if="loadError" class="pfv-error">{{ loadError }}</div>

    <div v-else-if="parsed" class="pfv-inner">
      <!-- Header -->
      <div class="pfv-header">
        <div class="pfv-title-row">
          <div class="pfv-title">{{ parsed.name }}</div>
          <div v-if="overallProgress.total" class="pfv-total-progress">
            {{ overallProgress.done }}/{{ overallProgress.total }} done
          </div>
        </div>
        <div v-if="parsed.overview" class="pfv-overview">{{ parsed.overview }}</div>
      </div>

      <div v-if="fileList.length" class="pfv-card pfv-files">
        <div class="pfv-card-title">Modified Files</div>
        <ul class="pfv-file-list">
          <li v-for="file in fileList" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
      </div>

      <div v-for="section in documentSections" :key="section.heading" class="pfv-card pfv-doc-section">
        <div class="pfv-card-title">{{ section.heading }}</div>
        <div class="pfv-doc-body">
          <template v-for="(line, idx) in renderLines(section.body)" :key="section.heading + ':' + idx">
            <div v-if="line.kind === 'blank'" class="pfv-line pfv-line--blank" />
            <div v-else-if="line.kind === 'heading'" :class="['pfv-line', 'pfv-line--heading', 'pfv-line--h' + line.level]"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'quote'" class="pfv-line pfv-line--quote"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'bullet'" class="pfv-line pfv-line--bullet"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'ordered'" class="pfv-line pfv-line--ordered">
              <span class="pfv-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
            </div>
            <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
            <pre v-else-if="line.kind === 'codeblock'" class="pfv-line pfv-line--code">{{ line.text }}</pre>
            <div v-else class="pfv-line"><InlineText :text="line.text" /></div>
          </template>
        </div>
      </div>

      <!-- To-dos header: count + Cursor-style "+ New" -->
      <div class="pfv-todos-head">
        <span class="pfv-todos-count">{{ parsed.todos.length }} To-dos</span>
        <button class="pfv-new-btn" @click="addingTodo = !addingTodo">+ New</button>
      </div>
      <div v-if="addingTodo" class="pfv-new-row">
        <input
          v-model="newTodoText"
          class="pfv-new-input"
          placeholder="Describe the to-do…"
          @keydown.enter="addTodo"
          @keydown.esc="addingTodo = false"
        />
        <button class="pfv-new-btn" @click="addTodo">Add</button>
      </div>

      <!-- Phase groups -->
      <div
        v-for="group in groups"
        :key="group.heading"
        class="pfv-group"
      >
        <div class="pfv-group-header">
          <span class="pfv-group-dot">●</span>
          <span class="pfv-group-title">{{ group.heading }}</span>
          <span v-if="group.todos.length > 0" class="pfv-group-progress">
            {{ doneCount(group) }}/{{ group.todos.length }} done
          </span>
        </div>

        <div
          v-for="todo in group.todos"
          :key="todo.id"
          class="pfv-todo"
          @click="toggleTodo(todo.id)"
        >
          <span class="pfv-checkbox" :class="{ 'pfv-checkbox--checked': todo.status === 'done' || todo.status === 'in-progress' }">
            {{ checkboxGlyph(todo.status) }}
          </span>
          <span class="pfv-todo-content">{{ todo.content }}</span>
          <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
          <button class="pfv-todo-remove" title="Remove to-do" @click.stop="removeTodo(todo.id)">✕</button>
        </div>
      </div>

      <!-- No groups (no matching sections) but we have todos -->
      <div v-if="groups.length === 0 && parsed.todos.length > 0" class="pfv-group">
        <div class="pfv-group-header">
          <span class="pfv-group-dot">●</span>
          <span class="pfv-group-title">Tasks</span>
          <span class="pfv-group-progress">
            {{ parsed.todos.filter(t => t.status === 'done').length }}/{{ parsed.todos.length }} done
          </span>
        </div>
        <div
          v-for="todo in parsed.todos"
          :key="todo.id"
          class="pfv-todo"
          @click="toggleTodo(todo.id)"
        >
          <span class="pfv-checkbox" :class="{ 'pfv-checkbox--checked': todo.status === 'done' || todo.status === 'in-progress' }">
            {{ checkboxGlyph(todo.status) }}
          </span>
          <span class="pfv-todo-content">{{ todo.content }}</span>
          <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
          <button class="pfv-todo-remove" title="Remove to-do" @click.stop="removeTodo(todo.id)">✕</button>
        </div>
      </div>

      <div v-if="groups.length === 0 && parsed.todos.length === 0" class="pfv-empty">
        No tasks defined in this plan.
      </div>
    </div>

    <!-- Fallback: no frontmatter — render the whole file as plain markdown -->
    <div v-else-if="fallbackLines.length" class="pfv-doc-body pfv-inner">
      <template v-for="(line, idx) in fallbackLines" :key="'md:' + idx">
        <div v-if="line.kind === 'blank'" class="pfv-line pfv-line--blank" />
        <div v-else-if="line.kind === 'heading'" :class="['pfv-line', 'pfv-line--heading', 'pfv-line--h' + line.level]"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'quote'" class="pfv-line pfv-line--quote"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'bullet'" class="pfv-line pfv-line--bullet"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'ordered'" class="pfv-line pfv-line--ordered">
          <span class="pfv-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
        </div>
        <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
        <pre v-else-if="line.kind === 'codeblock'" class="pfv-line pfv-line--code">{{ line.text }}</pre>
        <div v-else class="pfv-line"><InlineText :text="line.text" /></div>
      </template>
    </div>

    <!-- Fallback: empty file -->
    <div v-else class="pfv-invalid">
      <div class="pfv-invalid-msg">
        Could not parse plan frontmatter. Switch to Raw view to edit.
      </div>
    </div>
  </div>
</template>

<style scoped>
.pfv {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 32px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-base);
  font-family: var(--font-ui, system-ui, sans-serif);
}

.pfv-loading,
.pfv-error {
  color: var(--text-secondary);
  padding: 20px 0;
  font-style: italic;
}

.pfv-error {
  color: var(--danger-fg);
}

.pfv-header {
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-default);
}

.pfv-title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.pfv-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.pfv-total-progress {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pfv-overview {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.pfv-card {
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 18px;
  padding-bottom: 16px;
}

.pfv-card-title {
  color: var(--text-bright);
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 10px;
}

.pfv-file-list {
  display: grid;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.pfv-file-list code,
.pfv-line code {
  background: var(--bg-muted);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 12px;
}

.pfv-line {
  color: var(--text-primary);
  line-height: 1.55;
  margin: 3px 0;
}

.pfv-line--blank {
  height: 8px;
}

.pfv-inner {
  margin: 0 auto;
  max-width: 860px;
}

.pfv-line--heading {
  color: var(--text-bright);
  font-weight: 650;
  margin-top: 10px;
}

.pfv-line--h1 {
  font-size: 19px;
  margin-top: 20px;
}

.pfv-line--h2 {
  font-size: 16px;
  margin-top: 16px;
}

.pfv-line--h3 {
  font-size: 14px;
  margin-top: 12px;
}

.pfv-line--h4 {
  font-size: 13px;
}

.pfv-line--quote {
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
  margin: 4px 0;
  padding-left: 10px;
}

.pfv-link {
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: none;
}

.pfv-link:hover {
  text-decoration: underline;
}

.pfv-line--bullet {
  padding-left: 18px;
  position: relative;
}

.pfv-line--bullet::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 0.75em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.pfv-line--code {
  background: var(--bg-inset);
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  margin: 4px 0;
  overflow-x: auto;
  padding: 6px 8px;
}

.pfv-todos-head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin: 4px 0 10px;
}

.pfv-todos-count {
  color: var(--text-bright);
  font-size: 15px;
  font-weight: 650;
}

.pfv-new-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  padding: 3px 10px;
}

.pfv-new-btn:hover {
  background: var(--bg-hover-strong);
}

.pfv-new-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.pfv-new-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  flex: 1;
  font-size: 13px;
  padding: 5px 8px;
}

.pfv-new-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.pfv-todo-remove {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0;
  padding: 2px 4px;
}

.pfv-todo:hover .pfv-todo-remove {
  opacity: 1;
}

.pfv-todo-remove:hover {
  color: var(--danger-fg);
}

.pfv-line--ordered {
  padding-left: 4px;
}

.pfv-ordered-marker {
  color: var(--text-secondary);
  margin-right: 4px;
}

.pfv-mermaid {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  margin: 8px 0;
  overflow-x: auto;
  padding: 12px;
}

.pfv-mermaid svg {
  height: auto;
  max-width: 100%;
}

.pfv-mermaid--loading {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}

.pfv-group {
  margin-bottom: 18px;
}

.pfv-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 0;
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.pfv-group-dot {
  color: var(--accent-fg);
  font-size: 10px;
}

.pfv-group-title {
  flex: 1;
  color: var(--text-primary);
}

.pfv-group-progress {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 400;
}

.pfv-todo {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s;
  line-height: 1.45;
}

.pfv-todo:hover {
  background: var(--bg-hover-faint);
}

.pfv-checkbox {
  font-size: 15px;
  flex-shrink: 0;
  user-select: none;
  color: var(--text-secondary);
}

.pfv-checkbox--checked {
  color: var(--success-fg);
}

.pfv-todo-content {
  flex: 1;
  font-size: 13px;
}

.pfv-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pfv-badge--pending {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.pfv-badge--in-progress {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.pfv-badge--done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.pfv-empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 20px 0;
}

.pfv-invalid {
  padding: 20px 0;
}

.pfv-invalid-msg {
  color: var(--warning-fg);
  font-style: italic;
}
</style>
