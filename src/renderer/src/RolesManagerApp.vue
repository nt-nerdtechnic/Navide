<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useBackend } from './composables/useBackend'
import { useNotify } from './composables/useNotify'
import NotificationHost from './components/NotificationHost.vue'
import { useRoles, type Role } from './composables/useRoles'

const backend = useBackend()
const rolesApi = useRoles(backend)
const notify = useNotify()

interface DraftRole {
  key: string
  label: string
  one_line: string
  system_prompt: string
  isNew: boolean
  originalKey: string
}

const selectedKey = ref<string | null>(null)
const draft = ref<DraftRole | null>(null)
const saving = ref(false)
const confirmingDelete = ref(false)
const confirmingReset = ref(false)

// ────────────────── Export / Import ──────────────────

interface ImportPreview {
  rolesIn: Role[]
  newKeys: string[]
  overwriteKeys: string[]
  filePath: string
  replaceAll: boolean
}
const importing = ref(false)
const importPreview = ref<ImportPreview | null>(null)
const importBusy = ref(false)
const exportBusy = ref(false)

interface ExportEnvelope {
  format_version: number
  exported_at: string
  exported_by: string
  roles: Role[]
}

async function exportRoles(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  exportBusy.value = true
  try {
    const envelope: ExportEnvelope = {
      format_version: 1,
      exported_at: new Date().toISOString(),
      exported_by: `${window.agentTeam?.appName ?? 'Agent-Team'} ${window.agentTeam?.version ?? ''}`.trim(),
      roles: rolesApi.roles.value
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await window.agentTeam.saveJson({
      title: 'Export roles',
      defaultName: `agent-team-roles-${stamp}.json`,
      content: JSON.stringify(envelope, null, 2)
    })
    if (result.ok) {
      notify.toast(`Exported ${envelope.roles.length} role(s) → ${result.path}`, { type: 'success' })
    } else if (result.error) {
      notify.toast(`Export failed: ${result.error}`, { type: 'error' })
    }
  } finally {
    exportBusy.value = false
  }
}

function validateRoleEntry(r: unknown): Role | null {
  if (typeof r !== 'object' || r === null) return null
  const obj = r as Record<string, unknown>
  if (typeof obj.key !== 'string' || !obj.key.trim()) return null
  if (typeof obj.label !== 'string') return null
  if (typeof obj.system_prompt !== 'string') return null
  return {
    key: String(obj.key).trim(),
    label: String(obj.label),
    one_line: typeof obj.one_line === 'string' ? obj.one_line : '',
    system_prompt: String(obj.system_prompt),
    is_default: obj.is_default === true
  }
}

async function startImport(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  importing.value = true
  try {
    const result = await window.agentTeam.openJson({ title: 'Import roles JSON' })
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
      : Array.isArray((parsed as { roles?: unknown[] })?.roles)
        ? (parsed as { roles: unknown[] }).roles
        : []
    if (raw.length === 0) {
      notify.toast('No roles found in file (expected an array or { roles: [...] })', { type: 'error' })
      return
    }
    const rolesIn: Role[] = []
    const invalid: number[] = []
    raw.forEach((entry, i) => {
      const r = validateRoleEntry(entry)
      if (r) rolesIn.push(r)
      else invalid.push(i)
    })
    if (rolesIn.length === 0) {
      notify.toast(`All ${raw.length} entries invalid — each role needs key, label, system_prompt`, { type: 'error' })
      return
    }
    const existing = new Set(rolesApi.roles.value.map((r) => r.key))
    const overwriteKeys = rolesIn.filter((r) => existing.has(r.key)).map((r) => r.key)
    const newKeys = rolesIn.filter((r) => !existing.has(r.key)).map((r) => r.key)
    importPreview.value = {
      rolesIn,
      newKeys,
      overwriteKeys,
      filePath: result.path ?? '',
      replaceAll: false
    }
    if (invalid.length > 0) {
      notify.toast(`Skipped ${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'}`, { type: 'info' })
    }
  } finally {
    importing.value = false
  }
}

function cancelImport(): void {
  importPreview.value = null
}

async function applyImport(): Promise<void> {
  if (!importPreview.value) return
  importBusy.value = true
  const { rolesIn, replaceAll, filePath } = importPreview.value
  try {
    // Replace all: delete every existing role NOT in the import set first.
    if (replaceAll) {
      const incoming = new Set(rolesIn.map((r) => r.key))
      const toDelete = rolesApi.roles.value.map((r) => r.key).filter((k) => !incoming.has(k))
      for (const key of toDelete) {
        if (rolesApi.roles.value.length <= 1) break // backend rejects deleting last role
        await rolesApi.remove(key)
      }
    }
    let ok = 0
    let failed = 0
    for (const role of rolesIn) {
      const created = await rolesApi.upsert({
        key: role.key,
        label: role.label,
        one_line: role.one_line,
        system_prompt: role.system_prompt
      })
      if (created) ok++
      else failed++
    }
    importPreview.value = null
    const fileNote = filePath ? ` from ${filePath}` : ''
    const summary =
      `Imported ${ok} role(s)${fileNote}` +
      (failed ? ` · ${failed} failed` : '') +
      (replaceAll ? ' · replaced all' : '')
    notify.toast(summary, { type: failed ? 'info' : 'success' })
  } catch (err) {
    notify.toast(`Import failed: ${String((err as Error).message ?? err)}`, { type: 'error' })
  } finally {
    importBusy.value = false
  }
}

const sorted = computed(() => [...rolesApi.roles.value].sort((a, b) => a.label.localeCompare(b.label)))

watch(
  () => rolesApi.roles.value,
  (rs) => {
    if (rs.length > 0 && selectedKey.value === null) {
      selectKey(rs[0].key)
    } else if (selectedKey.value && !rs.find((r) => r.key === selectedKey.value)) {
      selectKey(rs[0]?.key ?? null)
    } else if (
      selectedKey.value &&
      draft.value &&
      !draft.value.isNew &&
      draft.value.originalKey === selectedKey.value
    ) {
      // External edit (e.g. from another window) — refresh draft from server unless dirty.
      const fresh = rs.find((r) => r.key === selectedKey.value)
      if (fresh && !isDirty.value) {
        draft.value = fromRole(fresh, false)
      }
    }
  },
  { deep: false }
)

function fromRole(r: Role, isNew: boolean): DraftRole {
  return {
    key: r.key,
    label: r.label,
    one_line: r.one_line,
    system_prompt: r.system_prompt,
    isNew,
    originalKey: isNew ? '' : r.key
  }
}

function selectKey(key: string | null): void {
  selectedKey.value = key
  if (key === null) {
    draft.value = null
    return
  }
  const r = rolesApi.find(key)
  if (r) draft.value = fromRole(r, false)
}

function startNew(): void {
  selectedKey.value = null
  draft.value = {
    key: '',
    label: '',
    one_line: '',
    system_prompt: '# Role: \n你是一位...\n\n# Guidelines:\n1. ...\n\n# Output Format:\n...',
    isNew: true,
    originalKey: ''
  }
}

const isDirty = computed(() => {
  if (!draft.value) return false
  if (draft.value.isNew) return true
  const r = rolesApi.find(draft.value.originalKey)
  if (!r) return true
  return (
    r.label !== draft.value.label ||
    r.one_line !== draft.value.one_line ||
    r.system_prompt !== draft.value.system_prompt ||
    r.key !== draft.value.key
  )
})

const canSave = computed(() => {
  if (!draft.value) return false
  if (!draft.value.key.trim() || !draft.value.label.trim() || !draft.value.system_prompt.trim()) return false
  if (draft.value.isNew && rolesApi.find(draft.value.key.trim())) return false
  return isDirty.value
})

async function save(): Promise<void> {
  if (!draft.value || !canSave.value) return
  saving.value = true
  const payload = {
    key: draft.value.key.trim(),
    label: draft.value.label.trim(),
    one_line: draft.value.one_line.trim(),
    system_prompt: draft.value.system_prompt
  }
  // Key change on existing role: delete old + create new.
  const wasRename =
    !draft.value.isNew && draft.value.originalKey && draft.value.originalKey !== payload.key
  try {
    if (wasRename) {
      const role = await rolesApi.upsert(payload)
      if (role) {
        await rolesApi.remove(draft.value.originalKey)
        selectKey(role.key)
      }
    } else {
      const role = await rolesApi.upsert(payload)
      if (role) selectKey(role.key)
    }
  } catch (err) {
    notify.toast(String((err as Error).message ?? err), { type: 'error' })
  } finally {
    saving.value = false
  }
}

async function doDelete(): Promise<void> {
  if (!draft.value || draft.value.isNew) {
    confirmingDelete.value = false
    return
  }
  const ok = await rolesApi.remove(draft.value.originalKey || draft.value.key)
  confirmingDelete.value = false
  if (ok) {
    selectKey(sorted.value[0]?.key ?? null)
  } else {
    notify.toast(rolesApi.error.value, { type: 'error' })
  }
}

async function doReset(): Promise<void> {
  const ok = await rolesApi.reset()
  confirmingReset.value = false
  if (ok) selectKey(sorted.value[0]?.key ?? null)
}

const statusColor = computed(() => {
  switch (backend.status.value) {
    case 'connected':
      return '#3fb950'
    case 'connecting':
    case 'starting':
      return '#d29922'
    case 'disconnected':
      return '#8b949e'
    default:
      return '#f85149'
  }
})
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="title">🎭 Role Manager</div>
      <div class="meta">
        <span class="dot" :style="{ background: statusColor }"></span>
        <span>backend {{ backend.status.value }}</span>
        <span v-if="rolesApi.path.value" class="path" :title="rolesApi.path.value">
          · {{ rolesApi.path.value }}
        </span>
      </div>
      <div class="toolbar">
        <button class="ghost" :disabled="exportBusy" @click="exportRoles">
          {{ exportBusy ? '…' : '⬇ Export JSON' }}
        </button>
        <button class="ghost" :disabled="importing" @click="startImport">
          {{ importing ? '…' : '⬆ Import JSON' }}
        </button>
        <button class="ghost danger-link" @click="confirmingReset = true">↺ Reset to defaults</button>
      </div>
    </header>

    <div class="body">
      <aside class="list">
        <button class="primary new-btn" @click="startNew">+ New role</button>
        <ul>
          <li
            v-for="r in sorted"
            :key="r.key"
            :class="{ active: selectedKey === r.key && draft && !draft.isNew }"
            @click="selectKey(r.key)"
          >
            <div class="row">
              <span class="key">{{ r.key }}</span>
              <span v-if="r.is_default" class="badge">default</span>
            </div>
            <div class="label">{{ r.label }}</div>
            <div class="one">{{ r.one_line }}</div>
          </li>
        </ul>
      </aside>

      <section v-if="draft" class="detail">
        <div class="form-header">
          <h2>{{ draft.isNew ? 'New role' : 'Edit role' }}</h2>
          <div class="actions">
            <button v-if="!draft.isNew" class="danger" @click="confirmingDelete = true">
              🗑 Delete
            </button>
            <button class="primary" :disabled="!canSave || saving" @click="save">
              {{ saving ? 'Saving…' : draft.isNew ? 'Create' : 'Save' }}
            </button>
          </div>
        </div>

        <div class="grid">
          <div>
            <label>Key</label>
            <input
              v-model="draft.key"
              type="text"
              placeholder="lowercase, letters/digits/_-, max 32"
              spellcheck="false"
              autocorrect="off"
              :disabled="!draft.isNew && draft.originalKey === 'pm'"
            />
            <p v-if="draft.isNew && rolesApi.find(draft.key.trim())" class="warn">
              key already exists
            </p>
          </div>
          <div>
            <label>Label</label>
            <input
              v-model="draft.label"
              type="text"
              placeholder="e.g. Tech Lead"
              spellcheck="false"
            />
          </div>
        </div>

        <label>One-line summary</label>
        <input
          v-model="draft.one_line"
          type="text"
          placeholder="short hint shown in the sidebar dropdown"
          spellcheck="false"
        />

        <label>System prompt</label>
        <textarea
          v-model="draft.system_prompt"
          rows="18"
          placeholder="Full role system prompt — injected into the CLI on spawn"
          spellcheck="false"
        ></textarea>

        <p class="hint">
          Char count: {{ draft.system_prompt.length }} ·
          Changes apply to <strong>new spawns</strong> only; running agents keep their previous prompt.
        </p>
      </section>
      <section v-else class="detail empty">
        <p>Select a role on the left or click <strong>+ New role</strong>.</p>
      </section>
    </div>

    <div v-if="confirmingDelete" class="modal" @click.self="confirmingDelete = false">
      <div class="modal-card">
        <h3>Delete role "{{ draft?.label }}"?</h3>
        <p>
          This removes the role from the persisted registry. Stages using this role's key as
          <code>defaultRole</code> will fall back to whatever happens to match at runtime.
        </p>
        <div class="modal-actions">
          <button class="ghost" @click="confirmingDelete = false">Cancel</button>
          <button class="danger" @click="doDelete">Delete</button>
        </div>
      </div>
    </div>

    <div v-if="confirmingReset" class="modal" @click.self="confirmingReset = false">
      <div class="modal-card">
        <h3>Reset all roles to factory defaults?</h3>
        <p>
          All custom roles will be removed and the original 5 (PM / Backend / Frontend / Mobile / QA)
          will be restored. This is destructive and cannot be undone.
        </p>
        <div class="modal-actions">
          <button class="ghost" @click="confirmingReset = false">Cancel</button>
          <button class="danger" @click="doReset">Reset</button>
        </div>
      </div>
    </div>

    <div v-if="importPreview" class="modal" @click.self="cancelImport">
      <div class="modal-card wide">
        <h3>Import roles</h3>
        <p v-if="importPreview.filePath" class="filepath">{{ importPreview.filePath }}</p>
        <ul class="import-stats">
          <li><strong>{{ importPreview.rolesIn.length }}</strong> role(s) in file</li>
          <li><span class="tag new">+{{ importPreview.newKeys.length }}</span> new keys</li>
          <li><span class="tag overwrite">↻{{ importPreview.overwriteKeys.length }}</span> overwrite existing</li>
        </ul>
        <details v-if="importPreview.newKeys.length > 0" class="import-detail">
          <summary>New keys ({{ importPreview.newKeys.length }})</summary>
          <code>{{ importPreview.newKeys.join(', ') }}</code>
        </details>
        <details v-if="importPreview.overwriteKeys.length > 0" class="import-detail">
          <summary>Will overwrite ({{ importPreview.overwriteKeys.length }})</summary>
          <code>{{ importPreview.overwriteKeys.join(', ') }}</code>
        </details>
        <label class="checkbox-row">
          <input v-model="importPreview.replaceAll" type="checkbox" />
          <span>
            <strong>Replace all</strong> — delete current roles NOT in the import file
            <span class="muted">(destructive; backend will refuse to remove the last role)</span>
          </span>
        </label>
        <div class="modal-actions">
          <button class="ghost" :disabled="importBusy" @click="cancelImport">Cancel</button>
          <button class="primary" :disabled="importBusy" @click="applyImport">
            {{ importBusy ? 'Importing…' : importPreview.replaceAll ? 'Replace & Import' : 'Merge & Import' }}
          </button>
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
  background: #010409;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  overflow: hidden;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #0d1117;
  border-bottom: 1px solid #21262d;
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
  color: #8b949e;
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
.body {
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 0;
}
.list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid #21262d;
  background: #0d1117;
  overflow-y: auto;
}
.new-btn {
  margin: 10px;
}
.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  padding: 10px 14px;
  border-bottom: 1px solid #161b22;
  cursor: pointer;
}
.list li:hover {
  background: #161b22;
}
.list li.active {
  background: #1f3a5f;
}
.list .row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.key {
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  color: #79c0ff;
}
.badge {
  background: #21262d;
  color: #8b949e;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
}
.list .label {
  font-weight: 600;
  margin-top: 2px;
}
.list .one {
  color: #8b949e;
  font-size: 11px;
  margin-top: 2px;
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
  color: #6e7681;
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
  color: #8b949e;
  margin-top: 4px;
}
input[type='text'],
textarea {
  background: #161b22;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 8px 10px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  box-sizing: border-box;
  width: 100%;
}
textarea {
  font-family: Menlo, Monaco, monospace;
  resize: vertical;
  min-height: 280px;
  line-height: 1.5;
}
input:focus,
textarea:focus {
  outline: none;
  border-color: #1f6feb;
}
input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.grid > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
button {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
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
  background: #238636;
  border-color: #2ea043;
  color: #fff;
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: #2ea043;
}
button.danger {
  background: #6f1f1f;
  border-color: #8a2929;
  color: #f4d2d2;
}
button.danger:hover {
  background: #8a2929;
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: #21262d;
}
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
.danger-link {
  color: #f85149;
}
.hint {
  color: #8b949e;
  font-size: 11px;
  margin: 4px 0 0;
}
.warn {
  color: #d29922;
  font-size: 11px;
  margin: 4px 0 0;
}
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px 22px;
  max-width: 460px;
}
.modal-card.wide {
  max-width: 560px;
}
.filepath {
  margin: -6px 0 12px;
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  color: #8b949e;
  word-break: break-all;
}
.import-stats {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.import-stats li {
  font-size: 12px;
}
.tag {
  display: inline-block;
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  margin-right: 6px;
}
.tag.new {
  background: #1f6f43;
  color: #d2f4dc;
}
.tag.overwrite {
  background: #6f5b1f;
  color: #f4ecd2;
}
.import-detail {
  margin-bottom: 8px;
  font-size: 11px;
  color: #c9d1d9;
}
.import-detail summary {
  cursor: pointer;
  color: #58a6ff;
  margin-bottom: 4px;
}
.import-detail code {
  display: block;
  background: #010409;
  padding: 6px 8px;
  border-radius: 3px;
  font-size: 10px;
  word-break: break-all;
}
.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.checkbox-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  accent-color: #d29922;
}
.checkbox-row strong {
  color: #d29922;
}
.muted {
  color: #6e7681;
  font-size: 11px;
}
.modal-card h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.modal-card p {
  font-size: 12px;
  color: #c9d1d9;
  margin: 0 0 14px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
