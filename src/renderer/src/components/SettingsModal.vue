<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { useRoles } from '../composables/useRoles'
import type { useStages } from '../composables/useStages'
import type { useAnalyzer } from '../composables/useAnalyzer'
import { stageToBackend, type Stage, type StageSlot } from '../data/stages'
import { MCP_CATALOG, isMcpInstalled, type McpCatalogEntry } from '../data/mcpCatalog'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  rolesApi: ReturnType<typeof useRoles>
  stagesApi: ReturnType<typeof useStages>
  analyzerApi: ReturnType<typeof useAnalyzer>
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ── Tab ───────────────────────────────────────────────────────────────────────
type Tab = 'roles' | 'stages' | 'mcp' | 'analyzer'
const activeTab = ref<Tab>('roles')

// Close on ESC
function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))

// ══════════════════════════════════════════════════════════════════════════════
// ROLES TAB
// ══════════════════════════════════════════════════════════════════════════════

interface DraftRole {
  key: string; label: string; one_line: string; system_prompt: string
  isNew: boolean; originalKey: string
}

const rSelectedKey = ref<string | null>(null)
const rDraft = ref<DraftRole | null>(null)
const rSaving = ref(false)
const rError = ref('')
const rConfirmDelete = ref(false)
const rConfirmReset = ref(false)
const rSummary = ref('')
const rImporting = ref(false)
const rExportBusy = ref(false)

const rSorted = computed(() =>
  [...props.rolesApi.roles.value].sort((a, b) => a.label.localeCompare(b.label))
)

watch(() => props.rolesApi.roles.value, (rs) => {
  if (rs.length > 0 && rSelectedKey.value === null) rSelectKey(rs[0].key)
  else if (rSelectedKey.value && !rs.find(r => r.key === rSelectedKey.value))
    rSelectKey(rs[0]?.key ?? null)
}, { deep: false })

function rFromRole(r: ReturnType<typeof props.rolesApi.find>, isNew: boolean): DraftRole {
  return { key: r!.key, label: r!.label, one_line: r!.one_line, system_prompt: r!.system_prompt, isNew, originalKey: isNew ? '' : r!.key }
}
function rSelectKey(key: string | null) {
  rSelectedKey.value = key; rError.value = ''
  if (!key) { rDraft.value = null; return }
  const r = props.rolesApi.find(key)
  if (r) rDraft.value = rFromRole(r, false)
}
function rStartNew() {
  rSelectedKey.value = null; rError.value = ''
  rDraft.value = { key: '', label: '', one_line: '', system_prompt: '# Role: \n你是一位...\n\n# Guidelines:\n1. ...\n\n# Output Format:\n...', isNew: true, originalKey: '' }
}

const rIsDirty = computed(() => {
  if (!rDraft.value) return false
  if (rDraft.value.isNew) return true
  const r = props.rolesApi.find(rDraft.value.originalKey)
  if (!r) return true
  return r.label !== rDraft.value.label || r.one_line !== rDraft.value.one_line || r.system_prompt !== rDraft.value.system_prompt || r.key !== rDraft.value.key
})
const rCanSave = computed(() => {
  if (!rDraft.value) return false
  if (!rDraft.value.key.trim() || !rDraft.value.label.trim() || !rDraft.value.system_prompt.trim()) return false
  if (rDraft.value.isNew && props.rolesApi.find(rDraft.value.key.trim())) return false
  return rIsDirty.value
})

async function rSave() {
  if (!rDraft.value || !rCanSave.value) return
  rSaving.value = true; rError.value = ''
  const payload = { key: rDraft.value.key.trim(), label: rDraft.value.label.trim(), one_line: rDraft.value.one_line.trim(), system_prompt: rDraft.value.system_prompt }
  const wasRename = !rDraft.value.isNew && rDraft.value.originalKey && rDraft.value.originalKey !== payload.key
  try {
    if (wasRename) {
      const role = await props.rolesApi.upsert(payload)
      if (role) { await props.rolesApi.remove(rDraft.value.originalKey); rSelectKey(role.key) }
    } else {
      const role = await props.rolesApi.upsert(payload)
      if (role) rSelectKey(role.key)
    }
    rSummary.value = `Saved "${payload.label}"`
  } catch (err) { rError.value = String((err as Error).message ?? err) }
  finally { rSaving.value = false }
}
async function rDoDelete() {
  if (!rDraft.value || rDraft.value.isNew) { rConfirmDelete.value = false; return }
  const ok = await props.rolesApi.remove(rDraft.value.originalKey || rDraft.value.key)
  rConfirmDelete.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else rError.value = props.rolesApi.error.value
}
async function rDoReset() {
  const ok = await props.rolesApi.reset()
  rConfirmReset.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
}
async function rExport() {
  if (!window.agentTeam?.saveJson) return
  rExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), roles: props.rolesApi.roles.value }
  const result = await window.agentTeam.saveJson({ title: 'Export roles', defaultName: `agent-team-roles-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) rSummary.value = `Exported ${envelope.roles.length} role(s)`
  rExportBusy.value = false
}
async function rImport() {
  if (!window.agentTeam?.openJson) return
  rImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import roles JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.roles) ? parsed.roles : [])
      let ok = 0
      for (const entry of raw) {
        const e = entry as Record<string, unknown>
        if (typeof e?.key === 'string' && e.key && typeof e.system_prompt === 'string')
          if (await props.rolesApi.upsert({ key: e.key as string, label: String(e.label ?? e.key), one_line: String(e.one_line ?? ''), system_prompt: e.system_prompt as string })) ok++
      }
      rSummary.value = `Imported ${ok} role(s)`
    } catch (err) { rError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  rImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGES TAB
// ══════════════════════════════════════════════════════════════════════════════

const AGENT_OPTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini CLI' }
]

const sSelectedId = ref<string | null>(null)
const sDraft = ref<Stage | null>(null)
const sIsNew = ref(false)
const sSaving = ref(false)
const sError = ref('')
const sConfirmDelete = ref(false)
const sConfirmReset = ref(false)
const sSummary = ref('')
const sExportBusy = ref(false)
const sImporting = ref(false)
const sAddingSlot = ref(false)
const sSlotDraft = ref<StageSlot>({ agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isManager: false })

const sIsDirty = computed(() => {
  if (!sDraft.value) return false
  if (sIsNew.value) return true
  const orig = props.stagesApi.stages.value.find(s => s.id === sDraft.value!.id)
  if (!orig) return true
  return JSON.stringify(stageToBackend(sDraft.value)) !== JSON.stringify(stageToBackend(orig))
})
const sCanSave = computed(() => {
  if (!sDraft.value || !sDraft.value.id.trim() || !sDraft.value.title.trim()) return false
  if (!sDraft.value.slots || sDraft.value.slots.length === 0) return false  // at least 1 slot required
  if (sIsNew.value && props.stagesApi.stages.value.find(s => s.id === sDraft.value!.id.trim())) return false
  return sIsDirty.value
})

watch(() => props.stagesApi.stages.value, (ss) => {
  if (ss.length > 0 && sSelectedId.value === null) sSelectStage(ss[0].id)
  else if (sSelectedId.value && !ss.find(s => s.id === sSelectedId.value)) sSelectStage(ss[0]?.id ?? null)
}, { deep: false })

function sSelectStage(id: string | null) {
  sSelectedId.value = id; sError.value = ''; sAddingSlot.value = false; sEditingSlotIndex.value = null
  if (!id) { sDraft.value = null; return }
  const s = props.stagesApi.stages.value.find(s => s.id === id)
  if (s) { sDraft.value = JSON.parse(JSON.stringify(s)); sIsNew.value = false }
}
function sStartNew() {
  sSelectedId.value = null; sError.value = ''; sAddingSlot.value = false; sIsNew.value = true
  sDraft.value = {
    id: '', title: '', shortTitle: '', question: '', description: '',
    recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '', slots: [],
  }
}
async function sSave() {
  if (!sDraft.value || !sCanSave.value) return
  sSaving.value = true; sError.value = ''
  try {
    const payload = stageToBackend({ ...sDraft.value, id: sDraft.value.id.trim() })
    const resp = await props.backend.send<{ stage: Record<string, unknown> }>('stages.upsert', { stage: payload })
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Save failed'; return }
    sSummary.value = `Saved "${sDraft.value.title}"`
    sSelectedId.value = sDraft.value.id.trim()
    sIsNew.value = false
    // Do NOT call sSelectStage here — it would reload draft from the stale
    // stages.value cache (before stages.changed broadcast arrives), overwriting
    // the values the user just saved.
  } finally { sSaving.value = false }
}
async function sDoDelete() {
  if (!sDraft.value || sIsNew.value) { sConfirmDelete.value = false; return }
  const resp = await props.backend.send<{ stages: unknown[] }>('stages.delete', { id: sDraft.value.id })
  sConfirmDelete.value = false
  if (!resp.ok) { sError.value = resp.error?.message ?? 'Delete failed'; return }
  sSummary.value = `Deleted "${sDraft.value.id}"`; sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
}
async function sDoReset() {
  const resp = await props.backend.send<{ stages: unknown[] }>('stages.reset', {})
  sConfirmReset.value = false
  if (!resp.ok) { sError.value = resp.error?.message ?? 'Reset failed'; return }
  sSummary.value = 'Reset to factory defaults'; sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
}
async function sMoveUp(index: number) {
  if (index <= 0) return
  const ids = props.stagesApi.stages.value.map(s => s.id)
  ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
  await props.backend.send('stages.reorder', { ids })
}
async function sMoveDown(index: number) {
  if (index >= props.stagesApi.stages.value.length - 1) return
  const ids = props.stagesApi.stages.value.map(s => s.id)
  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
  await props.backend.send('stages.reorder', { ids })
}
const sEditingSlotIndex = ref<number | null>(null)

function sStartAddSlot() {
  sAddingSlot.value = true
  sEditingSlotIndex.value = null
  sSlotDraft.value = { agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isManager: false }
}
function sCancelAddSlot() { sAddingSlot.value = false; sEditingSlotIndex.value = null }
async function sConfirmAddSlot() {
  if (!sDraft.value || !sSlotDraft.value.label.trim()) return
  if (!sDraft.value.slots) sDraft.value.slots = []
  sDraft.value.slots.push({ ...sSlotDraft.value })
  sAddingSlot.value = false
  await sSave()
}
function sStartEditSlot(index: number) {
  sEditingSlotIndex.value = index
  sAddingSlot.value = false
  sSlotDraft.value = { ...sDraft.value!.slots![index] }
}
async function sSaveEditSlot() {
  if (!sDraft.value?.slots || sEditingSlotIndex.value === null) return
  sDraft.value.slots[sEditingSlotIndex.value] = { ...sSlotDraft.value }
  sEditingSlotIndex.value = null
  await sSave()
}
async function sRemoveSlot(index: number) {
  if (!sDraft.value?.slots || sDraft.value.slots.length <= 1) return  // must keep at least one
  if (sEditingSlotIndex.value === index) sEditingSlotIndex.value = null
  sDraft.value.slots.splice(index, 1)
  await sSave()
}
async function sExport() {
  if (!window.agentTeam?.saveJson) return
  sExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), stages: props.stagesApi.stages.value }
  const result = await window.agentTeam.saveJson({ title: 'Export stages', defaultName: `agent-team-stages-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) sSummary.value = `Exported ${envelope.stages.length} stage(s)`
  sExportBusy.value = false
}
async function sImport() {
  if (!window.agentTeam?.openJson) return
  sImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import stages JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.stages) ? parsed.stages : [])
      let ok = 0, failed = 0
      for (const entry of raw) {
        const s = entry as Record<string, unknown>
        if (!s.id) { failed++; continue }
        const resp = await props.backend.send('stages.upsert', { stage: s })
        if (resp.ok) ok++; else failed++
      }
      sSummary.value = `Imported ${ok} stage(s)` + (failed ? ` · ${failed} failed` : '')
    } catch (err) { sError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  sImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP TAB
// ══════════════════════════════════════════════════════════════════════════════

interface McpTool { name: string; description: string }
interface McpServer {
  name: string; command: string; args: string[]
  env: Record<string, string>; enabled: boolean
  // Live fields (returned by backend, not saved):
  status?: 'connected' | 'error' | 'disabled' | 'unknown'
  tool_count?: number; tools?: McpTool[]
}
// CatalogEntry type alias (re-exported from mcpCatalog.ts)
type CatalogEntry = McpCatalogEntry

type MView = 'list' | 'catalog'
const mView = ref<MView>('list')
const mSearch = ref('')
const mServers = ref<McpServer[]>([])
const mLoading = ref(false)
const mSaving = ref(false)
const mError = ref('')
const mSummary = ref('')
const mConfigPath = ref('')
const mExpanded = ref<Set<string>>(new Set())   // servers with tools list open
const mExpandedEnv = ref<Set<string>>(new Set()) // servers with env editor open

const mFilteredCatalog = computed(() => {
  const q = mSearch.value.trim().toLowerCase()
  return q ? MCP_CATALOG.filter(c => c.name.includes(q) || c.label.toLowerCase().includes(q) || c.description.includes(q))
           : MCP_CATALOG
})

function mIsInstalled(name: string) {
  return isMcpInstalled(mServers.value.map(s => s.name), name)
}

async function mLoad() {
  mLoading.value = true; mError.value = ''
  try {
    const resp = await props.backend.send<{ servers: McpServer[]; path: string }>('mcp.list_servers', {})
    if (resp.ok && resp.payload) {
      mServers.value = resp.payload.servers
      mConfigPath.value = resp.payload.path ?? ''
    } else { mError.value = resp.error?.message ?? 'Load failed' }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mLoading.value = false }
}

async function mSave(silent = false) {
  mSaving.value = true; mError.value = ''
  // Strip live-only fields before sending
  const payload = mServers.value.map(({ name, command, args, env, enabled }) =>
    ({ name, command, args, env, enabled }))
  try {
    const resp = await props.backend.send<{ ok: boolean }>('mcp.save_servers', { servers: payload })
    if (resp.ok) { if (!silent) mSummary.value = '已儲存，MCPManager 重新啟動中…' }
    else mError.value = resp.error?.message ?? 'Save failed'
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mSaving.value = false }
}

async function mAddFromCatalog(entry: CatalogEntry) {
  if (mIsInstalled(entry.name)) return
  mServers.value.push({ name: entry.name, command: entry.command, args: [...entry.args], env: { ...entry.env }, enabled: true })
  await mSave(true)
  mView.value = 'list'
  // Auto-expand env editor if this server needs env vars filled
  if (entry.requiresEnv?.length) mExpandedEnv.value = new Set([...mExpandedEnv.value, entry.name])
  mSummary.value = `已加入 ${entry.label}`
}

async function mRemoveServer(idx: number) {
  const name = mServers.value[idx]?.name
  mServers.value.splice(idx, 1)
  if (name) { mExpanded.value.delete(name); mExpandedEnv.value.delete(name) }
  await mSave(true)
}

async function mToggleEnabled(srv: McpServer) {
  srv.enabled = !srv.enabled
  await mSave(true)
}

function mToggleTools(name: string) {
  const s = new Set(mExpanded.value)
  s.has(name) ? s.delete(name) : s.add(name)
  mExpanded.value = s
}

function mToggleEnv(name: string) {
  const s = new Set(mExpandedEnv.value)
  s.has(name) ? s.delete(name) : s.add(name)
  mExpandedEnv.value = s
}

function mEnvEntries(srv: McpServer): [string, string][] { return Object.entries(srv.env) }
function mSetEnvKey(srv: McpServer, oldKey: string, newKey: string) {
  const val = srv.env[oldKey] ?? ''
  delete srv.env[oldKey]; srv.env[newKey] = val
}
function mSetEnvVal(srv: McpServer, key: string, val: string) { srv.env[key] = val }
function mAddEnvEntry(srv: McpServer) { srv.env['NEW_KEY'] = '' }
function mDeleteEnvEntry(srv: McpServer, key: string) { delete srv.env[key] }
function mArgString(srv: McpServer) { return srv.args.join(' ') }
function mSetArgs(srv: McpServer, val: string) { srv.args = val.split(/\s+/).filter(Boolean) }

async function mOpenConfig() {
  if (mConfigPath.value) await (window as any).agentTeam.openPath(mConfigPath.value)
}

watch(activeTab, (tab) => { if (tab === 'mcp' && mServers.value.length === 0) mLoad() })
</script>

<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div class="s-overlay" @click.self="emit('close')">
      <div class="s-modal">

        <!-- Header -->
        <div class="s-header">
          <div class="s-tabs">
            <button :class="['s-tab', { active: activeTab === 'roles' }]" @click="activeTab = 'roles'">🎭 Roles</button>
            <button :class="['s-tab', { active: activeTab === 'stages' }]" @click="activeTab = 'stages'">⚙ Stages</button>
            <button :class="['s-tab', { active: activeTab === 'mcp' }]" @click="activeTab = 'mcp'">🔌 MCP</button>
            <button :class="['s-tab', { active: activeTab === 'analyzer' }]" @click="activeTab = 'analyzer'">🧠 Analyzer</button>
          </div>
          <button class="s-close" @click="emit('close')" title="關閉 (ESC)">✕</button>
        </div>

        <!-- ── ROLES TAB ─────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'roles'" class="s-body">
          <div class="tab-toolbar">
            <button class="ghost" :disabled="rExportBusy" @click="rExport">{{ rExportBusy ? '…' : '⬇ Export JSON' }}</button>
            <button class="ghost" :disabled="rImporting" @click="rImport">{{ rImporting ? '…' : '⬆ Import JSON' }}</button>
            <button class="ghost danger-link" @click="rConfirmReset = true">↺ Reset to defaults</button>
            <span v-if="rSummary" class="summary-ok">{{ rSummary }}</span>
          </div>
          <div class="split">
            <aside class="split-list">
              <button class="primary new-btn" @click="rStartNew">+ New role</button>
              <ul>
                <li v-for="r in rSorted" :key="r.key"
                    :class="{ active: rSelectedKey === r.key && rDraft && !rDraft.isNew }"
                    @click="rSelectKey(r.key)">
                  <div class="row-g"><span class="mono-key">{{ r.key }}</span><span v-if="r.is_default" class="badge">default</span></div>
                  <div class="item-label">{{ r.label }}</div>
                  <div class="item-sub">{{ r.one_line }}</div>
                </li>
              </ul>
            </aside>
            <section v-if="rDraft" class="split-detail">
              <div class="detail-head">
                <h3>{{ rDraft.isNew ? 'New role' : 'Edit role' }}</h3>
                <div class="row-g gap">
                  <button v-if="!rDraft.isNew" class="danger" @click="rConfirmDelete = true">🗑 Delete</button>
                  <button class="primary" :disabled="!rCanSave || rSaving" @click="rSave">{{ rSaving ? 'Saving…' : rDraft.isNew ? 'Create' : 'Save' }}</button>
                </div>
              </div>
              <p v-if="rError" class="err-msg">{{ rError }}</p>
              <div class="two-col">
                <div class="field">
                  <label class="lbl">Key</label>
                  <input v-model="rDraft.key" type="text" placeholder="lowercase_key" spellcheck="false" :disabled="!rDraft.isNew && rDraft.originalKey === 'pm'" />
                  <p v-if="rDraft.isNew && rolesApi.find(rDraft.key.trim())" class="warn-msg">key already exists</p>
                </div>
                <div class="field">
                  <label class="lbl">Label</label>
                  <input v-model="rDraft.label" type="text" placeholder="e.g. Tech Lead" spellcheck="false" />
                </div>
              </div>
              <div class="field">
                <label class="lbl">One-line summary</label>
                <input v-model="rDraft.one_line" type="text" placeholder="short hint shown in dropdown" spellcheck="false" />
              </div>
              <div class="field">
                <label class="lbl">System prompt</label>
                <textarea v-model="rDraft.system_prompt" rows="14" spellcheck="false"></textarea>
                <p class="hint-msg">{{ rDraft.system_prompt.length }} chars · Changes apply to new spawns only</p>
              </div>
            </section>
            <section v-else class="split-detail empty-detail"><p>Select a role or click + New role</p></section>
          </div>
        </div>

        <!-- ── STAGES TAB ────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'stages'" class="s-body">
          <div class="tab-toolbar">
            <button class="ghost" :disabled="sExportBusy" @click="sExport">{{ sExportBusy ? '…' : '⬇ Export JSON' }}</button>
            <button class="ghost" :disabled="sImporting" @click="sImport">{{ sImporting ? '…' : '⬆ Import JSON' }}</button>
            <button class="ghost danger-link" @click="sConfirmReset = true">↺ Reset to defaults</button>
            <span v-if="sSummary" class="summary-ok">{{ sSummary }}</span>
          </div>
          <div class="split">
            <aside class="split-list">
              <button class="primary new-btn" @click="sStartNew">+ Add Stage</button>
              <ul>
                <li v-for="(s, idx) in stagesApi.stages.value" :key="s.id"
                    :class="{ active: sSelectedId === s.id && !sIsNew }"
                    @click="sSelectStage(s.id)">
                  <div class="row-g spread">
                    <span class="mono-key">{{ s.id }}</span>
                    <div class="row-g gap">
                      <button class="icon-btn" @click.stop="sMoveUp(idx)" :disabled="idx === 0">▲</button>
                      <button class="icon-btn" @click.stop="sMoveDown(idx)" :disabled="idx === stagesApi.stages.value.length - 1">▼</button>
                    </div>
                  </div>
                  <div class="item-label">
                    {{ s.shortTitle }}
                    <span v-if="s.slots.some(sl => sl.isManager)" class="manager-badge" :title="`Manager: ${s.slots.find(sl => sl.isManager)?.label}`">🎯</span>
                  </div>
                  <div class="item-sub">
                    {{ s.slots.length === 1
                      ? `${s.slots[0].agentKey} · ${s.slots[0].roleKey}`
                      : `${s.slots.length} parallel slots` }}
                  </div>
                </li>
              </ul>
            </aside>
            <section v-if="sDraft" class="split-detail">
              <div class="detail-head">
                <h3>{{ sIsNew ? 'New stage' : 'Edit stage' }}</h3>
                <div class="row-g gap">
                  <button v-if="!sIsNew" class="danger" @click="sConfirmDelete = true">🗑 Delete</button>
                  <button class="primary" :disabled="!sCanSave || sSaving" @click="sSave">{{ sSaving ? 'Saving…' : sIsNew ? 'Create' : 'Save' }}</button>
                </div>
              </div>
              <p v-if="sError" class="err-msg">{{ sError }}</p>
              <div class="two-col">
                <div class="field"><label class="lbl">ID</label><input v-model="sDraft.id" type="text" placeholder="e.g. 04.5" spellcheck="false" :disabled="!sIsNew" /></div>
                <div class="field"><label class="lbl">Short title</label><input v-model="sDraft.shortTitle" type="text" placeholder="e.g. Review" spellcheck="false" /></div>
              </div>
              <div class="field"><label class="lbl">Full title</label><input v-model="sDraft.title" type="text" spellcheck="false" /></div>
              <div class="two-col">
                <div class="field"><label class="lbl">Sentinel</label><input v-model="sDraft.sentinel" type="text" placeholder="---DONE---" spellcheck="false" /></div>
                <div class="field">
                  <label class="lbl">Allow questions</label>
                  <label class="check-row"><input type="checkbox" v-model="sDraft.allowQuestions" /><span>Pause for user answers</span></label>
                </div>
              </div>
              <div class="field"><label class="lbl">Context7 doc query</label><input v-model="sDraft.docQuery" type="text" placeholder="e.g. security best practices, authentication" spellcheck="false" /></div>
              <!-- Slots (required — every stage needs at least one) -->
              <div class="slots-section">
                <div class="row-g spread">
                  <label class="lbl">Slots <span class="slot-required">* 必填至少一個</span></label>
                  <button class="ghost" @click="sStartAddSlot">+ Add slot</button>
                </div>
                <p v-if="!sDraft.slots?.length" class="warn-msg">請新增至少一個 slot 才能儲存。</p>
                <template v-for="(slot, i) in sDraft.slots" :key="i">
                  <!-- collapsed row -->
                  <div v-if="sEditingSlotIndex !== i" class="slot-item slot-clickable" @click="sStartEditSlot(i)">
                    <div class="row-g spread">
                      <span class="item-label">
                        {{ slot.label }}
                        <span v-if="slot.isManager" class="manager-badge">🎯 Manager</span>
                      </span>
                      <button class="ghost danger-link" @click.stop="sRemoveSlot(i)" :disabled="sDraft.slots.length <= 1" title="最後一個 slot 無法刪除">✕</button>
                    </div>
                    <div class="item-sub">{{ slot.agentKey }} · {{ slot.roleKey }}</div>
                  </div>
                  <!-- inline edit form -->
                  <div v-else class="slot-form">
                    <div class="two-col">
                      <div class="field"><label class="lbl">Label</label><input v-model="sSlotDraft.label" type="text" /></div>
                      <div class="field">
                        <label class="lbl">Agent</label>
                        <select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select>
                      </div>
                    </div>
                    <div class="field">
                      <label class="lbl">Role key</label>
                      <select v-model="sSlotDraft.roleKey">
                        <option value="">（未指定）</option>
                        <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                      </select>
                    </div>
                    <label class="check-row manager-toggle">
                      <input type="checkbox" v-model="sSlotDraft.isManager" />
                      <span><strong>🎯 指定為本階段 Manager</strong> — 此 slot 先完成自己的工作後印 <code>---MANAGER-READY---</code>，再開始控場（接收其他 slot 的 ASK/REPORT、發 DISPATCH，最後印 <code>---STAGE-DONE---</code> 收尾）。一階段最多一個 Manager；若多選，後端保留第一個。</span>
                    </label>
                    <div class="field"><label class="lbl">Kickoff body</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false"></textarea></div>
                    <div class="row-g gap">
                      <button class="ghost" @click="sCancelAddSlot">Cancel</button>
                      <button class="primary" @click="sSaveEditSlot">Save slot</button>
                    </div>
                  </div>
                </template>
                <div v-if="sAddingSlot" class="slot-form">
                  <div class="two-col">
                    <div class="field"><label class="lbl">Label</label><input v-model="sSlotDraft.label" type="text" /></div>
                    <div class="field">
                      <label class="lbl">Agent</label>
                      <select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select>
                    </div>
                  </div>
                  <div class="field">
                    <label class="lbl">Role key</label>
                    <select v-model="sSlotDraft.roleKey">
                      <option value="">（未指定）</option>
                      <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                    </select>
                  </div>
                  <label class="check-row manager-toggle">
                    <input type="checkbox" v-model="sSlotDraft.isManager" />
                    <span><strong>🎯 指定為本階段 Manager</strong> — 一階段最多一個。</span>
                  </label>
                  <div class="field"><label class="lbl">Kickoff body</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false"></textarea></div>
                  <div class="row-g gap">
                    <button class="ghost" @click="sCancelAddSlot">Cancel</button>
                    <button class="primary" @click="sConfirmAddSlot">Add</button>
                  </div>
                </div>
              </div>

            </section>
            <section v-else class="split-detail empty-detail"><p>Select a stage or click + Add Stage</p></section>
          </div>
        </div>

        <!-- ── MCP TAB ───────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'mcp'" class="s-body mcp-body">

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="mView === 'list'">
            <div class="mcp-topbar">
              <span class="mcp-page-title">Installed MCP Servers</span>
              <div class="mcp-topbar-actions">
                <button class="mcp-action-btn" @click="mView = 'catalog'">Add MCP +</button>
                <button class="mcp-action-btn" @click="mLoad" :disabled="mLoading">Refresh ↺</button>
                <button class="mcp-action-btn" @click="mOpenConfig" :disabled="!mConfigPath">Open MCP Config</button>
              </div>
            </div>
            <p v-if="mError" class="err-msg" style="margin:6px 16px 0">{{ mError }}</p>
            <span v-if="mSummary" class="mcp-summary-ok">{{ mSummary }}</span>

            <div class="mcp-server-list">
              <div v-if="mLoading" class="mcp-loading">載入中…</div>

              <div v-for="(srv, idx) in mServers" :key="srv.name" class="mcp-server-card">
                <!-- Main row -->
                <div class="mcp-server-row">
                  <span class="mcp-dot" :class="srv.status ?? 'unknown'"></span>
                  <span class="mcp-server-name">{{ srv.name }}</span>
                  <span class="mcp-spacer"></span>
                  <button class="mcp-delete-btn" @click="mRemoveServer(idx)" title="移除">🗑</button>
                  <!-- Toggle switch -->
                  <button class="mcp-toggle" :class="{ on: srv.enabled }" @click="mToggleEnabled(srv)" :title="srv.enabled ? '停用' : '啟用'">
                    <span class="mcp-toggle-thumb"></span>
                  </button>
                </div>

                <!-- Tools row (collapsible) -->
                <div v-if="(srv.tool_count ?? 0) > 0 || srv.status === 'connected'" class="mcp-tools-row" @click="mToggleTools(srv.name)">
                  <span class="mcp-chevron" :class="{ open: mExpanded.has(srv.name) }">›</span>
                  <span class="mcp-tool-count">{{ srv.tool_count ?? 0 }} tools enabled</span>
                </div>
                <div v-else-if="srv.status === 'error'" class="mcp-tools-row mcp-tools-error">
                  <span class="mcp-chevron">!</span>
                  <span>連線失敗 — 請確認 command 是否正確</span>
                </div>
                <div v-else-if="srv.status === 'disabled'" class="mcp-tools-row mcp-tools-disabled">
                  <span class="mcp-chevron">–</span>
                  <span>已停用</span>
                </div>

                <!-- Tool list (expanded) -->
                <ul v-if="mExpanded.has(srv.name) && srv.tools?.length" class="mcp-tool-list">
                  <li v-for="t in srv.tools" :key="t.name">
                    <span class="mcp-tool-name">{{ t.name }}</span>
                    <span v-if="t.description" class="mcp-tool-desc"> — {{ t.description }}</span>
                  </li>
                </ul>

                <!-- Env / command editor (collapsible) -->
                <div class="mcp-config-toggle" @click="mToggleEnv(srv.name)">
                  <span class="mcp-chevron" :class="{ open: mExpandedEnv.has(srv.name) }">›</span>
                  <span>設定</span>
                </div>
                <div v-if="mExpandedEnv.has(srv.name)" class="mcp-config-form">
                  <div class="two-col">
                    <div class="field">
                      <label class="lbl">Command</label>
                      <input v-model="srv.command" type="text" spellcheck="false" placeholder="npx" @blur="mSave(true)" />
                    </div>
                    <div class="field">
                      <label class="lbl">Args</label>
                      <input :value="mArgString(srv)" @input="mSetArgs(srv, ($event.target as HTMLInputElement).value)" type="text" spellcheck="false" @blur="mSave(true)" />
                    </div>
                  </div>
                  <!-- Env vars -->
                  <div class="field">
                    <label class="lbl">Env vars <button class="mcp-add-env-btn" @click.stop="mAddEnvEntry(srv)">+ 新增</button></label>
                    <div v-for="[k, v] in mEnvEntries(srv)" :key="k" class="mcp-env-row">
                      <input :value="k" @change="mSetEnvKey(srv, k, ($event.target as HTMLInputElement).value)" type="text" spellcheck="false" placeholder="KEY" class="mcp-env-key" />
                      <span>=</span>
                      <input :value="v" @input="mSetEnvVal(srv, k, ($event.target as HTMLInputElement).value)" type="text" spellcheck="false" placeholder="value" class="mcp-env-val" @blur="mSave(true)" />
                      <button class="mcp-delete-btn small" @click.stop="mDeleteEnvEntry(srv, k)">✕</button>
                    </div>
                    <p v-if="!Object.keys(srv.env).length" class="hint-msg" style="margin:4px 0 0">無環境變數</p>
                  </div>
                </div>
              </div>

              <div v-if="!mLoading && mServers.length === 0" class="mcp-empty">
                尚未安裝任何 MCP server。點擊「Add MCP +」從目錄加入。
              </div>
            </div>
          </template>

          <!-- ── CATALOG VIEW ────────────────────────────────────────────── -->
          <template v-else>
            <div class="mcp-topbar">
              <button class="mcp-back-btn" @click="mView = 'list'">← 返回</button>
              <span class="mcp-page-title">Add MCP Servers</span>
            </div>

            <div class="mcp-search-wrap">
              <input v-model="mSearch" type="text" placeholder="Search MCP servers by name" class="mcp-search" spellcheck="false" />
              <span class="mcp-search-icon">🔍</span>
            </div>

            <div class="mcp-catalog-hint">
              💡 這裡只列<strong>「Orchestrator 讀取上下文用」</strong>的 MCP。讀取 workspace / 文件 / 外部服務的資訊，注入 kickoff prompt 校正 agent 認知。跑測試、瀏覽器操作等執行行為由 CLI agents 自行處理。
            </div>

            <div class="mcp-catalog-list">
              <div v-for="item in mFilteredCatalog" :key="item.name" class="mcp-catalog-card">
                <div class="mcp-catalog-info">
                  <div class="mcp-catalog-name">{{ item.label }}</div>
                  <div class="mcp-catalog-desc">{{ item.description }}</div>
                  <div v-if="item.requiresEnv?.length" class="mcp-catalog-note">
                    ⚠ 需填寫環境變數：{{ item.requiresEnv.join('、') }}
                  </div>
                </div>
                <button v-if="mIsInstalled(item.name)" class="mcp-installed-badge" disabled>已安裝</button>
                <button v-else class="mcp-add-btn" @click="mAddFromCatalog(item)" :disabled="mSaving">+ Add</button>
              </div>
              <div v-if="mFilteredCatalog.length === 0" class="mcp-empty">找不到符合的 MCP server</div>
            </div>
          </template>

        </div>

        <!-- ── ANALYZER TAB ─────────────────────────────────────────────── -->
        <div v-show="activeTab === 'analyzer'" class="s-body analyzer-body">

          <div class="az-header">
            <div class="az-info">
              <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                llama-cli {{ props.analyzerApi.health.value?.version }}
              </span>
              <span class="az-version offline" v-else>llama-cli 未偵測到</span>
            </div>
            <button
              class="az-run-btn"
              :disabled="props.analyzerApi.benchmarking.value || !props.analyzerApi.health.value?.ok"
              @click="props.analyzerApi.benchmark()"
            >
              {{ props.analyzerApi.benchmarking.value ? '⏳ 偵測中…' : '🧪 執行模型測試' }}
            </button>
          </div>

          <!-- Live progress bar -->
          <div v-if="props.analyzerApi.benchmarking.value" class="az-progress-wrap">
            <div v-if="props.analyzerApi.benchmarkProgress.value" class="az-progress-label">
              <span class="az-spin">⏳</span>
              測試中：<strong>{{ props.analyzerApi.benchmarkProgress.value.model }}</strong>
              · {{ props.analyzerApi.benchmarkProgress.value.task_id }}
            </div>
            <div v-else class="az-progress-label">準備中…</div>
          </div>

          <!-- Hint when no results yet -->
          <div v-if="!props.analyzerApi.benchmarking.value && props.analyzerApi.benchmarkResults.value.length === 0" class="az-hint">
            <p>點擊「執行模型測試」，系統將對所有本地模型跑 4 項標準任務：</p>
            <ul>
              <li><strong>T1</strong> 技術棧偵測 — 輸出 JSON <code>{libraries, doc_query}</code></li>
              <li><strong>T2</strong> 工作區摘要 — 繁體中文一句話摘要</li>
              <li><strong>T3</strong> 相關性選擇 — 從文件清單挑出最相關項目</li>
              <li><strong>T4</strong> CLI 意圖解析 — 解析 agent 輸出並提取問題與選項</li>
            </ul>
            <p class="az-pass-rule">通過門檻：4 項中至少 3 項 (≥75%)。不合格模型將從 Model 下拉選單隱藏。</p>
          </div>

          <!-- Results table -->
          <div v-if="props.analyzerApi.benchmarkResults.value.length > 0" class="az-results">
            <div class="az-results-summary">
              通過
              <strong>{{ props.analyzerApi.benchmarkResults.value.filter(r => r.passed).length }}</strong>
              /
              {{ props.analyzerApi.benchmarkResults.value.length }}
              個模型 · 不合格模型已從 Model 下拉選單移除
            </div>
            <table class="az-table">
              <thead>
                <tr>
                  <th class="az-th-model">模型</th>
                  <th v-for="t in ['T1','T2','T3','T4']" :key="t" class="az-th-task">{{ t }}</th>
                  <th class="az-th-score">總分</th>
                  <th class="az-th-verdict">判定</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in props.analyzerApi.benchmarkResults.value"
                  :key="r.name"
                  :class="{ 'az-row-fail': !r.passed }"
                >
                  <td class="az-td-model">{{ r.name }}</td>
                  <td
                    v-for="tid in ['T1','T2','T3','T4']"
                    :key="tid"
                    class="az-td-task"
                  >
                    <template v-if="r.tasks.find(t => t.task_id === tid)">
                      <span :class="r.tasks.find(t => t.task_id === tid)!.passed ? 'az-pass' : 'az-fail'">
                        {{ r.tasks.find(t => t.task_id === tid)!.passed ? '✅' : '❌' }}
                      </span>
                      <span class="az-elapsed">{{ r.tasks.find(t => t.task_id === tid)!.elapsed_s }}s</span>
                    </template>
                    <span v-else class="az-na">—</span>
                  </td>
                  <td class="az-td-score">{{ r.score }}/{{ r.tasks.length }}</td>
                  <td class="az-td-verdict">
                    <span v-if="r.passed" class="az-badge-pass">合格</span>
                    <span v-else class="az-badge-fail">排除</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

        </div>

      </div>
    </div>

    <!-- Confirm dialogs -->
    <div v-if="rConfirmDelete" class="s-overlay confirm" @click.self="rConfirmDelete = false">
      <div class="confirm-card">
        <h3>刪除角色「{{ rDraft?.label }}」？</h3>
        <p>此操作無法復原。</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="rConfirmDelete = false">取消</button>
          <button class="danger" @click="rDoDelete">刪除</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmReset" class="s-overlay confirm" @click.self="rConfirmReset = false">
      <div class="confirm-card">
        <h3>將所有角色重設為預設？</h3>
        <p>自訂角色將全部清除，此操作無法復原。</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="rConfirmReset = false">取消</button>
          <button class="danger" @click="rDoReset">重設</button>
        </div>
      </div>
    </div>
    <div v-if="sConfirmDelete" class="s-overlay confirm" @click.self="sConfirmDelete = false">
      <div class="confirm-card">
        <h3>刪除 Stage「{{ sDraft?.id }}」？</h3>
        <p>此操作無法復原。</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="sConfirmDelete = false">取消</button>
          <button class="danger" @click="sDoDelete">刪除</button>
        </div>
      </div>
    </div>
    <div v-if="sConfirmReset" class="s-overlay confirm" @click.self="sConfirmReset = false">
      <div class="confirm-card">
        <h3>將所有 Stage 重設為預設？</h3>
        <p>所有自訂 Stage 將被清除。</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="sConfirmReset = false">取消</button>
          <button class="danger" @click="sDoReset">重設</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & modal shell ─────────────────────────────────────────────────── */
.s-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  z-index: 8000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.s-overlay.confirm { z-index: 9000; }

.s-modal {
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #21262d;
  border-radius: 12px;
  width: 92vw;
  max-width: 1100px;
  height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.7);
}

/* ── Header ──────────────────────────────────────────────────────────────────  */
.s-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #21262d;
  background: #010409;
  flex-shrink: 0;
}
.s-title {
  font-size: 14px;
  font-weight: 600;
  color: #e6edf3;
  white-space: nowrap;
}
.s-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}
.s-tab {
  border: 1px solid transparent;
  background: transparent;
  color: #8b949e;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.s-tab:hover { background: #161b22; color: #e6edf3; }
.s-tab.active { background: #1f2937; border-color: #30363d; color: #58a6ff; }
.s-close {
  border: none;
  background: transparent;
  color: #8b949e;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  line-height: 1;
}
.s-close:hover { background: #21262d; color: #e6edf3; }

/* ── Tab body ─────────────────────────────────────────────────────────────── */
.s-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* ── Toolbar inside tab ───────────────────────────────────────────────────── */
.tab-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid #21262d;
  flex-shrink: 0;
}
.tab-toolbar button { font-size: 11px; padding: 5px 10px; }
.summary-ok { font-size: 11px; color: #3fb950; margin-left: 6px; }

/* ── Split layout (list + detail) ─────────────────────────────────────────── */
.split {
  flex: 1;
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 0;
}
.split-list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid #21262d;
  background: #010409;
  overflow-y: auto;
  min-height: 0;
}
.split-list .new-btn { margin: 10px 10px 6px; font-size: 12px; }
.split-list ul { list-style: none; margin: 0; padding: 0; }
.split-list li { padding: 9px 12px; border-bottom: 1px solid #161b22; cursor: pointer; }
.split-list li:hover { background: #161b22; }
.split-list li.active { background: #1f3a5f; }
.split-detail { padding: 14px 18px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.empty-detail { align-items: center; justify-content: center; color: #6e7681; }

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #8b949e; }
input[type='text'], input[type='email'], textarea, select {
  background: #161b22;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 7px 9px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  box-sizing: border-box;
  width: 100%;
}
textarea { font-family: Menlo, Monaco, monospace; resize: vertical; line-height: 1.5; }
input:focus, textarea:focus, select:focus { outline: none; border-color: #1f6feb; }
input:disabled { opacity: 0.5; cursor: not-allowed; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.detail-head h3 { margin: 0; font-size: 14px; }
.check-row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
.check-row input[type='checkbox'] { width: 14px; height: 14px; accent-color: #58a6ff; }

/* ── List items ───────────────────────────────────────────────────────────── */
.row-g { display: flex; align-items: center; gap: 6px; }
.row-g.gap { gap: 8px; }
.row-g.spread { justify-content: space-between; }
.mono-key { font-family: Menlo, Monaco, monospace; font-size: 10px; color: #79c0ff; }
.badge { background: #21262d; color: #8b949e; font-size: 9px; padding: 1px 5px; border-radius: 3px; }
.item-label { font-weight: 600; font-size: 12px; margin-top: 2px; }
.item-sub { color: #8b949e; font-size: 11px; margin-top: 1px; }
.icon-btn { border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: #30363d; color: #e6edf3; }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: #238636; border-color: #2ea043; color: #fff; font-weight: 600; }
button.primary:not(:disabled):hover { background: #2ea043; }
button.danger { background: #6f1f1f; border-color: #8a2929; color: #f4d2d2; }
button.danger:hover { background: #8a2929; }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: #21262d; }
.danger-link { color: #f85149; border-color: transparent; background: transparent; }
.danger-link:hover { background: rgba(248,81,73,0.1) !important; }

/* ── Messages ─────────────────────────────────────────────────────────────── */
.err-msg { color: #f85149; font-size: 11px; margin: 0; }
.warn-msg { color: #d29922; font-size: 11px; margin: 0; }
.hint-msg { color: #8b949e; font-size: 11px; margin: 0; }

/* ── Manager designation (per-slot) ───────────────────────────────────────── */
.manager-toggle { font-size: 11px; line-height: 1.55; padding: 6px 8px; border: 1px solid rgba(216, 180, 109, 0.25); border-radius: 6px; background: rgba(216, 180, 109, 0.04); }
.manager-toggle strong { color: #d8b46d; }
.manager-toggle code { background: #161b22; padding: 1px 4px; border-radius: 3px; font-size: 10px; color: #e6edf3; }
.manager-badge { font-size: 9px; color: #d8b46d; background: rgba(216, 180, 109, 0.12); border: 1px solid rgba(216, 180, 109, 0.3); border-radius: 8px; padding: 1px 6px; margin-left: 6px; font-weight: 600; }

/* ── Slots ────────────────────────────────────────────────────────────────── */
.slots-section { border-top: 1px solid #21262d; padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.slot-required { color: #f85149; font-size: 9px; font-weight: 400; text-transform: none; margin-left: 4px; }
.slot-item { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px; }
.slot-clickable { cursor: pointer; transition: border-color 0.15s; }
.slot-clickable:hover { border-color: #388bfd; }
.slot-form { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }

/* ── MCP tab ──────────────────────────────────────────────────────────────── */
.mcp-body { overflow-y: auto; display: flex; flex-direction: column; }

/* Top bar */
.mcp-topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid #21262d;
  flex-shrink: 0; background: #010409;
}
.mcp-page-title { font-size: 13px; font-weight: 700; color: #e6edf3; flex: 1; }
.mcp-topbar-actions { display: flex; gap: 8px; }
.mcp-action-btn {
  font-size: 11px; padding: 5px 11px; border-radius: 6px;
  background: #21262d; border: 1px solid #30363d; color: #e6edf3; cursor: pointer;
}
.mcp-action-btn:hover:not(:disabled) { background: #30363d; }
.mcp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mcp-back-btn {
  font-size: 12px; padding: 4px 10px; border-radius: 5px;
  background: transparent; border: 1px solid #30363d; color: #8b949e; cursor: pointer;
}
.mcp-back-btn:hover { background: #21262d; color: #e6edf3; }
.mcp-summary-ok { font-size: 11px; color: #3fb950; padding: 4px 16px; }

/* Server list */
.mcp-server-list { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; }
.mcp-loading { color: #8b949e; font-size: 12px; padding: 8px 0; }
.mcp-empty { color: #6e7681; font-size: 12px; padding: 24px 0; text-align: center; }

/* Server card */
.mcp-server-card {
  background: #161b22; border: 1px solid #21262d; border-radius: 10px;
  display: flex; flex-direction: column; overflow: hidden;
}

/* Main row: dot + name + trash + toggle */
.mcp-server-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; min-height: 44px;
}
.mcp-spacer { flex: 1; }
.mcp-server-name { font-weight: 700; font-size: 13px; color: #e6edf3; }

/* Status dot */
.mcp-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.mcp-dot.connected { background: #3fb950; box-shadow: 0 0 6px rgba(63,185,80,0.6); }
.mcp-dot.error     { background: #f85149; }
.mcp-dot.disabled  { background: #484f58; }
.mcp-dot.unknown   { background: #484f58; }

/* Delete button */
.mcp-delete-btn {
  border: none; background: transparent; color: #484f58;
  font-size: 14px; cursor: pointer; padding: 2px 4px; border-radius: 4px; line-height: 1;
}
.mcp-delete-btn:hover { color: #f85149; background: rgba(248,81,73,0.1); }
.mcp-delete-btn.small { font-size: 10px; color: #6e7681; }
.mcp-delete-btn.small:hover { color: #f85149; }

/* Toggle switch (iOS-style) */
.mcp-toggle {
  width: 40px; height: 22px; border-radius: 11px; border: none;
  background: #484f58; padding: 0; cursor: pointer;
  display: flex; align-items: center; transition: background 0.2s;
  flex-shrink: 0; position: relative;
}
.mcp-toggle.on { background: #1f6feb; }
.mcp-toggle-thumb {
  width: 18px; height: 18px; border-radius: 50%; background: #fff;
  position: absolute; left: 2px; transition: left 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
.mcp-toggle.on .mcp-toggle-thumb { left: 20px; }

/* Tools row */
.mcp-tools-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-top: 1px solid #21262d;
  font-size: 11px; color: #8b949e; cursor: pointer; user-select: none;
}
.mcp-tools-row:hover { background: #1c2128; }
.mcp-tools-error { color: #f85149; cursor: default; }
.mcp-tools-disabled { color: #484f58; cursor: default; }
.mcp-chevron { font-size: 12px; transition: transform 0.15s; display: inline-block; }
.mcp-chevron.open { transform: rotate(90deg); }
.mcp-tool-count { font-size: 11px; }

/* Tool list */
.mcp-tool-list {
  list-style: none; margin: 0; padding: 6px 14px 10px 28px;
  border-top: 1px solid #161b22; display: flex; flex-direction: column; gap: 3px;
}
.mcp-tool-list li { font-size: 11px; color: #8b949e; }
.mcp-tool-name { color: #79c0ff; font-family: Menlo, Monaco, monospace; }
.mcp-tool-desc { color: #6e7681; }

/* Config form toggle */
.mcp-config-toggle {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 14px; border-top: 1px solid #21262d;
  font-size: 11px; color: #6e7681; cursor: pointer; user-select: none;
}
.mcp-config-toggle:hover { background: #1c2128; color: #8b949e; }
.mcp-config-form {
  padding: 10px 14px; border-top: 1px solid #21262d;
  display: flex; flex-direction: column; gap: 8px; background: #0d1117;
}

/* Env vars editor */
.mcp-env-row { display: flex; align-items: center; gap: 6px; }
.mcp-env-key { width: 140px; flex-shrink: 0; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-env-val { flex: 1; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-add-env-btn {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: transparent; border: 1px solid #30363d; color: #8b949e; cursor: pointer; margin-left: 6px;
}
.mcp-add-env-btn:hover { background: #21262d; color: #e6edf3; }

/* Catalog view */
.mcp-search-wrap {
  position: relative; padding: 12px 16px; border-bottom: 1px solid #21262d; flex-shrink: 0;
}
.mcp-search {
  width: 100%; padding: 8px 36px 8px 12px; border-radius: 8px;
  background: #161b22; border: 1px solid #30363d; color: #e6edf3;
  font-size: 12px; box-sizing: border-box;
}
.mcp-search:focus { outline: none; border-color: #1f6feb; }
.mcp-search-icon {
  position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
  font-size: 13px; color: #6e7681; pointer-events: none;
}

.mcp-catalog-hint {
  padding: 8px 16px; font-size: 11px; color: #8b949e; line-height: 1.6;
  background: #0d1117; border-bottom: 1px solid #21262d; flex-shrink: 0;
}
.mcp-catalog-hint strong { color: #e6edf3; }
.mcp-catalog-list {
  padding: 10px 16px; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; flex: 1;
}
.mcp-catalog-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 2px; border-bottom: 1px solid #21262d;
}
.mcp-catalog-card:last-child { border-bottom: none; }
.mcp-catalog-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.mcp-catalog-name { font-size: 13px; font-weight: 700; color: #e6edf3; }
.mcp-catalog-desc { font-size: 11px; color: #8b949e; line-height: 1.5; }
.mcp-catalog-note { font-size: 10px; color: #d29922; margin-top: 2px; }
.mcp-add-btn {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: #1f6feb; border: 1px solid #388bfd; color: #fff; font-weight: 600; cursor: pointer;
}
.mcp-add-btn:hover:not(:disabled) { background: #388bfd; }
.mcp-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mcp-installed-badge {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: #21262d; border: 1px solid #30363d; color: #6e7681; cursor: not-allowed;
}

/* ── Confirm dialog ───────────────────────────────────────────────────────── */
.confirm-card {
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px 24px;
  max-width: 400px;
  width: 90%;
}
.confirm-card h3 { margin: 0 0 8px; font-size: 14px; }
.confirm-card p { font-size: 12px; color: #c9d1d9; margin: 0 0 16px; }

/* ── Analyzer tab ─────────────────────────────────────────────────────────── */
.analyzer-body { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 0; }

.az-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid #21262d;
  flex-shrink: 0;
}
.az-version { font-size: 11px; color: #8b949e; }
.az-version.offline { color: #f85149; }
.az-run-btn {
  background: #1f6feb;
  border: 1px solid #388bfd;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.az-run-btn:hover:not(:disabled) { background: #388bfd; }
.az-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.az-progress-wrap {
  padding: 10px 20px;
  border-bottom: 1px solid #21262d;
  background: #0d1117;
  flex-shrink: 0;
}
.az-progress-label { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 8px; }
.az-spin { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.az-hint {
  padding: 20px 24px;
  color: #8b949e;
  font-size: 12px;
  line-height: 1.7;
}
.az-hint p { margin: 0 0 10px; }
.az-hint ul { margin: 0 0 10px; padding-left: 18px; }
.az-hint li { margin-bottom: 4px; }
.az-hint code { background: #161b22; padding: 1px 5px; border-radius: 3px; font-size: 11px; color: #e6edf3; }
.az-pass-rule { color: #58a6ff; font-size: 11px; }

.az-results { padding: 16px 20px; flex: 1; overflow-y: auto; }
.az-results-summary {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 12px;
}
.az-results-summary strong { color: #3fb950; }

.az-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.az-table th {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid #21262d;
  color: #8b949e;
  font-weight: 500;
  white-space: nowrap;
}
.az-th-task, .az-th-score, .az-th-verdict { text-align: center; }
.az-table td { padding: 8px 10px; border-bottom: 1px solid #161b22; vertical-align: middle; }
.az-td-model { font-family: monospace; font-size: 11px; color: #e6edf3; }
.az-td-task { text-align: center; white-space: nowrap; }
.az-td-score { text-align: center; color: #8b949e; }
.az-td-verdict { text-align: center; }
.az-elapsed { font-size: 10px; color: #8b949e; margin-left: 3px; }
.az-na { color: #484f58; }
.az-row-fail td { color: #484f58; }
.az-row-fail .az-td-model { color: #6e7681; }
.az-badge-pass {
  background: rgba(63, 185, 80, 0.15);
  color: #3fb950;
  border: 1px solid rgba(63,185,80,0.3);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.az-badge-fail {
  background: rgba(248, 81, 73, 0.1);
  color: #6e7681;
  border: 1px solid #21262d;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}
</style>
