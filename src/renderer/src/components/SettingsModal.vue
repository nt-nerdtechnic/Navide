<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { useRoles } from '../composables/useRoles'
import type { useStages } from '../composables/useStages'
import type { useAnalyzer } from '../composables/useAnalyzer'
import type { usePipelines } from '../composables/usePipelines'
import { stageToBackend, stageDefToFrontend, type Stage, type StageSlot } from '../data/stages'
import { MCP_CATALOG, isMcpInstalled, type McpCatalogEntry } from '../data/mcpCatalog'
import { useTheme } from '../composables/useTheme'
import { useNotify } from '../composables/useNotify'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  rolesApi: ReturnType<typeof useRoles>
  stagesApi: ReturnType<typeof useStages>
  analyzerApi: ReturnType<typeof useAnalyzer>
  pipelinesApi?: ReturnType<typeof usePipelines>
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-pipeline', id: string): void
  (e: 'reopen-onboarding'): void
}>()

// ── Tab ───────────────────────────────────────────────────────────────────────
type Tab = 'roles' | 'pipelines' | 'mcp' | 'analyzer' | 'appearance'
const activeTab = ref<Tab>('roles')

// ── Appearance (theme) ────────────────────────────────────────────────────────
const {
  theme: currentTheme,
  customOverrides,
  BUILTIN_THEMES,
  CUSTOMIZABLE_TOKENS,
  setTheme,
  setCustomOverride,
  resetCustom,
} = useTheme()

const { confirm: notifyConfirm } = useNotify()

// Live value bound to each color picker. Seeded from the override map; when an
// override is absent we fall back to the resolved computed token value so the
// picker shows the current built-in theme's color.
function resolvedTokenValue(token: string): string {
  if (customOverrides.value[token]) return customOverrides.value[token]
  if (typeof document === 'undefined') return '#000000'
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return normalizeHex(v) || '#000000'
}

// <input type="color"> only accepts #rrggbb. Coerce common forms; bail to '' if
// the value can't be represented (e.g. a var() reference or rgba()).
function normalizeHex(v: string): string {
  const s = v.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase()
  }
  return ''
}

// Debounced live preview: apply the override 300ms after the last picker input
// so dragging the color wheel doesn't thrash the DOM / localStorage.
let previewTimer: ReturnType<typeof setTimeout> | null = null
function onPickColor(token: string, value: string): void {
  if (previewTimer) clearTimeout(previewTimer)
  const hex = normalizeHex(value)
  previewTimer = setTimeout(() => setCustomOverride(token, hex || null), 300)
}

const hasCustomOverrides = computed(() => Object.keys(customOverrides.value).length > 0)

// Preview-only representative colors per theme [bg, surface, accent, success].
// Used to render the theme cards without having to apply each theme.
const THEME_SWATCHES: Record<string, string[]> = {
  'dark-github': ['#0d1117', '#161b22', '#58a6ff', '#3fb950'],
  'dark-midnight': ['#0a0e14', '#11161f', '#6cb0ff', '#4ad07a'],
  'dark-forest': ['#0c130d', '#121a13', '#6fc28a', '#56d364'],
  light: ['#ffffff', '#f6f8fa', '#0969da', '#1a7f37'],
  'high-contrast': ['#0a0c10', '#14171c', '#71b7ff', '#4ae168'],
}

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

// ── Analyzer tab local state ──────────────────────────────────────────────────
const azPullName = ref('')
const azRechecking = ref(false)
const azDetecting = ref(false)
async function azDetectCli() {
  azDetecting.value = true
  const result = await props.analyzerApi.detectLlamaCli()
  azDetecting.value = false
  if (result.recommended) {
    await props.analyzerApi.saveSettings({ llama_cli: result.recommended })
  }
}
async function azPickCli() {
  const result = await window.agentTeam?.pickFile?.({
    title: 'Select llama-cli executable',
    filters: [{ name: 'Executable', extensions: ['*'] }],
    defaultPath: '/opt/homebrew/bin',
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ llama_cli: result.path })
  }
}
async function azPickGguf() {
  const result = await window.agentTeam?.pickFile?.({
    title: 'Select GGUF model file',
    filters: [{ name: 'GGUF Model', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }],
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ gguf_path: result.path })
  }
}
async function azRecheck() {
  azRechecking.value = true
  await Promise.all([
    props.analyzerApi.refreshHealth(),
    props.analyzerApi.refreshOllamaHealth(),
    props.analyzerApi.refreshModels(),
  ])
  azRechecking.value = false
}
async function azDoPull() {
  const name = azPullName.value.trim()
  if (!name) return
  azPullName.value = ''
  await props.analyzerApi.pullModel(name)
}
async function azDoDelete(name: string) {
  await props.analyzerApi.deleteModel(name)
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
  // Block if the target key is already taken by a DIFFERENT role (covers both new and rename).
  const existing = props.rolesApi.find(rDraft.value.key.trim())
  if (existing && existing.key !== rDraft.value.originalKey) return false
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
const sSlotDraft = ref<StageSlot>({ agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false })

const sIsDirty = computed(() => {
  if (!sDraft.value) return false
  if (sIsNew.value) return true
  const orig = sActiveStages.value.find(s => s.id === sDraft.value!.id)
  if (!orig) return true
  return JSON.stringify(stageToBackend(sDraft.value)) !== JSON.stringify(stageToBackend(orig))
})
const sCanSave = computed(() => {
  if (!sDraft.value || !sDraft.value.id.trim() || !sDraft.value.title.trim()) return false
  if (!sDraft.value.slots || sDraft.value.slots.length === 0) return false
  if (sIsNew.value && sActiveStages.value.find(s => s.id === sDraft.value!.id.trim())) return false
  return sIsDirty.value
})

// Only auto-select first stage when in the global stages view (not pipeline detail)
watch(() => props.stagesApi.stages.value, (ss) => {
  if (plView.value === 'detail') return
  if (ss.length > 0 && sSelectedId.value === null) sSelectStage(ss[0].id)
  else if (sSelectedId.value && !ss.find(s => s.id === sSelectedId.value)) sSelectStage(ss[0]?.id ?? null)
}, { deep: false })

function sSelectStage(id: string | null) {
  sSelectedId.value = id; sError.value = ''; sAddingSlot.value = false; sEditingSlotIndex.value = null
  if (!id) { sDraft.value = null; return }
  const s = sActiveStages.value.find(s => s.id === id)
  if (s) { sDraft.value = JSON.parse(JSON.stringify(s)); sIsNew.value = false }
}
function sStartNew() {
  sSelectedId.value = null; sError.value = ''; sAddingSlot.value = false; sIsNew.value = true
  sDraft.value = {
    id: '', title: '', shortTitle: '', question: '', description: '',
    recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '', slots: [],
  }
}
function sPipelineIdParam() {
  return plView.value === 'detail' ? { pipeline_id: plEditingId.value } : {}
}

async function sSave() {
  if (!sDraft.value || !sCanSave.value) return
  sSaving.value = true; sError.value = ''
  try {
    const payload = stageToBackend({ ...sDraft.value, id: sDraft.value.id.trim() })
    const resp = await props.backend.send<{ stage: Record<string, unknown> }>(
      'stages.upsert', { stage: payload, ...sPipelineIdParam() }
    )
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Save failed'; return }
    sSummary.value = `Saved "${sDraft.value.title}"`
    sSelectedId.value = sDraft.value.id.trim()
    sIsNew.value = false
    if (plView.value === 'detail') await plReloadStages()
  } finally { sSaving.value = false }
}
async function sDoDelete() {
  if (!sDraft.value || sIsNew.value) { sConfirmDelete.value = false; return }
  const resp = await props.backend.send<{ stages: unknown[] }>(
    'stages.delete', { id: sDraft.value.id, ...sPipelineIdParam() }
  )
  sConfirmDelete.value = false
  if (!resp.ok) { sError.value = resp.error?.message ?? 'Delete failed'; return }
  sSummary.value = `Deleted "${sDraft.value.id}"`
  if (plView.value === 'detail') {
    await plReloadStages()
    sSelectStage(plStages.value[0]?.id ?? null)
  } else {
    sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
  }
}
async function sDoReset() {
  const resp = await props.backend.send<{ stages: unknown[] }>(
    'stages.reset', { ...sPipelineIdParam() }
  )
  sConfirmReset.value = false
  if (!resp.ok) { sError.value = resp.error?.message ?? 'Reset failed'; return }
  sSummary.value = 'Reset to factory defaults'
  if (plView.value === 'detail') {
    await plReloadStages()
    sSelectStage(plStages.value[0]?.id ?? null)
  } else {
    sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
  }
}
async function sMoveUp(index: number) {
  if (index <= 0) return
  const ids = sActiveStages.value.map(s => s.id)
  ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
  await props.backend.send('stages.reorder', { ids, ...sPipelineIdParam() })
  if (plView.value === 'detail') await plReloadStages()
}
async function sMoveDown(index: number) {
  if (index >= sActiveStages.value.length - 1) return
  const ids = sActiveStages.value.map(s => s.id)
  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
  await props.backend.send('stages.reorder', { ids, ...sPipelineIdParam() })
  if (plView.value === 'detail') await plReloadStages()
}
const sEditingSlotIndex = ref<number | null>(null)

function sStartAddSlot() {
  sAddingSlot.value = true
  sEditingSlotIndex.value = null
  sSlotDraft.value = { agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false }
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
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), stages: sActiveStages.value }
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
        const resp = await props.backend.send('stages.upsert', { stage: s, ...sPipelineIdParam() })
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
    if (resp.ok) { if (!silent) mSummary.value = 'Saved — MCP Manager restarting…' }
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
  mSummary.value = `Added ${entry.label}`
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

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINES TAB
// ══════════════════════════════════════════════════════════════════════════════

// ── List view ──
const plNewName = ref('')
const plCreating = ref(false)
const plBusy = ref(false)
const plSummary = ref('')

// ── Detail view (pipeline + stage editor) ──
const plView = ref<'list' | 'detail'>('list')
const plEditingId = ref<string>('')
const plStages = ref<Stage[]>([])   // stages for the pipeline being edited
const plStagesLoading = ref(false)
const plRenamingId = ref('')
const plRenameText = ref('')

const plCurrentPipeline = computed(() =>
  props.pipelinesApi?.pipelines.value.find(p => p.id === plEditingId.value) ?? null
)

// Stages to use in the stage editor — plStages when in pipeline detail, global otherwise
const sActiveStages = computed(() =>
  plView.value === 'detail' ? plStages.value : props.stagesApi.stages.value
)

async function plEnterDetail(id: string) {
  plEditingId.value = id
  plView.value = 'detail'
  sSelectedId.value = null
  sDraft.value = null
  sIsNew.value = false
  sError.value = ''
  plStagesLoading.value = true
  try {
    const resp = await props.backend.send<{ stages: Record<string, unknown>[] }>(
      'stages.list', { pipeline_id: id }
    )
    if (resp.ok && resp.payload) {
      plStages.value = resp.payload.stages.map(stageDefToFrontend)
      if (plStages.value.length > 0) sSelectStage(plStages.value[0].id)
    }
  } finally {
    plStagesLoading.value = false
  }
}

function plBackToList() {
  plView.value = 'list'
  plEditingId.value = ''
  plStages.value = []
  sSelectedId.value = null
  sDraft.value = null
}

async function plReloadStages() {
  if (!plEditingId.value) return
  const resp = await props.backend.send<{ stages: Record<string, unknown>[] }>(
    'stages.list', { pipeline_id: plEditingId.value }
  )
  if (resp.ok && resp.payload) {
    plStages.value = resp.payload.stages.map(stageDefToFrontend)
  }
}

async function plCreate() {
  if (!plNewName.value.trim() || plBusy.value) return
  plBusy.value = true
  const p = await props.pipelinesApi?.createPipeline(plNewName.value.trim())
  plBusy.value = false
  if (p) { plNewName.value = ''; plCreating.value = false; plSummary.value = `Created "${p.name}"` }
}

async function plSetActive(id: string) {
  if (plBusy.value) return
  plBusy.value = true
  await props.pipelinesApi?.setActivePipeline(id)
  plBusy.value = false
  plSummary.value = 'Default pipeline updated'
}

function plStartRename(id: string, currentName: string) {
  plRenamingId.value = id
  plRenameText.value = currentName
}

async function plConfirmRename() {
  if (!plRenameText.value.trim() || plBusy.value) return
  plBusy.value = true
  await props.pipelinesApi?.renamePipeline(plRenamingId.value, plRenameText.value.trim())
  plBusy.value = false
  plSummary.value = 'Renamed'
  plRenamingId.value = ''
}

async function plDelete(id: string, name: string) {
  if (!(await notifyConfirm(`Delete "${name}"? This cannot be undone.`, { title: 'Delete Pipeline', confirmText: 'Delete' }))) return
  plBusy.value = true
  await props.pipelinesApi?.deletePipeline(id)
  plBusy.value = false
  plSummary.value = `Deleted "${name}"`
  plBackToList()
}

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
            <button :class="['s-tab', { active: activeTab === 'pipelines' }]" @click="activeTab = 'pipelines'">🔀 Pipelines</button>
            <button :class="['s-tab', { active: activeTab === 'mcp' }]" @click="activeTab = 'mcp'">🔌 MCP</button>
            <button :class="['s-tab', { active: activeTab === 'analyzer' }]" @click="activeTab = 'analyzer'">🧠 Analyzer</button>
            <button :class="['s-tab', { active: activeTab === 'appearance' }]" @click="activeTab = 'appearance'">🎨 Appearance</button>
          </div>
          <button class="s-close" @click="emit('close')" title="Close (ESC)">✕</button>
        </div>

        <!-- ── ROLES TAB ─────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'roles'" class="s-body">
          <div class="tab-toolbar">
            <button class="ghost" :disabled="rExportBusy" @click="rExport">{{ rExportBusy ? '…' : '⬇ Export JSON' }}</button>
            <button class="ghost" :disabled="rImporting" @click="rImport">{{ rImporting ? '…' : '⬆ Import JSON' }}</button>
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
              <div v-if="mLoading" class="mcp-loading">Loading…</div>

              <div v-for="(srv, idx) in mServers" :key="srv.name" class="mcp-server-card">
                <!-- Main row -->
                <div class="mcp-server-row">
                  <span class="mcp-dot" :class="srv.status ?? 'unknown'"></span>
                  <span class="mcp-server-name">{{ srv.name }}</span>
                  <span class="mcp-spacer"></span>
                  <button class="mcp-delete-btn" @click="mRemoveServer(idx)" title="Remove">🗑</button>
                  <!-- Toggle switch -->
                  <button class="mcp-toggle" :class="{ on: srv.enabled }" @click="mToggleEnabled(srv)" :title="srv.enabled ? 'Disable' : 'Enable'">
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
                  <span>Connection failed — check that the command is correct</span>
                </div>
                <div v-else-if="srv.status === 'disabled'" class="mcp-tools-row mcp-tools-disabled">
                  <span class="mcp-chevron">–</span>
                  <span>Disabled</span>
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
                    <label class="lbl">Env vars <button class="mcp-add-env-btn" @click.stop="mAddEnvEntry(srv)">+ Add</button></label>
                    <div v-for="[k, v] in mEnvEntries(srv)" :key="k" class="mcp-env-row">
                      <input :value="k" @change="mSetEnvKey(srv, k, ($event.target as HTMLInputElement).value)" type="text" spellcheck="false" placeholder="KEY" class="mcp-env-key" />
                      <span>=</span>
                      <input :value="v" @input="mSetEnvVal(srv, k, ($event.target as HTMLInputElement).value)" type="text" spellcheck="false" placeholder="value" class="mcp-env-val" @blur="mSave(true)" />
                      <button class="mcp-delete-btn small" @click.stop="mDeleteEnvEntry(srv, k)">✕</button>
                    </div>
                    <p v-if="!Object.keys(srv.env).length" class="hint-msg" style="margin:4px 0 0">No environment variables</p>
                  </div>
                </div>
              </div>

              <div v-if="!mLoading && mServers.length === 0" class="mcp-empty">
                No MCP servers installed. Click "Add MCP +" to add one from the catalog.
              </div>
            </div>
          </template>

          <!-- ── CATALOG VIEW ────────────────────────────────────────────── -->
          <template v-else>
            <div class="mcp-topbar">
              <button class="mcp-back-btn" @click="mView = 'list'">← Back</button>
              <span class="mcp-page-title">Add MCP Servers</span>
            </div>

            <div class="mcp-search-wrap">
              <input v-model="mSearch" type="text" placeholder="Search MCP servers by name" class="mcp-search" spellcheck="false" />
              <span class="mcp-search-icon">🔍</span>
            </div>

            <div class="mcp-catalog-hint">
              💡 This catalog lists only <strong>"Orchestrator context-reading"</strong> MCPs — tools that read workspace / docs / external service data and inject it into kickoff prompts to ground agent knowledge. Execution actions (tests, browser automation, etc.) are handled by the CLI agents themselves.
            </div>

            <div class="mcp-catalog-list">
              <div v-for="item in mFilteredCatalog" :key="item.name" class="mcp-catalog-card">
                <div class="mcp-catalog-info">
                  <div class="mcp-catalog-name">{{ item.label }}</div>
                  <div class="mcp-catalog-desc">{{ item.description }}</div>
                  <div v-if="item.requiresEnv?.length" class="mcp-catalog-note">
                    ⚠ Requires env vars: {{ item.requiresEnv.join(', ') }}
                  </div>
                </div>
                <button v-if="mIsInstalled(item.name)" class="mcp-installed-badge" disabled>Installed</button>
                <button v-else class="mcp-add-btn" @click="mAddFromCatalog(item)" :disabled="mSaving">+ Add</button>
              </div>
              <div v-if="mFilteredCatalog.length === 0" class="mcp-empty">No matching MCP servers found</div>
            </div>
          </template>

        </div>

        <!-- ── ANALYZER TAB ─────────────────────────────────────────────── -->
        <div v-show="activeTab === 'analyzer'" class="s-body analyzer-body">

          <!-- ① Inference backend -->
          <div class="az-section">
            <div class="az-section-title">Inference Backend</div>
            <div class="az-backend-toggle">
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'ollama' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'ollama' })"
              >Ollama REST</button>
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'llama_cpp' })"
              >llama.cpp</button>
            </div>

            <!-- llama.cpp-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp'">
              <div class="az-subsection">
                <label class="az-label">llama-cli executable path
                  <span class="az-hint-inline">(leave blank to use the default from PATH)</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="e.g. llama-cli or /usr/local/bin/llama-completion"
                    :value="props.analyzerApi.analyzerSettings.value.llama_cli"
                    @change="props.analyzerApi.saveSettings({ llama_cli: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-detect-btn"
                    :disabled="azDetecting"
                    @click="azDetectCli"
                    title="Auto-scan PATH and common locations"
                  >{{ azDetecting ? '…' : 'Auto-detect' }}</button>
                  <button class="az-browse-btn" @click="azPickCli" title="Browse…">…</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    llama-cli {{ props.analyzerApi.health.value?.version }}
                  </span>
                  <span class="az-version offline" v-else>llama-cli not detected</span>
                </div>
              </div>

              <div class="az-subsection">
                <label class="az-label">Custom GGUF model path
                  <span class="az-hint-inline">(when set, this file is used directly, bypassing Ollama)</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="e.g. /Users/xxx/models/qwen2.5-coder-7b-q4_k_m.gguf"
                    :value="props.analyzerApi.analyzerSettings.value.gguf_path"
                    @change="props.analyzerApi.saveSettings({ gguf_path: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    title="Re-check whether the file exists"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                  <button class="az-browse-btn" @click="azPickGguf" title="Browse .gguf files…">…</button>
                </div>
                <template v-if="props.analyzerApi.analyzerSettings.value.gguf_path">
                  <div class="az-status-row">
                    <span class="az-status-dot" :class="props.analyzerApi.health.value?.gguf_warning ? 'err' : 'ok'"></span>
                    <span class="az-version" v-if="props.analyzerApi.health.value?.ok && !props.analyzerApi.health.value?.gguf_warning">
                      File found · {{ props.analyzerApi.health.value?.gguf_size ? ((props.analyzerApi.health.value.gguf_size as number) / 1e9).toFixed(1) + ' GB' : '' }}
                    </span>
                    <span class="az-version offline" v-else>{{ (props.analyzerApi.health.value as any)?.gguf_warning ?? 'Not yet detected' }}</span>
                  </div>
                </template>
                <div class="az-gguf-hint">
                  Download a <code>.gguf</code> file from <a class="az-link" href="https://huggingface.co/models?library=gguf" target="_blank">HuggingFace</a>
                  and enter the full path here. Leave blank to use the Ollama model selected in the model manager.
                </div>
              </div>
            </template>

            <!-- Ollama REST-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'">
              <div class="az-subsection">
                <label class="az-label">Inference server URL</label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="http://localhost:11434"
                    :value="props.analyzerApi.analyzerSettings.value.ollama_base_url"
                    @change="props.analyzerApi.saveSettings({ ollama_base_url: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    title="Re-check connection"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    Ollama {{ props.analyzerApi.health.value?.version }} connected
                  </span>
                  <span class="az-version offline" v-else>
                    Not connected · run <code class="az-code">ollama serve</code>
                  </span>
                </div>
              </div>
            </template>
          </div>

          <!-- ② Model manager (Ollama mode only) -->
          <div v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'" class="az-section az-models-section">
            <div class="az-section-header">
              <div class="az-section-title">Model Manager</div>
              <span class="az-section-note">Download · delete local models</span>
            </div>

            <!-- Pull a new model -->
            <div class="az-pull-row">
              <input
                class="az-input az-pull-input"
                type="text"
                placeholder="Model name, e.g. qwen2.5-coder, llama3.2, gemma3"
                v-model="azPullName"
                @keydown.enter="azDoPull"
              />
              <button
                class="az-run-btn"
                :disabled="props.analyzerApi.pulling.value || !azPullName.trim()"
                @click="azDoPull"
              >
                {{ props.analyzerApi.pulling.value ? 'Downloading…' : '⬇ Download' }}
              </button>
            </div>

            <!-- Download progress -->
            <div v-if="props.analyzerApi.pulling.value" class="az-progress-wrap">
              <div class="az-progress-label">
                <span class="az-spin">⏳</span>
                <span>{{ props.analyzerApi.pullProgress.value?.status ?? 'Connecting…' }}</span>
                <template v-if="props.analyzerApi.pullProgress.value?.total">
                  <span class="az-pct">
                    {{ Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) }}%
                  </span>
                  <span class="az-size-info">
                    {{ ((props.analyzerApi.pullProgress.value.completed ?? 0) / 1e9).toFixed(1) }}
                    / {{ (props.analyzerApi.pullProgress.value.total / 1e9).toFixed(1) }} GB
                  </span>
                </template>
              </div>
              <div v-if="props.analyzerApi.pullProgress.value?.total" class="az-progress-bar-wrap">
                <div
                  class="az-progress-bar"
                  :style="{ width: Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) + '%' }"
                ></div>
              </div>
            </div>
            <div v-if="props.analyzerApi.pullError.value" class="az-pull-error">
              ⚠ {{ props.analyzerApi.pullError.value }}
            </div>

            <!-- Installed models list -->
            <div class="az-model-list">
              <div v-if="props.analyzerApi.models.value.length === 0" class="az-no-models">
                No local models detected. Run <code>ollama pull &lt;model-name&gt;</code> or use the download field above.
              </div>
              <div
                v-for="m in props.analyzerApi.models.value"
                :key="m.name"
                class="az-model-row"
              >
                <div class="az-model-info">
                  <span class="az-model-name">{{ m.name }}</span>
                  <span class="az-model-meta">
                    {{ m.parameter_size || m.family }}
                    <template v-if="m.size > 0"> · {{ (m.size / 1e9).toFixed(1) }} GB</template>
                  </span>
                </div>
                <button class="az-del-btn" @click="azDoDelete(m.name)" title="Delete locally">✕</button>
              </div>
            </div>
          </div>

          <!-- ③ Model benchmark -->
          <div class="az-section az-benchmark-section">
            <div class="az-section-header">
              <div class="az-section-title">Model Benchmark</div>
              <button
                class="az-run-btn"
                :disabled="props.analyzerApi.benchmarking.value || !props.analyzerApi.health.value?.ok"
                @click="props.analyzerApi.benchmark()"
              >
                {{ props.analyzerApi.benchmarking.value ? '⏳ Running…' : '🧪 Run benchmark' }}
              </button>
            </div>

            <div v-if="props.analyzerApi.benchmarking.value" class="az-progress-wrap">
              <div v-if="props.analyzerApi.benchmarkProgress.value" class="az-progress-label">
                <span class="az-spin">⏳</span>
                Testing: <strong>{{ props.analyzerApi.benchmarkProgress.value.model }}</strong>
                · {{ props.analyzerApi.benchmarkProgress.value.task_id }}
              </div>
              <div v-else class="az-progress-label">Preparing…</div>
            </div>

            <div v-if="!props.analyzerApi.benchmarking.value && props.analyzerApi.benchmarkResults.value.length === 0" class="az-hint">
              <p>Runs 4 standard tasks against all local models to determine which ones are suitable for pipeline intent detection:</p>
              <ul>
                <li><strong>T1</strong> Tech stack detection — outputs JSON <code>{libraries, doc_query}</code></li>
                <li><strong>T2</strong> Workspace summary — one-sentence summary</li>
                <li><strong>T3</strong> Relevance selection — picks the most relevant item from a doc list</li>
                <li><strong>T4</strong> CLI intent parsing — parses agent output and extracts questions and options</li>
              </ul>
              <p class="az-pass-rule">Pass threshold: at least 3 of 4 tasks (≥75%). Models that fail will be hidden from the Model dropdown.</p>
            </div>

            <div v-if="props.analyzerApi.benchmarkResults.value.length > 0" class="az-results">
              <div class="az-results-summary">
                Passed
                <strong>{{ props.analyzerApi.benchmarkResults.value.filter(r => r.passed).length }}</strong>
                /
                {{ props.analyzerApi.benchmarkResults.value.length }}
                model(s)
              </div>
              <table class="az-table">
                <thead>
                  <tr>
                    <th class="az-th-model">Model</th>
                    <th v-for="t in ['T1','T2','T3','T4']" :key="t" class="az-th-task">{{ t }}</th>
                    <th class="az-th-score">Score</th>
                    <th class="az-th-verdict">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in props.analyzerApi.benchmarkResults.value"
                    :key="r.name"
                    :class="{ 'az-row-fail': !r.passed }"
                  >
                    <td class="az-td-model">{{ r.name }}</td>
                    <td v-for="tid in ['T1','T2','T3','T4']" :key="tid" class="az-td-task">
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
                      <span v-if="r.passed" class="az-badge-pass">Pass</span>
                      <span v-else class="az-badge-fail">Excluded</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

        </div>

        <!-- ── PIPELINES TAB ────────────────────────────────────────────── -->
        <div v-show="activeTab === 'pipelines'" class="s-body pipelines-body">

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="plView === 'list'">
            <div class="tab-toolbar">
              <button class="ghost" @click="plCreating = !plCreating" :disabled="plBusy">＋ New Pipeline</button>
              <span v-if="plSummary" class="pl-summary">{{ plSummary }}</span>
            </div>
            <div v-if="plCreating" class="pl-create-row">
              <input v-model="plNewName" type="text" placeholder="Pipeline name…" class="pl-input"
                @keyup.enter="plCreate" @keyup.escape="plCreating = false; plNewName = ''" />
              <button class="ghost" :disabled="!plNewName.trim() || plBusy" @click="plCreate">Create</button>
              <button class="ghost" @click="plCreating = false; plNewName = ''">Cancel</button>
            </div>
            <ul v-if="pipelinesApi?.pipelines.value.length" class="pl-list">
              <li v-for="p in pipelinesApi.pipelines.value" :key="p.id"
                  class="pl-item" :class="{ 'pl-active': p.id === pipelinesApi.activePipelineId.value }"
                  @click="plEnterDetail(p.id)" role="button">
                <div class="pl-item-main">
                  <span class="pl-name">{{ p.name }}</span>
                  <span class="pl-meta">{{ p.stage_count }} stage(s)</span>
                  <span v-if="p.id === pipelinesApi.activePipelineId.value" class="pl-badge active">Default</span>
                  <span class="pl-enter">›</span>
                </div>
              </li>
            </ul>
            <p v-else class="hint">No pipelines loaded yet…</p>
          </template>

          <!-- ── DETAIL VIEW: pipeline + stage editor ───────────────────── -->
          <template v-else>
            <!-- Detail header: back + pipeline name (inline rename) + actions -->
            <div class="pl-detail-header">
              <button class="pl-back-btn" @click="plBackToList">← Back</button>
              <!-- Inline rename mode -->
              <template v-if="plRenamingId === plEditingId">
                <input v-model="plRenameText" class="pl-input pl-rename" autofocus
                  @keyup.enter="plConfirmRename" @keyup.escape="plRenamingId = ''" />
                <button class="ghost tiny" :disabled="plBusy" @click="plConfirmRename">✓</button>
                <button class="ghost tiny" @click="plRenamingId = ''">✕</button>
              </template>
              <!-- Display mode: title + pencil icon -->
              <template v-else>
                <h3 class="pl-detail-title">
                  {{ plCurrentPipeline?.name }}
                  <button class="pl-rename-icon" :disabled="plBusy"
                    @click="plStartRename(plEditingId, plCurrentPipeline?.name ?? '')"
                    title="Rename">✎</button>
                </h3>
              </template>
              <div class="pl-detail-actions">
                <button class="pl-delete-icon"
                  :disabled="plBusy || (pipelinesApi?.pipelines.value.length ?? 0) <= 1"
                  :title="(pipelinesApi?.pipelines.value.length ?? 0) <= 1 ? '至少保留一個 pipeline' : '刪除此 pipeline'"
                  @click="plDelete(plEditingId, plCurrentPipeline?.name ?? '')">
                  🗑
                </button>
                <span v-if="plEditingId === pipelinesApi?.activePipelineId.value" class="pl-badge active">預設</span>
                <button v-if="plEditingId !== pipelinesApi?.activePipelineId.value"
                  class="pl-set-default-btn" :disabled="plBusy" @click="plSetActive(plEditingId)">
                  ✓ 設為預設
                </button>
                <span v-if="plSummary" class="pl-summary">{{ plSummary }}</span>
                <button class="pl-run-btn"
                  @click="emit('open-pipeline', plEditingId); emit('close')"
                  title="關閉設定並前往執行">
                  ▶ 執行
                </button>
              </div>
            </div>

            <!-- Stage editor for this pipeline -->
            <div v-if="plStagesLoading" class="hint">載入階段中…</div>
            <template v-else>
              <div class="tab-toolbar">
                <button class="ghost" :disabled="sExportBusy" @click="sExport">{{ sExportBusy ? '…' : '⬇ Export JSON' }}</button>
                <button class="ghost" :disabled="sImporting" @click="sImport">{{ sImporting ? '…' : '⬆ Import JSON' }}</button>
                <span v-if="sSummary" class="summary-ok">{{ sSummary }}</span>
              </div>
              <div class="split">
                <aside class="split-list">
                  <button class="primary new-btn" @click="sStartNew">+ Add Stage</button>
                  <ul>
                    <li v-for="(s, idx) in sActiveStages" :key="s.id"
                        :class="{ active: sSelectedId === s.id && !sIsNew }"
                        @click="sSelectStage(s.id)">
                      <div class="row-g spread">
                        <span class="mono-key">{{ s.id }}</span>
                        <div class="row-g gap">
                          <button class="icon-btn" @click.stop="sMoveUp(idx)" :disabled="idx === 0">▲</button>
                          <button class="icon-btn" @click.stop="sMoveDown(idx)" :disabled="idx === sActiveStages.length - 1">▼</button>
                        </div>
                      </div>
                      <div class="item-label">
                        {{ s.shortTitle }}
                        <span v-if="s.slots.some(sl => sl.isCommander)" class="manager-badge" :title="`指揮官: ${s.slots.find(sl => sl.isCommander)?.label}`">🎯</span>
                      </div>
                      <div class="item-sub">
                        {{ s.slots.length === 1 ? `${s.slots[0].agentKey} · ${s.slots[0].roleKey}` : `${s.slots.length} parallel slots` }}
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
                  <div class="slots-section">
                    <div class="row-g spread">
                      <label class="lbl">Slots <span class="slot-required">* 必填至少一個</span></label>
                      <button class="ghost" @click="sStartAddSlot">+ Add slot</button>
                    </div>
                    <p v-if="!sDraft.slots?.length" class="warn-msg">請新增至少一個 slot 才能儲存。</p>
                    <template v-for="(slot, i) in sDraft.slots" :key="i">
                      <div v-if="sEditingSlotIndex !== i" class="slot-item slot-clickable" @click="sStartEditSlot(i)">
                        <div class="row-g spread">
                          <span class="item-label">{{ slot.label }}<span v-if="slot.isCommander" class="manager-badge">🎯 指揮官</span></span>
                          <button class="ghost danger-link" @click.stop="sRemoveSlot(i)" :disabled="sDraft.slots.length <= 1" title="最後一個 slot 無法刪除">✕</button>
                        </div>
                        <div class="item-sub">{{ slot.agentKey }} · {{ slot.roleKey }}</div>
                      </div>
                      <div v-else class="slot-form">
                        <div class="two-col">
                          <div class="field"><label class="lbl">Label</label><input v-model="sSlotDraft.label" type="text" /></div>
                          <div class="field"><label class="lbl">Agent</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                        </div>
                        <div class="field"><label class="lbl">Role key</label>
                          <select v-model="sSlotDraft.roleKey">
                            <option value="">（未指定）</option>
                            <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                          </select>
                        </div>
                        <label class="check-row manager-toggle">
                          <input type="checkbox" v-model="sSlotDraft.isCommander" />
                          <span><strong>🎯 指定為全域指揮官</strong> — 此 slot 先完成自己的工作後印 <code>---MANAGER-READY---</code>，再跨階段協調。整個 pipeline 只能有一個指揮官。</span>
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
                        <div class="field"><label class="lbl">Agent</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                      </div>
                      <div class="field"><label class="lbl">Role key</label>
                        <select v-model="sSlotDraft.roleKey">
                          <option value="">（未指定）</option>
                          <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                        </select>
                      </div>
                      <label class="check-row manager-toggle">
                        <input type="checkbox" v-model="sSlotDraft.isCommander" />
                        <span><strong>🎯 指定為全域指揮官</strong> — 整個 pipeline 只能有一個。</span>
                      </label>
                      <div class="field"><label class="lbl">Kickoff body</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false"></textarea></div>
                      <div class="row-g gap">
                        <button class="ghost" @click="sCancelAddSlot">Cancel</button>
                        <button class="primary" @click="sConfirmAddSlot">Add</button>
                      </div>
                    </div>
                  </div>
                </section>
                <section v-else class="split-detail empty-detail"><p>選擇一個階段或點 + Add Stage</p></section>
              </div>
            </template>
          </template>

        </div>

        <!-- ══ APPEARANCE TAB ══ -->
        <div v-show="activeTab === 'appearance'" class="s-body appearance-body">
          <section class="ap-section">
            <h3 class="ap-title">主題 Theme</h3>
            <p class="ap-hint">主題是使用者層級偏好，套用於所有工作區。</p>
            <div class="ap-theme-grid">
              <button
                v-for="t in BUILTIN_THEMES"
                :key="t.id"
                :class="['ap-theme-card', { active: currentTheme === t.id }]"
                @click="setTheme(t.id)"
              >
                <div class="ap-swatches">
                  <span
                    v-for="(c, i) in (THEME_SWATCHES[t.id] || [])"
                    :key="i"
                    class="ap-swatch"
                    :style="{ background: c }"
                  />
                </div>
                <span class="ap-theme-label">{{ t.label }}</span>
                <span v-if="currentTheme === t.id" class="ap-check">✓</span>
              </button>
            </div>
          </section>

          <section class="ap-section">
            <div class="ap-section-head">
              <h3 class="ap-title">自訂顏色 Custom Colors</h3>
              <button
                v-if="hasCustomOverrides"
                class="ap-reset"
                @click="resetCustom"
                title="清除所有自訂顏色，回到純內建主題"
              >
                ↺ 重設預設
              </button>
            </div>
            <p class="ap-hint">微調會疊加在目前主題之上，並在切換內建主題時保留。</p>
            <div class="ap-color-list">
              <label
                v-for="tok in CUSTOMIZABLE_TOKENS"
                :key="tok.id"
                class="ap-color-row"
              >
                <input
                  type="color"
                  class="ap-color-input"
                  :value="resolvedTokenValue(tok.id)"
                  @input="onPickColor(tok.id, ($event.target as HTMLInputElement).value)"
                />
                <span class="ap-color-name">{{ tok.label }}</span>
                <span class="ap-color-token">{{ tok.id }}</span>
                <button
                  v-if="customOverrides[tok.id]"
                  class="ap-color-clear"
                  @click.prevent="setCustomOverride(tok.id, null)"
                  title="清除此顏色覆寫"
                >✕</button>
              </label>
            </div>
          </section>

          <section class="ap-section">
            <h3 class="ap-title">環境設定 Environment</h3>
            <p class="ap-hint">重新執行首次啟動的環境偵測精靈（檢查 Homebrew / Node / CLI / Ollama 等）。</p>
            <button class="ap-reset" @click="emit('reopen-onboarding')">↻ 重新執行環境檢查</button>
          </section>
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
    <div v-if="false" class="s-overlay confirm">
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & modal shell ─────────────────────────────────────────────────── */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  z-index: 8000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.s-overlay.confirm { z-index: 9000; }

.s-modal {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
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
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
  flex-shrink: 0;
}
.s-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
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
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.s-tab:hover { background: var(--bg-subtle); color: var(--text-bright); }
.s-tab.active { background: #1f2937; border-color: var(--border-default); color: var(--accent-fg); }

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { padding: 18px 22px; overflow-y: auto; }
.ap-section { margin-bottom: 26px; }
.ap-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ap-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--text-bright); }
.ap-hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-secondary); }
.ap-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.ap-theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  text-align: left;
}
.ap-theme-card:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-theme-card.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-swatches { display: flex; gap: 4px; }
.ap-swatch { width: 24px; height: 24px; border-radius: 5px; border: 1px solid var(--border-muted); }
.ap-theme-label { font-size: 12px; font-weight: 500; color: var(--text-primary); }
.ap-check { position: absolute; top: 10px; right: 11px; font-size: 12px; color: var(--accent-fg); }
.ap-reset {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ap-reset:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.ap-color-list { display: flex; flex-direction: column; gap: 8px; }
.ap-color-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.ap-color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.ap-color-name { font-size: 12px; color: var(--text-primary); min-width: 92px; }
.ap-color-token { font-size: 10.5px; color: var(--text-muted); font-family: ui-monospace, monospace; flex: 1; }
.ap-color-clear {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
}
.ap-color-clear:hover { color: var(--danger-fg); background: var(--bg-muted); }
.s-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  line-height: 1;
}
.s-close:hover { background: var(--bg-muted); color: var(--text-bright); }

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
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.tab-toolbar button { font-size: 11px; padding: 5px 10px; }
.summary-ok { font-size: 11px; color: var(--success-fg); margin-left: 6px; }

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
  border-right: 1px solid var(--border-muted);
  background: var(--bg-inset);
  overflow-y: auto;
  min-height: 0;
}
.split-list .new-btn { margin: 10px 10px 6px; font-size: 12px; }
.split-list ul { list-style: none; margin: 0; padding: 0; }
.split-list li { padding: 9px 12px; border-bottom: 1px solid var(--bg-subtle); cursor: pointer; }
.split-list li:hover { background: var(--bg-subtle); }
.split-list li.active { background: var(--accent-muted); }
.split-detail { padding: 14px 18px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.empty-detail { align-items: center; justify-content: center; color: var(--text-muted); }

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
input[type='text'], input[type='email'], textarea, select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 7px 9px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  box-sizing: border-box;
  width: 100%;
}
textarea { font-family: Menlo, Monaco, monospace; resize: vertical; line-height: 1.5; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-emphasis); }
input:disabled { opacity: 0.5; cursor: not-allowed; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.detail-head h3 { margin: 0; font-size: 14px; }
.check-row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
.check-row input[type='checkbox'] { width: 14px; height: 14px; accent-color: var(--accent-fg); }

/* ── List items ───────────────────────────────────────────────────────────── */
.row-g { display: flex; align-items: center; gap: 6px; }
.row-g.gap { gap: 8px; }
.row-g.spread { justify-content: space-between; }
.mono-key { font-family: Menlo, Monaco, monospace; font-size: 10px; color: var(--accent-bright); }
.badge { background: var(--bg-muted); color: var(--text-secondary); font-size: 9px; padding: 1px 5px; border-radius: 3px; }
.item-label { font-weight: 600; font-size: 12px; margin-top: 2px; }
.item-sub { color: var(--text-secondary); font-size: 11px; margin-top: 1px; }
.icon-btn { border: 1px solid var(--border-default); background: var(--bg-muted); color: var(--text-secondary); font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); font-weight: 600; }
button.primary:not(:disabled):hover { background: var(--success-strong); }
button.danger { background: var(--danger-deep); border-color: var(--danger-muted); color: #f4d2d2; }
button.danger:hover { background: var(--danger-muted); }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--bg-muted); }
.danger-link { color: var(--danger-fg); border-color: transparent; background: transparent; }
.danger-link:hover { background: rgba(248,81,73,0.1) !important; }

/* ── Messages ─────────────────────────────────────────────────────────────── */
.err-msg { color: var(--danger-fg); font-size: 11px; margin: 0; }
.warn-msg { color: var(--attention-fg); font-size: 11px; margin: 0; }
.hint-msg { color: var(--text-secondary); font-size: 11px; margin: 0; }

/* ── Manager designation (per-slot) ───────────────────────────────────────── */
.manager-toggle { font-size: 11px; line-height: 1.55; padding: 6px 8px; border: 1px solid rgba(216, 180, 109, 0.25); border-radius: 6px; background: rgba(216, 180, 109, 0.04); }
.manager-toggle strong { color: #d8b46d; }
.manager-toggle code { background: var(--bg-subtle); padding: 1px 4px; border-radius: 3px; font-size: 10px; color: var(--text-bright); }
.manager-badge { font-size: 9px; color: #d8b46d; background: rgba(216, 180, 109, 0.12); border: 1px solid rgba(216, 180, 109, 0.3); border-radius: 8px; padding: 1px 6px; margin-left: 6px; font-weight: 600; }

/* ── Slots ────────────────────────────────────────────────────────────────── */
.slots-section { border-top: 1px solid var(--border-muted); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.slot-required { color: var(--danger-fg); font-size: 9px; font-weight: 400; text-transform: none; margin-left: 4px; }
.slot-item { background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 6px; padding: 8px 10px; }
.slot-clickable { cursor: pointer; transition: border-color 0.15s; }
.slot-clickable:hover { border-color: var(--accent-focus); }
.slot-form { background: var(--bg-base); border: 1px solid var(--border-default); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }

/* ── MCP tab ──────────────────────────────────────────────────────────────── */
.mcp-body { overflow-y: auto; display: flex; flex-direction: column; }

/* Top bar */
.mcp-topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; background: var(--bg-inset);
}
.mcp-page-title { font-size: 13px; font-weight: 700; color: var(--text-bright); flex: 1; }
.mcp-topbar-actions { display: flex; gap: 8px; }
.mcp-action-btn {
  font-size: 11px; padding: 5px 11px; border-radius: 6px;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-bright); cursor: pointer;
}
.mcp-action-btn:hover:not(:disabled) { background: var(--border-default); }
.mcp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mcp-back-btn {
  font-size: 12px; padding: 4px 10px; border-radius: 5px;
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer;
}
.mcp-back-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.mcp-summary-ok { font-size: 11px; color: var(--success-fg); padding: 4px 16px; }

/* Server list */
.mcp-server-list { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; }
.mcp-loading { color: var(--text-secondary); font-size: 12px; padding: 8px 0; }
.mcp-empty { color: var(--text-muted); font-size: 12px; padding: 24px 0; text-align: center; }

/* Server card */
.mcp-server-card {
  background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 10px;
  display: flex; flex-direction: column; overflow: hidden;
}

/* Main row: dot + name + trash + toggle */
.mcp-server-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; min-height: 44px;
}
.mcp-spacer { flex: 1; }
.mcp-server-name { font-weight: 700; font-size: 13px; color: var(--text-bright); }

/* Status dot */
.mcp-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.mcp-dot.connected { background: var(--success-fg); box-shadow: 0 0 6px rgba(63,185,80,0.6); }
.mcp-dot.error     { background: var(--danger-fg); }
.mcp-dot.disabled  { background: var(--text-disabled); }
.mcp-dot.unknown   { background: var(--text-disabled); }

/* Delete button */
.mcp-delete-btn {
  border: none; background: transparent; color: var(--text-disabled);
  font-size: 14px; cursor: pointer; padding: 2px 4px; border-radius: 4px; line-height: 1;
}
.mcp-delete-btn:hover { color: var(--danger-fg); background: rgba(248,81,73,0.1); }
.mcp-delete-btn.small { font-size: 10px; color: var(--text-muted); }
.mcp-delete-btn.small:hover { color: var(--danger-fg); }

/* Toggle switch (iOS-style) */
.mcp-toggle {
  width: 40px; height: 22px; border-radius: 11px; border: none;
  background: var(--text-disabled); padding: 0; cursor: pointer;
  display: flex; align-items: center; transition: background 0.2s;
  flex-shrink: 0; position: relative;
}
.mcp-toggle.on { background: var(--accent-emphasis); }
.mcp-toggle-thumb {
  width: 18px; height: 18px; border-radius: 50%; background: var(--text-on-emphasis);
  position: absolute; left: 2px; transition: left 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
.mcp-toggle.on .mcp-toggle-thumb { left: 20px; }

/* Tools row */
.mcp-tools-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-top: 1px solid var(--border-muted);
  font-size: 11px; color: var(--text-secondary); cursor: pointer; user-select: none;
}
.mcp-tools-row:hover { background: var(--bg-elevated); }
.mcp-tools-error { color: var(--danger-fg); cursor: default; }
.mcp-tools-disabled { color: var(--text-disabled); cursor: default; }
.mcp-chevron { font-size: 12px; transition: transform 0.15s; display: inline-block; }
.mcp-chevron.open { transform: rotate(90deg); }
.mcp-tool-count { font-size: 11px; }

/* Tool list */
.mcp-tool-list {
  list-style: none; margin: 0; padding: 6px 14px 10px 28px;
  border-top: 1px solid var(--bg-subtle); display: flex; flex-direction: column; gap: 3px;
}
.mcp-tool-list li { font-size: 11px; color: var(--text-secondary); }
.mcp-tool-name { color: var(--accent-bright); font-family: Menlo, Monaco, monospace; }
.mcp-tool-desc { color: var(--text-muted); }

/* Config form toggle */
.mcp-config-toggle {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 14px; border-top: 1px solid var(--border-muted);
  font-size: 11px; color: var(--text-muted); cursor: pointer; user-select: none;
}
.mcp-config-toggle:hover { background: var(--bg-elevated); color: var(--text-secondary); }
.mcp-config-form {
  padding: 10px 14px; border-top: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 8px; background: var(--bg-base);
}

/* Env vars editor */
.mcp-env-row { display: flex; align-items: center; gap: 6px; }
.mcp-env-key { width: 140px; flex-shrink: 0; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-env-val { flex: 1; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-add-env-btn {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer; margin-left: 6px;
}
.mcp-add-env-btn:hover { background: var(--bg-muted); color: var(--text-bright); }

/* Catalog view */
.mcp-search-wrap {
  position: relative; padding: 12px 16px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-search {
  width: 100%; padding: 8px 36px 8px 12px; border-radius: 8px;
  background: var(--bg-subtle); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: 12px; box-sizing: border-box;
}
.mcp-search:focus { outline: none; border-color: var(--accent-emphasis); }
.mcp-search-icon {
  position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
  font-size: 13px; color: var(--text-muted); pointer-events: none;
}

.mcp-catalog-hint {
  padding: 8px 16px; font-size: 11px; color: var(--text-secondary); line-height: 1.6;
  background: var(--bg-base); border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-catalog-hint strong { color: var(--text-bright); }
.mcp-catalog-list {
  padding: 10px 16px; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; flex: 1;
}
.mcp-catalog-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 2px; border-bottom: 1px solid var(--border-muted);
}
.mcp-catalog-card:last-child { border-bottom: none; }
.mcp-catalog-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.mcp-catalog-name { font-size: 13px; font-weight: 700; color: var(--text-bright); }
.mcp-catalog-desc { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
.mcp-catalog-note { font-size: 10px; color: var(--attention-fg); margin-top: 2px; }
.mcp-add-btn {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: var(--accent-emphasis); border: 1px solid var(--accent-focus); color: var(--text-on-emphasis); font-weight: 600; cursor: pointer;
}
.mcp-add-btn:hover:not(:disabled) { background: var(--accent-focus); }
.mcp-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mcp-installed-badge {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-muted); cursor: not-allowed;
}

/* ── Confirm dialog ───────────────────────────────────────────────────────── */
.confirm-card {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px 24px;
  max-width: 400px;
  width: 90%;
}
.confirm-card h3 { margin: 0 0 8px; font-size: 14px; }
.confirm-card p { font-size: 12px; color: var(--text-primary); margin: 0 0 16px; }

/* ── Analyzer tab ─────────────────────────────────────────────────────────── */
.analyzer-body { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 0; }

.az-section {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.az-section-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.az-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.az-section-header .az-section-title { margin-bottom: 0; }
.az-section-note { font-size: 10px; color: var(--text-muted); }
.az-subsection { margin-top: 12px; }
.az-status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.az-status-dot.ok { background: var(--success-fg); }
.az-status-dot.err { background: var(--danger-fg); }
.az-pct { font-weight: 600; color: var(--text-bright); margin-left: 6px; }
.az-size-info { color: var(--text-muted); font-size: 11px; margin-left: 4px; }
.az-gguf-hint { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
.az-gguf-hint code { background: var(--bg-subtle); padding: 1px 4px; border-radius: 3px; color: var(--text-bright); }
.az-link { color: var(--accent-fg); text-decoration: none; }
.az-link:hover { text-decoration: underline; }
.az-code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--text-bright); font-family: monospace; }
.az-url-row { display: flex; gap: 6px; align-items: center; }
.az-url-row .az-input { flex: 1; }
.az-recheck-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 14px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; transition: color 0.15s, background 0.15s;
}
.az-recheck-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-recheck-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-detect-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 11px; font-weight: 500; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; white-space: nowrap; transition: color 0.15s, background 0.15s;
}
.az-detect-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-browse-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 13px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; transition: color 0.15s, background 0.15s;
}
.az-browse-btn:hover { background: var(--border-default); color: var(--text-bright); }

.az-backend-toggle { display: flex; gap: 0; border: 1px solid var(--border-default); border-radius: 6px; overflow: hidden; width: fit-content; }
.az-backend-btn {
  background: var(--bg-subtle); border: none; color: var(--text-secondary); font-size: 12px;
  padding: 6px 16px; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.az-backend-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.az-backend-btn.active { background: var(--accent-emphasis); color: var(--text-on-emphasis); font-weight: 600; }

.az-label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 5px; }
.az-hint-inline { color: var(--text-muted); font-style: italic; }
.az-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-base); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: 12px; padding: 7px 10px; border-radius: 6px;
  outline: none; transition: border-color 0.15s;
}
.az-input:focus { border-color: var(--accent-focus); }
.az-status-row { margin-top: 8px; }

.az-pull-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.az-pull-input { flex: 1; margin-bottom: 0; }
.az-pull-error { font-size: 11px; color: var(--danger-fg); margin-top: 6px; }

.az-progress-bar-wrap {
  height: 4px; background: var(--bg-muted); border-radius: 2px; margin-top: 6px; overflow: hidden;
}
.az-progress-bar { height: 100%; background: var(--accent-emphasis); border-radius: 2px; transition: width 0.3s; }

.az-model-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.az-no-models { font-size: 12px; color: var(--text-muted); padding: 8px 0; }
.az-model-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; background: var(--bg-base); border: 1px solid var(--border-muted); border-radius: 6px;
}
.az-model-info { display: flex; flex-direction: column; gap: 2px; }
.az-model-name { font-size: 12px; color: var(--text-bright); font-family: monospace; }
.az-model-meta { font-size: 10px; color: var(--text-secondary); }
.az-del-btn {
  background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px;
  padding: 2px 6px; border-radius: 4px; transition: color 0.15s, background 0.15s;
}
.az-del-btn:hover { color: var(--danger-fg); background: var(--bg-muted); }

.az-benchmark-section { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0; }

.az-version { font-size: 11px; color: var(--text-secondary); }
.az-version.offline { color: var(--danger-fg); }
.az-run-btn {
  background: var(--accent-emphasis);
  border: 1px solid var(--accent-focus);
  color: var(--text-on-emphasis);
  font-size: 12px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.az-run-btn:hover:not(:disabled) { background: var(--accent-focus); }
.az-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.az-progress-wrap {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
  flex-shrink: 0;
}
.az-progress-label { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.az-spin { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.az-hint {
  padding: 20px 24px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.az-hint p { margin: 0 0 10px; }
.az-hint ul { margin: 0 0 10px; padding-left: 18px; }
.az-hint li { margin-bottom: 4px; }
.az-hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--text-bright); }
.az-pass-rule { color: var(--accent-fg); font-size: 11px; }

.az-results { padding: 16px 20px; flex: 1; overflow-y: auto; }
.az-results-summary {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.az-results-summary strong { color: var(--success-fg); }

.az-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.az-table th {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-weight: 500;
  white-space: nowrap;
}
.az-th-task, .az-th-score, .az-th-verdict { text-align: center; }
.az-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg-subtle); vertical-align: middle; }
.az-td-model { font-family: monospace; font-size: 11px; color: var(--text-bright); }
.az-td-task { text-align: center; white-space: nowrap; }
.az-td-score { text-align: center; color: var(--text-secondary); }
.az-td-verdict { text-align: center; }
.az-elapsed { font-size: 10px; color: var(--text-secondary); margin-left: 3px; }
.az-na { color: var(--text-disabled); }
.az-row-fail td { color: var(--text-disabled); }
.az-row-fail .az-td-model { color: var(--text-muted); }
.az-badge-pass {
  background: rgba(63, 185, 80, 0.15);
  color: var(--success-fg);
  border: 1px solid rgba(63,185,80,0.3);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.az-badge-fail {
  background: rgba(248, 81, 73, 0.1);
  color: var(--text-muted);
  border: 1px solid var(--border-muted);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}
/* ── Pipelines tab ─────────────────────────────────────────────────────────── */
.pipelines-body { display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.pl-create-row { display: flex; gap: 6px; align-items: center; }
.pl-input {
  background: var(--bg-inset); border: 1px solid var(--accent-emphasis); border-radius: 4px;
  color: var(--text-bright); font-size: 12px; padding: 5px 8px; flex: 1;
}
.pl-rename { max-width: 180px; }
.pl-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pl-item {
  background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 6px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.pl-item.pl-active { border-color: var(--accent-emphasis); background: var(--accent-subtle); }
.pl-item-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pl-name { font-size: 13px; font-weight: 600; color: var(--text-bright); flex: 1; }
.pl-active .pl-name { color: var(--accent-bright); }
.pl-meta { font-size: 11px; color: var(--text-muted); }
.pl-badge { font-size: 11px; padding: 3px 10px; border-radius: 20px; font-weight: 600; letter-spacing: 0.02em; }
.pl-badge.active { background: rgba(63,185,80,0.12); color: var(--success-fg); border: 1px solid rgba(46,160,67,0.45); }
.pl-item-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pl-summary { font-size: 12px; color: var(--success-fg); }
.pl-enter { color: var(--text-muted); font-size: 14px; }
.pl-item:hover .pl-enter { color: var(--text-bright); }
.pl-item { cursor: pointer; }
.pl-back-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; border: 1px solid var(--border-default); border-radius: 6px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 10px; cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-back-btn:hover { color: var(--text-bright); background: var(--bg-muted); border-color: var(--border-strong); }
.pl-set-default-btn {
  display: inline-flex; align-items: center; gap: 3px;
  background: transparent; border: 1px solid var(--border-default); border-radius: 6px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 10px; cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-set-default-btn:hover:not(:disabled) { color: var(--success-fg); background: rgba(63,185,80,0.08); border-color: rgba(63,185,80,0.35); }
.pl-set-default-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pl-run-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: rgba(35,134,54,0.9); border: 1px solid var(--success-fg); border-radius: 6px;
  color: var(--text-on-emphasis); font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  padding: 5px 14px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.pl-run-btn:hover { background: var(--success-strong); border-color: var(--success-bright); box-shadow: 0 0 0 3px rgba(63,185,80,0.18); }
.pl-delete-icon {
  background: none; border: 1px solid transparent; cursor: pointer;
  color: var(--text-muted); font-size: 14px; padding: 4px 6px; border-radius: 5px;
  opacity: 0.55; transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-delete-icon:hover:not(:disabled) { opacity: 1; color: var(--danger-fg); background: rgba(248,81,73,0.08); border-color: rgba(248,81,73,0.2); }
.pl-delete-icon:disabled { opacity: 0.2; cursor: not-allowed; }
.pl-detail-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 4px 0 12px; border-bottom: 1px solid var(--border-muted); margin-bottom: 6px; min-height: 36px;
}
.pl-detail-title { font-size: 15px; font-weight: 600; color: var(--accent-bright); margin: 0; flex: 1; display: flex; align-items: center; gap: 6px; }
.pl-rename-icon {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  font-size: 13px; padding: 2px 5px; border-radius: 4px; line-height: 1;
  opacity: 0.75; transition: opacity 0.15s, color 0.15s, background 0.15s;
}
.pl-rename-icon:hover { opacity: 1; color: var(--text-bright); background: var(--bg-muted); }
.pl-detail-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }
</style>
