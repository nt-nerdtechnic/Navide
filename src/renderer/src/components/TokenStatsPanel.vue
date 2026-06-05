<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import { useTokens, type TokenBucket, type ResetScope } from '../composables/useTokens'
import { useNotify } from '../composables/useNotify'
import type { useBackend } from '../composables/useBackend'
import HistoryPanel from './HistoryPanel.vue'
import type { PipelineStatusView } from './ControlPane.vue'

interface Stage {
  id: string
  shortTitle?: string
  title?: string
}

interface ActivePane {
  id: string
  agentLabel: string
  roleLabel: string
  stageId?: string
  slotLabel?: string
}

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  stages: Stage[]
  panes: ActivePane[]
  pipeline: PipelineStatusView
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:expanded', v: boolean): void }>()

// We expose the workspace path as a ref so useTokens can watch() it.
const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { snapshot, loading, reset } = useTokens(props.backend, workspacePathRef)

// ─────────────────────── Sticky panel state ───────────────────────────────

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function saveBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
}

const expanded = ref<boolean>(loadBool('agentTeam.tokenPanel.expanded', false))
watch(expanded, (v) => {
  saveBool('agentTeam.tokenPanel.expanded', v)
  emit('update:expanded', v)
}, { immediate: true })

// Active right-panel tab — Tokens (default) or the pipeline History timeline.
const tab = ref<'history' | 'tokens'>('history')
try {
  const t = localStorage.getItem('agentTeam.rightPanel.tab')
  if (t === 'history' || t === 'tokens') tab.value = t
} catch { /* ignore */ }
watch(tab, (v) => {
  try { localStorage.setItem('agentTeam.rightPanel.tab', v) } catch { /* ignore */ }
})

// ─────────────────────── Derived view models ──────────────────────────────

const EMPTY: TokenBucket = { input: 0, output: 0, calls: 0 }

const currentRun = computed(() => snapshot.value?.workspace?.current_run ?? null)
const runTotals = computed<TokenBucket>(() => currentRun.value?.totals ?? EMPTY)
const cumulative = computed<TokenBucket>(() =>
  snapshot.value?.workspace?.cumulative?.totals ?? EMPTY
)
const allTime = computed<TokenBucket>(() => snapshot.value?.global?.all_time ?? EMPTY)

const VENDOR_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  analyzer: 'Local analyzer'
}
const KNOWN_VENDORS = ['claude', 'codex', 'gemini', 'analyzer']

// Vendor / Stage breakdowns come from workspace CUMULATIVE (not just current run)
// so they remain visible even when no pipeline is actively running. The current
// run's contribution is already surfaced in its own "Current run" section above.
const cumulativeByVendor = computed(
  () => snapshot.value?.workspace?.cumulative?.by_vendor ?? {}
)
const cumulativeByStage = computed(
  () => snapshot.value?.workspace?.cumulative?.by_stage ?? {}
)

const vendorRows = computed(() => {
  const map = cumulativeByVendor.value
  return KNOWN_VENDORS.map((v) => ({
    key: v,
    label: VENDOR_LABELS[v] ?? v,
    bucket: map[v] ?? EMPTY
  }))
})

const stageRows = computed(() => {
  const map = cumulativeByStage.value
  return (props.stages ?? []).map((s) => ({
    id: s.id,
    label: s.shortTitle ?? s.title ?? s.id,
    bucket: map[s.id] ?? EMPTY
  }))
})

const paneRows = computed(() => {
  const map = currentRun.value?.by_pane ?? {}
  return (props.panes ?? []).map((p) => {
    // Prefer stable key (stageId:slotLabel) so data survives frontend restarts.
    // Fall back to UUID for manual panes that have no stage/slot.
    const stableKey = p.stageId && p.slotLabel ? `${p.stageId}:${p.slotLabel}`
                    : p.stageId || p.id
    return {
      id: p.id,
      label: p.agentLabel,
      sub: p.roleLabel,
      bucket: map[stableKey] ?? map[p.id] ?? EMPTY
    }
  })
})

const collapsedTotal = computed(() => fmt(runTotals.value.input + runTotals.value.output))

// ─────────────────────── Formatting helpers ───────────────────────────────

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

// ─────────────────────── Reset confirmations ──────────────────────────────

const { confirm: notifyConfirm } = useNotify()

async function confirmReset(scope: ResetScope): Promise<void> {
  const msg = {
    run: 'Reset the current pipeline run’s token counters? Workspace cumulative and global totals stay intact.',
    workspace: 'Wipe all token data for this workspace (current run + runs history + cumulative)? Global totals stay intact.',
    global: 'Wipe global all-time token totals? This affects every workspace.'
  }[scope]
  if (!(await notifyConfirm(msg, { title: 'Reset tokens', confirmText: 'Reset' }))) return
  await reset(scope)
}
</script>

<template>
  <aside class="token-panel" :class="{ 'is-expanded': expanded, 'is-collapsed': !expanded }">
    <!-- Collapsed rail: one icon per tab — click to expand + switch tab -->
    <div v-if="!expanded" class="rail">
      <button class="rail-btn" :class="{ active: tab === 'history' }" title="Expand pipeline history" @click="tab = 'history'; expanded = true">
        <span class="rail-icon">📜</span>
        <span class="rail-label">History</span>
      </button>
      <button class="rail-btn" :class="{ active: tab === 'tokens' }" :title="`Expand token stats · ${collapsedTotal} so far`" @click="tab = 'tokens'; expanded = true">
        <span class="rail-icon">📊</span>
        <span class="rail-label">Tokens</span>
        <span v-if="runTotals.calls > 0" class="rail-badge">{{ collapsedTotal }}</span>
      </button>
    </div>

    <!-- Expanded panel -->
    <template v-else>
      <header class="hdr">
        <button class="collapse" title="Collapse" @click="expanded = false">‹</button>
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'history' }" @click="tab = 'history'">📜 History</button>
          <button class="tab" :class="{ active: tab === 'tokens' }" @click="tab = 'tokens'">📊 Tokens</button>
        </div>
      </header>

      <HistoryPanel v-if="tab === 'history'" :backend="backend" :workspace-path="workspacePath" :pipeline="pipeline" />

      <template v-else>
      <div v-if="loading && !snapshot" class="msg">Loading…</div>

      <div class="body">
        <!-- Current run total -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">Current run</span>
            <button class="reset-btn" title="Reset run counter" @click="confirmReset('run')">⟲</button>
          </div>
          <div v-if="currentRun" class="run-meta" :title="currentRun.task">
            <span class="run-id">{{ currentRun.run_id || '—' }}</span>
          </div>
          <div v-else class="muted">No active run.</div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(runTotals.input) }}</div><div class="lbl">input</div></div>
            <div class="cell"><div class="big">{{ fmt(runTotals.output) }}</div><div class="lbl">output</div></div>
            <div class="cell"><div class="big">{{ fmt(runTotals.input + runTotals.output) }}</div><div class="lbl">total</div></div>
            <div class="cell"><div class="big">{{ runTotals.calls }}</div><div class="lbl">calls</div></div>
          </div>
        </section>

        <!-- Cumulative (workspace lifetime) -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">Workspace cumulative</span>
            <button class="reset-btn" title="Wipe workspace history" @click="confirmReset('workspace')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(cumulative.input) }}</div><div class="lbl">input</div></div>
            <div class="cell"><div class="big">{{ fmt(cumulative.output) }}</div><div class="lbl">output</div></div>
            <div class="cell"><div class="big">{{ fmt(cumulative.input + cumulative.output) }}</div><div class="lbl">total</div></div>
            <div class="cell"><div class="big">{{ cumulative.calls }}</div><div class="lbl">calls</div></div>
          </div>
        </section>

        <!-- Global all-time -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">All time (global)</span>
            <button class="reset-btn" title="Wipe global tally" @click="confirmReset('global')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(allTime.input) }}</div><div class="lbl">input</div></div>
            <div class="cell"><div class="big">{{ fmt(allTime.output) }}</div><div class="lbl">output</div></div>
            <div class="cell"><div class="big">{{ fmt(allTime.input + allTime.output) }}</div><div class="lbl">total</div></div>
            <div class="cell"><div class="big">{{ allTime.calls }}</div><div class="lbl">calls</div></div>
          </div>
        </section>

        <!-- By Vendor -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">By vendor</span></div>
          <table class="grid">
            <tr v-for="row in vendorRows" :key="row.key">
              <th>{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
            <tr class="head">
              <th></th><td>in</td><td>out</td><td class="dim">calls</td>
            </tr>
          </table>
        </section>

        <!-- By Stage -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">By stage</span></div>
          <div v-if="!stageRows.length" class="muted">No stages defined.</div>
          <table v-else class="grid">
            <tr v-for="row in stageRows" :key="row.id">
              <th>{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
          </table>
        </section>

        <!-- By Pane -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">By pane</span></div>
          <div v-if="!paneRows.length" class="muted">No active panes.</div>
          <table v-else class="grid">
            <tr v-for="row in paneRows" :key="row.id">
              <th :title="row.sub">{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
          </table>
        </section>
      </div>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.token-panel {
  height: 100%;
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 12px;
  min-height: 0;
}

/* ─────── collapsed rail ─────── */
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  height: 100%;
}
.rail-btn {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 4px;
  width: 100%;
}
.rail-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.rail-btn.active {
  color: var(--accent-fg);
}
.rail-icon { font-size: 16px; }
.rail-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  letter-spacing: 1px;
  font-size: 10px;
  text-transform: uppercase;
}
.rail-badge {
  font-size: 10px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  padding: 2px 6px;
  border-radius: 999px;
  margin-top: auto;
}

/* ─────── expanded panel ─────── */
.hdr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.collapse {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 14px;
  line-height: 1;
}
.collapse:hover { color: var(--text-bright); }
.title {
  font-weight: 600;
  flex: 1;
}
.tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}
.tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
}
.tab:hover { color: var(--text-bright); }
.tab.active {
  color: var(--text-bright);
  background: var(--bg-base);
  border-color: var(--border-default);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  min-height: 0;
}
.msg { padding: 12px; color: var(--text-secondary); }

.block {
  padding: 8px 12px;
  border-bottom: 1px solid var(--bg-subtle);
}
.block-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.block-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  flex: 1;
}
.reset-btn {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  line-height: 1.7;
}
.reset-btn:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.run-meta {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-id {
  font-family: Menlo, Monaco, monospace;
}
.muted { color: var(--text-secondary); font-size: 11px; margin: 4px 0; }

.totals {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.cell {
  text-align: center;
  background: var(--bg-subtle);
  border-radius: 3px;
  padding: 6px 0;
}
.big { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.lbl {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.grid tr.head td, .grid tr.head th {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  border-top: 1px solid var(--border-muted);
  padding-top: 4px;
}
.grid th {
  text-align: left;
  font-weight: 500;
  color: var(--text-primary);
  padding: 3px 6px 3px 0;
  white-space: nowrap;
}
.grid td {
  text-align: right;
  padding: 3px 6px;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
}
.grid td.dim { color: var(--text-secondary); }
</style>
