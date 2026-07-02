<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { parsePlanFile, writePlanFile } from '../composables/usePlanFile'
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

onMounted(loadContent)
watch(() => props.relPath, loadContent)

// Parsed plan derived from rawContent.
const parsed = computed(() => (rawContent.value ? parsePlanFile(rawContent.value) : null))

// Map section heading to its phase prefix for grouping todos.
function sectionPrefix(heading: string): string {
  const m = heading.match(/Phase\s+([A-Za-z])/i)
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

async function toggleTodo(todoId: string): Promise<void> {
  const plan = parsed.value
  if (!plan) return

  const updatedTodos = plan.todos.map((t) =>
    t.id === todoId ? { ...t, status: STATUS_CYCLE[t.status] } : t
  )
  const updatedPlan = { ...plan, todos: updatedTodos }
  const newRaw = writePlanFile(updatedPlan, rawContent.value)

  // Write to disk.
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      content: newRaw,
    })
    if (!resp.payload?.ok) {
      toast(resp.payload?.error ?? 'Save failed')
      return
    }
    rawContent.value = newRaw
    toast('Saved', { type: 'success' })
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Save failed')
  }
}

// Badge config per status.
function badgeLabel(status: TodoStatus): string {
  return status
}
function badgeClass(status: TodoStatus): string {
  if (status === 'done') return 'pfv-badge pfv-badge--done'
  if (status === 'in-progress') return 'pfv-badge pfv-badge--in-progress'
  return 'pfv-badge pfv-badge--pending'
}
</script>

<template>
  <div class="pfv">
    <div v-if="loading" class="pfv-loading">Loading…</div>

    <div v-else-if="loadError" class="pfv-error">{{ loadError }}</div>

    <template v-else-if="parsed">
      <!-- Header -->
      <div class="pfv-header">
        <div class="pfv-title">{{ parsed.name }}</div>
        <div v-if="parsed.overview" class="pfv-overview">{{ parsed.overview }}</div>
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
            {{ todo.status === 'done' ? '☑' : '☐' }}
          </span>
          <span class="pfv-todo-content">{{ todo.content }}</span>
          <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
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
            {{ todo.status === 'done' ? '☑' : '☐' }}
          </span>
          <span class="pfv-todo-content">{{ todo.content }}</span>
          <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
        </div>
      </div>

      <div v-if="groups.length === 0 && parsed.todos.length === 0" class="pfv-empty">
        No tasks defined in this plan.
      </div>
    </template>

    <!-- Fallback: not a valid plan file -->
    <div v-else class="pfv-invalid">
      <div class="pfv-invalid-msg">
        Could not parse plan frontmatter. Switch to Raw view to edit.
      </div>
    </div>
  </div>
</template>

<style scoped>
.pfv {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  font-size: 13px;
  color: var(--color-fg, #cdd6f4);
  background: var(--color-bg, #1e1e2e);
  font-family: var(--font-ui, system-ui, sans-serif);
}

.pfv-loading,
.pfv-error {
  color: var(--color-fg-muted, #a6adc8);
  padding: 20px 0;
  font-style: italic;
}

.pfv-error {
  color: var(--color-error, #f38ba8);
}

.pfv-header {
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--color-border, #313244);
}

.pfv-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.pfv-overview {
  color: var(--color-fg-muted, #a6adc8);
  font-size: 12px;
  line-height: 1.5;
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
  color: var(--color-fg-muted, #a6adc8);
}

.pfv-group-dot {
  color: var(--color-accent, #89b4fa);
  font-size: 10px;
}

.pfv-group-title {
  flex: 1;
  color: var(--color-fg, #cdd6f4);
}

.pfv-group-progress {
  font-size: 11px;
  color: var(--color-fg-muted, #a6adc8);
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
  background: var(--color-hover, rgba(255, 255, 255, 0.05));
}

.pfv-checkbox {
  font-size: 15px;
  flex-shrink: 0;
  user-select: none;
  color: var(--color-fg-muted, #a6adc8);
}

.pfv-checkbox--checked {
  color: var(--color-success, #a6e3a1);
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
  background: rgba(166, 173, 200, 0.15);
  color: #a6adc8;
}

.pfv-badge--in-progress {
  background: rgba(250, 179, 135, 0.15);
  color: #fab387;
}

.pfv-badge--done {
  background: rgba(166, 227, 161, 0.15);
  color: #a6e3a1;
}

.pfv-empty {
  color: var(--color-fg-muted, #a6adc8);
  font-style: italic;
  padding: 20px 0;
}

.pfv-invalid {
  padding: 20px 0;
}

.pfv-invalid-msg {
  color: #fab387;
  font-style: italic;
}
</style>
