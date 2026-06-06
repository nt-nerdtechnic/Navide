<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useBackend } from './composables/useBackend'
import { useNotify } from './composables/useNotify'
import { useKeybindings } from './keybindings/useKeybindings'
import { useTheme } from './composables/useTheme'
import NotificationHost from './components/NotificationHost.vue'
import { useStages } from './composables/useStages'
import { stageToBackend, type AgentKey, type Stage, type StageSlot } from './data/stages'

const backend = useBackend()
const stagesApi = useStages(backend)
const notify = useNotify()
useKeybindings()
useTheme().loadTheme()

const AGENT_OPTIONS: { key: AgentKey; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini CLI' }
]

// ── State ──────────────────────────────────────────────────────────────────

const selectedId = ref<string | null>(null)
const draft = ref<Stage | null>(null)
const isNew = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const confirmingReset = ref(false)

// Per-slot form state for the "Add Slot" inline form
const addingSlot = ref(false)
const slotDraft = ref<StageSlot>({
  agentKey: 'claude',
  roleKey: '',
  label: '',
  kickoffBody: ''
})

// ── Derived ────────────────────────────────────────────────────────────────

const isDirty = computed(() => {
  if (!draft.value) return false
  if (isNew.value) return true
  const orig = stagesApi.stages.value.find((s) => s.id === draft.value!.id)
  if (!orig) return true
  return JSON.stringify(stageToBackend(draft.value)) !== JSON.stringify(stageToBackend(orig))
})

const canSave = computed(() => {
  if (!draft.value) return false
  if (!draft.value.id.trim() || !draft.value.title.trim()) return false
  if (isNew.value && stagesApi.stages.value.find((s) => s.id === draft.value!.id.trim())) return false
  return isDirty.value
})

// ── Selection ──────────────────────────────────────────────────────────────

watch(
  () => stagesApi.stages.value,
  (ss) => {
    if (ss.length > 0 && selectedId.value === null) {
      selectStage(ss[0].id)
    } else if (selectedId.value && !ss.find((s) => s.id === selectedId.value)) {
      selectStage(ss[0]?.id ?? null)
    }
  },
  { deep: false }
)

function selectStage(id: string | null): void {
  selectedId.value = id
  addingSlot.value = false
  if (id === null) {
    draft.value = null
    return
  }
  const s = stagesApi.stages.value.find((s) => s.id === id)
  if (s) {
    draft.value = JSON.parse(JSON.stringify(s))
    isNew.value = false
  }
}

function startNew(): void {
  selectedId.value = null
  addingSlot.value = false
  isNew.value = true
  draft.value = {
    id: '',
    title: '',
    shortTitle: '',
    question: '',
    description: '',
    recommendedRoles: [],
    sentinel: '',
    allowQuestions: false,
    slots: []
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  if (!draft.value || !canSave.value) return
  saving.value = true
  const savedTitle = draft.value.title
  const savedId = draft.value.id.trim()
  try {
    const payload = stageToBackend({ ...draft.value, id: savedId })
    const resp = await backend.send<{ stage: Record<string, unknown> }>('stages.upsert', {
      stage: payload
    })
    if (!resp.ok || !resp.payload) {
      notify.toast(resp.error?.message ?? 'Save failed', { type: 'error' })
      return
    }
    notify.toast(`Saved stage "${savedTitle}"`, { type: 'success' })
    isNew.value = false
    selectStage(savedId)
  } finally {
    saving.value = false
  }
}

async function doDelete(): Promise<void> {
  if (!draft.value || isNew.value) {
    confirmingDelete.value = false
    return
  }
  const id = draft.value.id
  const resp = await backend.send<{ stages: unknown[] }>('stages.delete', { id })
  confirmingDelete.value = false
  if (!resp.ok) {
    notify.toast(resp.error?.message ?? 'Delete failed', { type: 'error' })
    return
  }
  notify.toast(`Deleted stage "${id}"`, { type: 'success' })
  selectStage(stagesApi.stages.value[0]?.id ?? null)
}

async function doReset(): Promise<void> {
  const resp = await backend.send<{ stages: unknown[] }>('stages.reset', {})
  confirmingReset.value = false
  if (!resp.ok) {
    notify.toast(resp.error?.message ?? 'Reset failed', { type: 'error' })
    return
  }
  notify.toast('Reset to factory defaults', { type: 'success' })
  selectStage(stagesApi.stages.value[0]?.id ?? null)
}

async function moveUp(index: number): Promise<void> {
  if (index <= 0) return
  const ids = stagesApi.stages.value.map((s) => s.id)
  ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
  await backend.send('stages.reorder', { ids })
}

async function moveDown(index: number): Promise<void> {
  if (index >= stagesApi.stages.value.length - 1) return
  const ids = stagesApi.stages.value.map((s) => s.id)
  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
  await backend.send('stages.reorder', { ids })
}

// ── Slots ──────────────────────────────────────────────────────────────────

function startAddSlot(): void {
  addingSlot.value = true
  slotDraft.value = { agentKey: 'claude', roleKey: '', label: '', kickoffBody: '' }
}

function cancelAddSlot(): void {
  addingSlot.value = false
}

function confirmAddSlot(): void {
  if (!draft.value) return
  if (!slotDraft.value.label.trim()) return
  if (!draft.value.slots) draft.value.slots = []
  draft.value.slots.push({ ...slotDraft.value })
  addingSlot.value = false
}

function removeSlot(index: number): void {
  if (!draft.value?.slots) return
  draft.value.slots.splice(index, 1)
}

// ── Export / Import ────────────────────────────────────────────────────────

const exportBusy = ref(false)
const importing = ref(false)

async function exportStages(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  exportBusy.value = true
  try {
    const envelope = {
      format_version: 1,
      exported_at: new Date().toISOString(),
      exported_by: `${window.agentTeam?.appName ?? 'Agent-Team'} ${window.agentTeam?.version ?? ''}`.trim(),
      stages: stagesApi.stages.value
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await window.agentTeam.saveJson({
      title: 'Export stages',
      defaultName: `agent-team-stages-${stamp}.json`,
      content: JSON.stringify(envelope, null, 2)
    })
    if (result.ok) {
      notify.toast(`Exported ${envelope.stages.length} stage(s) → ${result.path}`, { type: 'success' })
    } else if (result.error) {
      notify.toast(`Export failed: ${result.error}`, { type: 'error' })
    }
  } finally {
    exportBusy.value = false
  }
}

async function importStages(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  importing.value = true
  try {
    const result = await window.agentTeam.openJson({ title: 'Import stages JSON' })
    if (!result.ok || !result.content) {
      if (result.error) notify.toast(`Import failed: ${result.error}`, { type: 'error' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.content)
    } catch (err) {
      notify.toast(`Invalid JSON: ${(err as Error).message}`, { type: 'error' })
      return
    }
    const raw: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { stages?: unknown[] })?.stages)
        ? (parsed as { stages: unknown[] }).stages
        : []
    if (raw.length === 0) {
      notify.toast('No stages found in file', { type: 'error' })
      return
    }
    let ok = 0
    let failed = 0
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) { failed++; continue }
      const s = entry as Record<string, unknown>
      if (!s.id) { failed++; continue }
      const resp = await backend.send('stages.upsert', { stage: s })
      if (resp.ok) ok++
      else failed++
    }
    notify.toast(`Imported ${ok} stage(s)` + (failed ? ` · ${failed} failed` : ''), {
      type: failed ? 'info' : 'success'
    })
  } finally {
    importing.value = false
  }
}

// ── Status dot ─────────────────────────────────────────────────────────────

const statusClass = computed(() => {
  switch (backend.status.value) {
    case 'connected': return 'status-connected'
    case 'connecting':
    case 'starting': return 'status-starting'
    case 'disconnected': return 'status-disconnected'
    default: return 'status-error'
  }
})
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="title">⚙ Stage Manager</div>
      <div class="meta">
        <span class="dot" :class="statusClass"></span>
        <span>backend {{ backend.status.value }}</span>
        <span v-if="stagesApi.stagesPath.value" class="path" :title="stagesApi.stagesPath.value">
          · {{ stagesApi.stagesPath.value }}
        </span>
      </div>
      <div class="toolbar">
        <button class="ghost" :disabled="exportBusy" @click="exportStages">
          {{ exportBusy ? '…' : '⬇ Export JSON' }}
        </button>
        <button class="ghost" :disabled="importing" @click="importStages">
          {{ importing ? '…' : '⬆ Import JSON' }}
        </button>
        <button class="ghost danger-link" @click="confirmingReset = true">↺ Reset to defaults</button>
      </div>
    </header>


    <div class="body">
      <!-- Left: stage list -->
      <aside class="list">
        <button class="primary new-btn" @click="startNew">+ Add Stage</button>
        <ul>
          <li
            v-for="(s, idx) in stagesApi.stages.value"
            :key="s.id"
            :class="{ active: selectedId === s.id && draft && !isNew }"
            @click="selectStage(s.id)"
          >
            <div class="stage-row">
              <span class="stage-num">{{ idx + 1 }}</span>
              <span class="stage-title">{{ s.title }}</span>
              <div class="reorder-btns">
                <button class="icon-btn" :disabled="idx === 0" @click.stop="moveUp(idx)" title="Move up">↑</button>
                <button class="icon-btn" :disabled="idx === stagesApi.stages.value.length - 1" @click.stop="moveDown(idx)" title="Move down">↓</button>
                <button class="icon-btn danger-icon" @click.stop="() => { selectStage(s.id); confirmingDelete = true }" title="Delete">🗑</button>
              </div>
            </div>
            <div class="stage-pills">
              <span v-for="slot in s.slots" :key="slot.label" class="pill agent">
                {{ slot.agentKey }}<span v-if="slot.roleKey">·{{ slot.roleKey }}</span>
              </span>
            </div>
          </li>
        </ul>
      </aside>

      <!-- Right: editor -->
      <section v-if="draft" class="detail">
        <div class="form-header">
          <h2>{{ isNew ? 'New Stage' : 'Edit Stage' }}</h2>
          <div class="actions">
            <button v-if="!isNew" class="danger" @click="confirmingDelete = true">🗑 Delete</button>
            <button class="primary" :disabled="!canSave || saving" @click="save">
              {{ saving ? 'Saving…' : isNew ? 'Create' : 'Save' }}
            </button>
          </div>
        </div>

        <div class="grid-2">
          <div>
            <label>ID</label>
            <input v-model="draft.id" type="text" placeholder="e.g. 01" spellcheck="false" :disabled="!isNew" />
            <p v-if="isNew && draft.id && stagesApi.stages.value.find((s) => s.id === draft!.id.trim())" class="warn">ID already exists</p>
          </div>
          <div>
            <label>Short Title</label>
            <input v-model="draft.shortTitle" type="text" placeholder="e.g. Requirements" spellcheck="false" />
          </div>
        </div>

        <label>Title</label>
        <input v-model="draft.title" type="text" placeholder="e.g. 01 Requirement Analysis" spellcheck="false" />

        <label>Question</label>
        <input v-model="draft.question" type="text" placeholder="e.g. What to do / not do?" spellcheck="false" />

        <label>Description</label>
        <textarea v-model="draft.description" rows="4" placeholder="Brief description of what this stage does" spellcheck="false"></textarea>

        <div class="grid-2">
          <div>
            <label>Sentinel</label>
            <input v-model="draft.sentinel" type="text" placeholder="---SLUG-DONE---" spellcheck="false" />
          </div>
          <div class="checkbox-row" style="margin-top: 18px">
            <input id="allow-q" v-model="draft.allowQuestions" type="checkbox" />
            <label for="allow-q" style="text-transform: none; font-size: 12px">
              Allow questions
              <span class="muted">(enable for Stage 01 only)</span>
            </label>
          </div>
        </div>

        <!-- Parallel slots -->
        <div class="slots-section">
          <div class="slots-header">
            <span class="lbl">Parallel Slots ({{ draft.slots?.length ?? 0 }})</span>
            <button v-if="!addingSlot" class="ghost small" @click="startAddSlot">+ Add Slot</button>
          </div>

          <div v-if="draft.slots && draft.slots.length > 0" class="slot-list">
            <div v-for="(slot, si) in draft.slots" :key="si" class="slot-card">
              <div class="slot-head">
                <span class="pill agent">{{ slot.agentKey }}</span>
                <span class="pill role">{{ slot.roleKey }}</span>
                <strong>{{ slot.label }}</strong>
                <button class="icon-btn danger-icon" style="margin-left: auto" @click="removeSlot(si)" title="Remove slot">✕</button>
              </div>
              <pre class="slot-body">{{ slot.kickoffBody.slice(0, 200) }}{{ slot.kickoffBody.length > 200 ? '…' : '' }}</pre>
            </div>
          </div>
          <p v-else-if="!addingSlot" class="hint">No parallel slots — stage runs with a single agent.</p>

          <!-- Inline add-slot form -->
          <div v-if="addingSlot" class="slot-form">
            <div class="grid-2">
              <div>
                <label>Agent</label>
                <select v-model="slotDraft.agentKey">
                  <option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option>
                </select>
              </div>
              <div>
                <label>Role Key</label>
                <input v-model="slotDraft.roleKey" type="text" placeholder="e.g. backend" spellcheck="false" />
              </div>
            </div>
            <label>Label</label>
            <input v-model="slotDraft.label" type="text" placeholder="e.g. Backend" spellcheck="false" />
            <label>Kickoff Body</label>
            <textarea v-model="slotDraft.kickoffBody" rows="5" spellcheck="false" class="mono" placeholder="Stage-specific body (no INTERACTION_PROTOCOL prefix). Use {{task}}."></textarea>
            <div class="row tight" style="margin-top: 6px">
              <button class="ghost" @click="cancelAddSlot">Cancel</button>
              <button class="primary" :disabled="!slotDraft.label.trim()" @click="confirmAddSlot">Add</button>
            </div>
          </div>
        </div>
      </section>
      <section v-else class="detail empty">
        <p>Select a stage on the left or click <strong>+ Add Stage</strong>.</p>
      </section>
    </div>

    <!-- Delete confirm modal -->
    <div v-if="confirmingDelete" class="modal" @click.self="confirmingDelete = false">
      <div class="modal-card">
        <h3>Delete stage "{{ draft?.title }}"?</h3>
        <p>This removes the stage from the persisted registry. Running pipelines that reference this stage will skip it.</p>
        <div class="modal-actions">
          <button class="ghost" @click="confirmingDelete = false">Cancel</button>
          <button class="danger" @click="doDelete">Delete</button>
        </div>
      </div>
    </div>

    <!-- Reset confirm modal -->
    <div v-if="confirmingReset" class="modal" @click.self="confirmingReset = false">
      <div class="modal-card">
        <h3>Reset all stages to factory defaults?</h3>
        <p>All custom stages will be removed and the original 5 SDLC stages will be restored. This is destructive and cannot be undone.</p>
        <div class="modal-actions">
          <button class="ghost" @click="confirmingReset = false">Cancel</button>
          <button class="danger" @click="doReset">Reset</button>
        </div>
      </div>
    </div>
    <NotificationHost />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-inset);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  overflow: hidden;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}
.meta .path {
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.status-connected { background: var(--success-fg); }
.dot.status-starting { background: var(--attention-fg); }
.dot.status-disconnected { background: var(--text-secondary); }
.dot.status-error { background: var(--danger-fg); }
.toolbar {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}
.toolbar button {
  font-size: 11px;
  padding: 5px 10px;
}
.body {
  flex: 1;
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
}
.list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-muted);
  background: var(--bg-base);
  overflow-y: auto;
}
.new-btn {
  margin: 10px;
  flex-shrink: 0;
}
.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  padding: 8px 12px;
  border-bottom: 1px solid var(--bg-subtle);
  cursor: pointer;
}
.list li:hover {
  background: var(--bg-subtle);
}
.list li.active {
  background: var(--accent-subtle);
}
.stage-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.stage-num {
  font-size: 10px;
  color: var(--text-secondary);
  width: 16px;
  text-align: right;
  flex-shrink: 0;
}
.stage-title {
  font-size: 12px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reorder-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.icon-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.danger-icon {
  color: var(--danger-fg);
}
.stage-pills {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  margin-left: 22px;
}
.pill {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
}
.pill.agent {
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.pill.role {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}
.detail {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.detail.empty {
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.form-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.form-header h2 {
  margin: 0;
  font-size: 16px;
}
.form-header .actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  margin-top: 4px;
  display: block;
}
.lbl {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
input[type='text'],
select,
textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 8px 10px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  box-sizing: border-box;
  width: 100%;
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
textarea.mono {
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  min-height: 120px;
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.grid-2 > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.checkbox-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  accent-color: var(--attention-fg);
}
.muted {
  color: var(--text-muted);
  font-size: 11px;
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: var(--success-strong);
}
button.danger {
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-muted);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.small {
  font-size: 11px;
  padding: 4px 10px;
}
.danger-link {
  color: var(--danger-fg);
}
.hint {
  color: var(--text-secondary);
  font-size: 11px;
  margin: 0;
}
.warn {
  color: var(--attention-fg);
  font-size: 11px;
  margin: 4px 0 0;
}
.slots-section {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.slots-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.slot-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.slot-card {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 8px 10px;
}
.slot-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.slot-body {
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  color: var(--text-secondary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.slot-form {
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 10px;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.row.tight {
  gap: 4px;
}
.modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px 22px;
  max-width: 460px;
}
.modal-card h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.modal-card p {
  font-size: 12px;
  color: var(--text-primary);
  margin: 0 0 14px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
