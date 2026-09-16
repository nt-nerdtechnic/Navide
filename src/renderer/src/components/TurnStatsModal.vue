<script setup lang="ts">
// Turn Stats modal: one CLI pane's token usage cut per turn (a prompt sent →
// the CLI done replying), with a total at the bottom. Hosted inside the main
// window like the Resource Manager, and reached the same way (Window menu).
//
// It owns no pane state: the host passes this window's pane views in, and the
// figures come from the backend's on-demand transcript scan (`tokens.turns`).
// Nothing here is accumulated — every open or rescan re-reads the transcript,
// which is why an old session still adds up as long as its file exists.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../composables/useBackend'
import { useTokenTurns, type TokenTurn, type TurnMethod } from '../composables/useTokenTurns'

/** The subset of ActivePaneView this modal reads. */
export interface TurnStatsPane {
  id: string
  agentKey: string
  /** Display name (custom or auto name, falling back to the vendor label). */
  agentLabel: string
  /** 'waiting' is a cold-restore placeholder — listed, since its transcript
   *  is still on disk and the backend can resolve it by pane id. */
  status: string
  sessionId?: string
}

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
  panes: TurnStatsPane[]
  /** The pane the user is looking at; preselected when the modal opens. */
  activePaneId?: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

// Vendors whose transcripts carry no token usage at all (protobuf blobs the
// reader cannot read). Greyed out in the picker rather than hidden, so the
// user learns why rather than wondering where the pane went.
const NO_TOKEN_VENDORS = new Set(['antigravity', 'cursor'])
const VENDOR_LABEL: Record<string, string> = Object.fromEntries(
  CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])
)

function vendorLabel(agentKey: string): string {
  return VENDOR_LABEL[agentKey] ?? agentKey
}
function vendorUnsupported(agentKey: string): boolean {
  return NO_TOKEN_VENDORS.has(agentKey)
}

// ── Pane picker ─────────────────────────────────────────────────────────────
const cliPanes = computed(() => props.panes.filter((p) => p.agentKey !== 'terminal'))
const selectedPaneId = ref('')
const selectedPane = computed(() => cliPanes.value.find((p) => p.id === selectedPaneId.value) ?? null)

function defaultPaneId(): string {
  const active = cliPanes.value.find((p) => p.id === props.activePaneId)
  if (active && !vendorUnsupported(active.agentKey)) return active.id
  return cliPanes.value.find((p) => !vendorUnsupported(p.agentKey))?.id ?? cliPanes.value[0]?.id ?? ''
}

function paneOptionLabel(p: TurnStatsPane): string {
  const base = `${p.agentLabel} (${vendorLabel(p.agentKey)})`
  if (vendorUnsupported(p.agentKey)) return `${base} · ${t('turn-stats.no-token-usage')}`
  if (p.status === 'waiting') return `${base} · ${t('turn-stats.pane-placeholder')}`
  return base
}

// ── The scan ────────────────────────────────────────────────────────────────
const turnsApi = useTokenTurns(props.backend)
const expanded = ref(new Set<number>())

function rescan(): void {
  expanded.value = new Set()
  // Drop the previous answer first: figures for the pane the user just left
  // must not sit under the new pane's name while the scan runs.
  turnsApi.clear()
  const pane = selectedPane.value
  // A vendor without token usage is known ahead of time — no point asking
  // the backend to open the file.
  if (!pane || vendorUnsupported(pane.agentKey)) return
  // Calls come along on the first request so expanding a row never waits on
  // a second scan of a transcript this size.
  void turnsApi.load({ paneId: pane.id, sessionId: pane.sessionId, agentKey: pane.agentKey }, { includeCalls: true })
}

// Opening picks the pane; the scan then follows (open, pane) as one watcher,
// so an open that also changes the pick scans once, and reopening on the same
// pane still rescans.
watch(
  () => props.open,
  (open) => {
    if (open) selectedPaneId.value = defaultPaneId()
  },
  { immediate: true }
)
watch(
  () => [props.open, selectedPaneId.value] as const,
  ([open]) => {
    if (open) rescan()
  },
  { immediate: true }
)

// ── Rows ────────────────────────────────────────────────────────────────────
const result = computed(() => turnsApi.data.value)
/** Newest first: the turn just finished is the one the user came to check. */
const rows = computed<TokenTurn[]>(() => [...(result.value?.turns ?? [])].reverse())
const method = computed<TurnMethod | ''>(() => result.value?.method ?? '')

type Panel = 'no-panes' | 'unsupported' | 'loading' | 'error' | 'empty' | 'table'
const panel = computed<Panel>(() => {
  const pane = selectedPane.value
  if (!pane) return 'no-panes'
  if (vendorUnsupported(pane.agentKey)) return 'unsupported'
  if (turnsApi.loading.value && !result.value) return 'loading'
  if (turnsApi.error.value) return 'error'
  if (!result.value || result.value.method === 'unsupported') return 'unsupported'
  if (result.value.turns.length === 0) return 'empty'
  return 'table'
})

const KNOWN_ERRORS = new Set(['no-session', 'file-missing', 'unknown-vendor', 'scan-failed'])
const errorText = computed(() => {
  const code = turnsApi.error.value
  if (KNOWN_ERRORS.has(code)) return t(`turn-stats.error-${code}`)
  return t('turn-stats.error-generic', { detail: turnsApi.errorDetail.value || code })
})

function toggle(turnIndex: number): void {
  const next = new Set(expanded.value)
  if (next.has(turnIndex)) next.delete(turnIndex)
  else next.add(turnIndex)
  expanded.value = next
}

// ── Formatting ──────────────────────────────────────────────────────────────
function num(n: number): string {
  return n.toLocaleString('en-US')
}
// Same tiers as the Token panel: the headline must not stretch past "1.5M".
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return (n / 1_000_000_000).toFixed(1) + 'B'
}
function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const two = (v: number): string => String(v).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
const shortSession = computed(() => {
  const id = result.value?.session_id ?? selectedPane.value?.sessionId ?? ''
  return id.length > 8 ? id.slice(0, 8) + '…' : id
})

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_HEADER = [
  'turn', 'started_at', 'ended_at', 'prompt', 'input', 'cache_read', 'cache_creation', 'output', 'total', 'calls'
]
function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** Oldest first, the way the transcript reads; exported for the test. */
function buildCsv(turns: TokenTurn[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of turns) {
    lines.push(
      [r.turn_index, r.started_at, r.ended_at, r.prompt_excerpt, r.input, r.cache_read, r.cache_creation, r.output, r.total, r.calls]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\n') + '\n'
}
function exportCsv(): void {
  const res = result.value
  if (!res || res.turns.length === 0) return
  const blob = new Blob([buildCsv(res.turns)], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `turn-stats-${res.vendor}-${res.session_id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

defineExpose({ buildCsv })
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="ts-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="ts-modal nv-modal-shell nv-modal-shell--wide" @click.stop>
        <div class="ts-head">
          <span class="ts-title">{{ t('turn-stats.title') }}</span>
          <button class="ts-close" data-act="close" :title="t('turn-stats.close')" @click="emit('close')">✕</button>
        </div>

        <div class="ts-toolbar">
          <label class="ts-pick">
            <span>{{ t('turn-stats.pane') }}</span>
            <select v-model="selectedPaneId" data-act="pane" :disabled="cliPanes.length === 0">
              <option
                v-for="p in cliPanes"
                :key="p.id"
                :value="p.id"
                :disabled="vendorUnsupported(p.agentKey)"
                :data-vendor="p.agentKey"
              >
                {{ paneOptionLabel(p) }}
              </option>
            </select>
          </label>
          <span v-if="shortSession" class="ts-session" data-part="session" :title="result?.session_id">
            {{ t('turn-stats.session') }} {{ shortSession }}
          </span>
          <span class="ts-spacer" />
          <button class="ts-ghost" data-act="export" :disabled="panel !== 'table'" @click="exportCsv">
            {{ t('turn-stats.export') }}
          </button>
          <button class="ts-ghost" data-act="rescan" :disabled="!selectedPane || turnsApi.loading.value" @click="rescan">
            {{ t('turn-stats.rescan') }}
          </button>
        </div>

        <div v-if="result && panel === 'table'" class="ts-summary">
          <span class="ts-summary-main" data-part="summary">
            {{ t('turn-stats.summary', {
              turns: result.turns.length,
              calls: num(result.totals.calls),
              total: compact(result.totals.total),
            }) }}
          </span>
          <span class="ts-method" :data-method="method">
            {{ method === 'exact' ? t('turn-stats.method-exact') : t('turn-stats.method-inferred') }}
          </span>
          <span v-if="method === 'inferred'" class="ts-method-note" data-part="method-note">
            {{ t('turn-stats.method-inferred-note') }}
          </span>
        </div>

        <div class="ts-body">
          <p v-if="panel === 'no-panes'" class="ts-empty" data-state="no-panes">{{ t('turn-stats.empty-panes') }}</p>
          <p v-else-if="panel === 'unsupported'" class="ts-empty" data-state="unsupported">
            {{ t('turn-stats.method-unsupported') }}
          </p>
          <p v-else-if="panel === 'loading'" class="ts-empty" data-state="loading">{{ t('turn-stats.scanning') }}</p>
          <p v-else-if="panel === 'error'" class="ts-empty ts-error" data-state="error">{{ errorText }}</p>
          <p v-else-if="panel === 'empty'" class="ts-empty" data-state="empty">{{ t('turn-stats.empty-turns') }}</p>
          <table v-else class="ts-table" data-state="table">
            <thead>
              <tr>
                <th class="c-idx">#</th>
                <th class="c-time">{{ t('turn-stats.col-time') }}</th>
                <th class="c-prompt">{{ t('turn-stats.col-prompt') }}</th>
                <th class="c-num">{{ t('turn-stats.col-input') }}</th>
                <th class="c-num">{{ t('turn-stats.col-cache-read') }}</th>
                <th class="c-num">{{ t('turn-stats.col-cache-write') }}</th>
                <th class="c-num">{{ t('turn-stats.col-output') }}</th>
                <th class="c-num c-total">{{ t('turn-stats.col-total') }}</th>
                <th class="c-num">{{ t('turn-stats.col-calls') }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in rows" :key="r.turn_index">
                <tr
                  class="ts-row"
                  data-row="turn"
                  :data-turn="r.turn_index"
                  :data-expanded="expanded.has(r.turn_index) ? 'true' : 'false'"
                  @click="toggle(r.turn_index)"
                >
                  <td class="c-idx">{{ r.turn_index }}</td>
                  <td class="c-time">{{ clock(r.started_at) }}</td>
                  <td class="c-prompt" :title="r.prompt_excerpt">
                    <span :class="{ 'ts-no-prompt': !r.prompt_excerpt }">
                      {{ r.prompt_excerpt || t('turn-stats.no-prompt') }}
                    </span>
                  </td>
                  <td class="c-num" data-part="input">{{ num(r.input) }}</td>
                  <td class="c-num" data-part="cache-read">{{ num(r.cache_read) }}</td>
                  <td class="c-num" data-part="cache-write">{{ num(r.cache_creation) }}</td>
                  <td class="c-num" data-part="output">{{ num(r.output) }}</td>
                  <td class="c-num c-total" data-part="total">{{ num(r.total) }}</td>
                  <td class="c-num" data-part="calls">{{ num(r.calls) }}</td>
                </tr>
                <tr v-if="expanded.has(r.turn_index)" class="ts-detail" data-row="detail" :data-turn="r.turn_index">
                  <td colspan="9">
                    <p v-if="!r.calls_detail?.length" class="ts-detail-empty">{{ t('turn-stats.no-calls') }}</p>
                    <table v-else class="ts-calls">
                      <tbody>
                        <tr v-for="(c, i) in r.calls_detail" :key="i" data-row="call">
                          <td class="c-time">{{ clock(c.ts) }}</td>
                          <td class="c-model">{{ c.model }}</td>
                          <td class="c-num">{{ num(c.input) }}</td>
                          <td class="c-num">{{ num(c.cache_read) }}</td>
                          <td class="c-num">{{ num(c.cache_creation) }}</td>
                          <td class="c-num">{{ num(c.output) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
            <tfoot v-if="result">
              <tr class="ts-total" data-row="totals">
                <td class="c-idx" />
                <td class="c-time" />
                <td class="c-prompt">{{ t('turn-stats.row-total') }}</td>
                <td class="c-num" data-part="input">{{ num(result.totals.input) }}</td>
                <td class="c-num" data-part="cache-read">{{ num(result.totals.cache_read) }}</td>
                <td class="c-num" data-part="cache-write">{{ num(result.totals.cache_creation) }}</td>
                <td class="c-num" data-part="output">{{ num(result.totals.output) }}</td>
                <td class="c-num c-total" data-part="total">{{ num(result.totals.total) }}</td>
                <td class="c-num" data-part="calls">{{ num(result.totals.calls) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="ts-foot">
          <span class="ts-foot-note" data-part="note">{{ t('turn-stats.note') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* `.nv-modal-overlay` only skins the scrim — every modal positions its own
 * overlay (see ResourceManagerModal for the shipped bug behind this). */
.ts-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.ts-modal {
  width: min(var(--modal-w-wide), 92vw);
  height: min(760px, 86vh);
  display: flex;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
}
.ts-spacer { flex: 1; }

.ts-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.ts-title {
  flex: 1;
  font-weight: 600;
  font-size: var(--font-md);
  color: var(--text-bright);
}
.ts-close {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 3px 9px;
  font-size: var(--font-2xs);
  cursor: pointer;
}
.ts-close:hover { color: var(--text-bright); }

.ts-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.ts-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--font-2xs);
}
.ts-pick select { max-width: 360px; }
.ts-session {
  color: var(--text-muted);
  font-size: var(--font-2xs);
  font-variant-numeric: tabular-nums;
}
.ts-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.ts-ghost:hover { color: var(--text-bright); }
.ts-ghost:disabled { color: var(--text-disabled); cursor: default; }

.ts-summary {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.ts-summary-main {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
  font-variant-numeric: tabular-nums;
}
.ts-method {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-3xs);
}
.ts-method[data-method='inferred'] {
  background: transparent;
  color: var(--warning-fg);
  border: 1px solid var(--warning-fg);
}
.ts-method-note { color: var(--text-muted); font-size: var(--font-3xs); }

.ts-body {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
}
.ts-empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}
.ts-error { color: var(--attention-fg); }

.ts-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.ts-table th,
.ts-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
.ts-table th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-weight: 400;
  font-size: var(--font-3xs);
  text-align: left;
}
.ts-table th:first-child,
.ts-table td:first-child { padding-left: 16px; }
.ts-table th:last-child,
.ts-table td:last-child { padding-right: 16px; }
.c-idx { width: 3ch; color: var(--text-muted); text-align: right; }
.c-time { width: 9ch; color: var(--text-muted); }
.c-prompt {
  max-width: 0;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}
.ts-no-prompt { color: var(--text-muted); font-style: italic; }
.ts-table th.c-num,
.ts-table td.c-num { text-align: right; }
.c-total { color: var(--text-bright); font-weight: 600; }
.ts-row { cursor: pointer; }
.ts-row:hover { background: var(--bg-hover-faint); }
.ts-row[data-expanded='true'] { background: var(--bg-hover-faint); }

.ts-detail td {
  padding: 4px 16px 8px 40px;
  background: var(--bg-subtle);
}
.ts-detail-empty { margin: 0; color: var(--text-muted); font-size: var(--font-3xs); }
.ts-calls { border-collapse: collapse; font-size: var(--font-3xs); }
.ts-calls td { padding: 2px 10px 2px 0; border: 0; color: var(--text-muted); }
.ts-calls .c-model { color: var(--text-secondary); }

.ts-total td {
  border-top: 1px solid var(--border-default);
  border-bottom: 0;
  color: var(--text-bright);
  font-weight: 600;
  background: var(--bg-subtle);
}

.ts-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.ts-foot-note { line-height: 1.45; }
</style>
