<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useBackend } from './composables/useBackend'
import { parseHunks, buildPatch, hunkHasChanges, toSideBySide, type Hunk } from './lib/git-diff'

// ── window params ───────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const filepath = params.get('filepath') ?? ''
const staged = (params.get('staged') ?? 'false') === 'true'
const name = params.get('name') ?? filepath
document.title = `Diff · ${name}`

const backend = useBackend()

// ── diff state ────────────────────────────────────────────────────────────────
const rawDiff = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const applyError = ref('')
const selected = ref<Record<number, Set<number>>>({})

const parsed = computed(() => (rawDiff.value ? parseHunks(rawDiff.value) : { fileHeader: '', hunks: [] }))
const isEmpty = computed(() => !!rawDiff.value && parsed.value.hunks.length === 0)

async function loadDiff(): Promise<void> {
  if (!workspacePath || !filepath) {
    loadError.value = '缺少檔案參數'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const resp = await backend.send<{ ok: boolean; diff: string; error?: string }>('git.diff_file', {
      workspace_path: workspacePath,
      filepath,
      staged,
    })
    if (resp.ok && resp.payload?.ok) {
      rawDiff.value = resp.payload.diff ?? ''
      selected.value = {}
    } else {
      loadError.value = resp.payload?.error || resp.error?.message || '無法載入 diff'
    }
  } finally {
    loading.value = false
  }
}

// Load once the backend connects (and on reconnect).
watch(
  () => backend.status.value,
  (s) => {
    if (s === 'connected' && rawDiff.value === null) void loadDiff()
  },
  { immediate: true },
)

// ── line selection ──────────────────────────────────────────────────────────────
function toggleLine(hunkIdx: number, lineIdx: number): void {
  const set = new Set(selected.value[hunkIdx] ?? [])
  if (set.has(lineIdx)) set.delete(lineIdx)
  else set.add(lineIdx)
  selected.value = { ...selected.value, [hunkIdx]: set }
}
function isSelected(hunkIdx: number, lineIdx: number): boolean {
  return selected.value[hunkIdx]?.has(lineIdx) ?? false
}
function selectedCount(hunkIdx: number): number {
  return selected.value[hunkIdx]?.size ?? 0
}

// ── staging via git.apply_patch ───────────────────────────────────────────────
async function apply(patch: string, reverse: boolean, cached: boolean): Promise<void> {
  applyError.value = ''
  const resp = await backend.send<{ ok: boolean; error?: string }>('git.apply_patch', {
    workspace_path: workspacePath,
    patch,
    reverse,
    cached,
  })
  if (!(resp.ok && resp.payload?.ok)) {
    applyError.value = resp.payload?.error || resp.error?.message || 'apply patch 失敗'
    return
  }
  await loadDiff() // refresh; backend broadcasts git.changed so the main window updates too
}

function stageHunk(hunk: Hunk): void {
  void apply(buildPatch(parsed.value, hunk), false, true)
}
function unstageHunk(hunk: Hunk): void {
  void apply(buildPatch(parsed.value, hunk), true, true)
}
function discardHunk(hunk: Hunk): void {
  void apply(buildPatch(parsed.value, hunk), true, false)
}
function stageSelected(hunk: Hunk, hunkIdx: number): void {
  const set = selected.value[hunkIdx]
  if (!set || set.size === 0) return
  void apply(buildPatch(parsed.value, hunk, set), false, true)
}

function cellClass(cell: { kind: ' ' | '+' | '-' } | null): string {
  if (!cell) return 'empty'
  if (cell.kind === '+') return 'k-add'
  if (cell.kind === '-') return 'k-del'
  return 'k-ctx'
}
</script>

<template>
  <div class="diff-win">
    <header class="dw-header">
      <span class="dw-title" :title="filepath">{{ name }}</span>
      <span class="dw-badge" :class="staged ? 'staged' : 'unstaged'">{{ staged ? 'STAGED' : 'WORKING TREE' }}</span>
      <span class="spacer" />
      <span class="dw-status" :class="backend.status.value">● {{ backend.status.value }}</span>
      <button class="dw-refresh" title="Reload diff" @click="loadDiff">⟳</button>
    </header>

    <p v-if="applyError" class="dw-err">{{ applyError }}</p>

    <div class="dw-body">
      <div v-if="loading" class="dw-msg">Loading…</div>
      <div v-else-if="loadError" class="dw-msg err">{{ loadError }}</div>
      <div v-else-if="isEmpty" class="dw-msg">沒有可顯示的變更（可能是 binary 檔或無差異）</div>
      <div v-else-if="rawDiff !== null" class="dw-hunks">
        <div v-for="(hunk, hi) in parsed.hunks" :key="hi" class="dw-hunk">
          <div class="dw-hunk-head">
            <span class="dw-range">{{ hunk.header }}</span>
            <span class="dw-actions">
              <template v-if="staged">
                <button class="hk-btn" @click="unstageHunk(hunk)">Unstage Hunk</button>
              </template>
              <template v-else>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn" @click="stageHunk(hunk)">Stage Hunk</button>
                <button
                  v-if="selectedCount(hi) > 0"
                  class="hk-btn primary"
                  @click="stageSelected(hunk, hi)"
                >Stage Selected ({{ selectedCount(hi) }})</button>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn danger" @click="discardHunk(hunk)">Discard Hunk</button>
              </template>
            </span>
          </div>

          <div class="dw-grid">
            <template v-for="(row, ri) in toSideBySide(hunk)" :key="ri">
              <!-- left (old) -->
              <div class="dw-side left" :class="cellClass(row.left)">
                <span class="dw-no">{{ row.left ? row.left.lineNo : '' }}</span>
                <input
                  v-if="!staged && row.left && row.left.kind === '-'"
                  class="dw-check"
                  type="checkbox"
                  :checked="isSelected(hi, row.left.idx)"
                  @change="toggleLine(hi, row.left.idx)"
                />
                <span v-else class="dw-check-sp" />
                <span class="dw-sign">{{ row.left ? row.left.kind : '' }}</span>
                <span class="dw-code">{{ row.left ? row.left.text : '' }}</span>
              </div>
              <!-- right (new) -->
              <div class="dw-side right" :class="cellClass(row.right)">
                <span class="dw-no">{{ row.right ? row.right.lineNo : '' }}</span>
                <input
                  v-if="!staged && row.right && row.right.kind === '+'"
                  class="dw-check"
                  type="checkbox"
                  :checked="isSelected(hi, row.right.idx)"
                  @change="toggleLine(hi, row.right.idx)"
                />
                <span v-else class="dw-check-sp" />
                <span class="dw-sign">{{ row.right ? row.right.kind : '' }}</span>
                <span class="dw-code">{{ row.right ? row.right.text : '' }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
* { box-sizing: border-box; }
.diff-win {
  display: flex; flex-direction: column; height: 100vh;
  background: #0d1117; color: #c9d1d9;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.dw-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0;
}
.dw-title { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dw-badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; }
.dw-badge.staged { background: #1f3a2f; color: #56d364; }
.dw-badge.unstaged { background: #3a2f1f; color: #e3b341; }
.spacer { flex: 1; }
.dw-status { font-size: 10px; text-transform: capitalize; }
.dw-status.connected { color: #3fb950; }
.dw-status.connecting, .dw-status.starting { color: #e3b341; }
.dw-status.disconnected, .dw-status.error { color: #f85149; }
.dw-refresh { background: transparent; border: 1px solid #30363d; color: #8b949e; border-radius: 4px; cursor: pointer; padding: 2px 7px; }
.dw-refresh:hover { color: #c9d1d9; border-color: #6e7681; }
.dw-err { color: #f85149; font-size: 12px; margin: 0; padding: 6px 12px; background: #3d1d1d; }
.dw-body { flex: 1; overflow: auto; }
.dw-msg { padding: 24px; text-align: center; color: #8b949e; font-size: 12px; }
.dw-msg.err { color: #f85149; }

.dw-hunk { border-bottom: 1px solid #21262d; }
.dw-hunk-head {
  display: flex; align-items: center; justify-content: space-between;
  background: #161b22; padding: 3px 10px; position: sticky; top: 0; z-index: 1;
}
.dw-range { color: #79c0ff; font-family: ui-monospace, Menlo, monospace; font-size: 11px; opacity: 0.85; }
.dw-actions { display: flex; gap: 5px; }
.hk-btn {
  background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
  border-radius: 4px; font-size: 11px; padding: 2px 8px; cursor: pointer;
}
.hk-btn:hover { background: #30363d; }
.hk-btn.primary { background: #1f6feb33; border-color: #1f6feb; color: #58a6ff; }
.hk-btn.danger:hover { background: #f8514922; border-color: #f85149; color: #f85149; }

.dw-grid { display: grid; grid-template-columns: 1fr 1fr; }
.dw-side {
  display: flex; align-items: flex-start; gap: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  line-height: 1.5; white-space: pre; padding-right: 8px; min-height: 18px;
}
.dw-side.left { border-right: 1px solid #21262d; }
.dw-side.empty { background: #161b1f; }
.dw-no {
  width: 42px; flex-shrink: 0; text-align: right; padding-right: 8px;
  color: #6e7681; user-select: none; font-size: 11px;
}
.dw-check { margin: 2px 3px 0 0; flex-shrink: 0; cursor: pointer; }
.dw-check-sp { width: 16px; flex-shrink: 0; }
.dw-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.dw-code { white-space: pre-wrap; word-break: break-all; }
.dw-side.k-del { background: rgba(248,81,73,0.12); }
.dw-side.k-del .dw-code, .dw-side.k-del .dw-sign { color: #f85149; }
.dw-side.k-add { background: rgba(63,185,80,0.12); }
.dw-side.k-add .dw-code, .dw-side.k-add .dw-sign { color: #56d364; }
.dw-side.k-ctx .dw-code { color: #c9d1d9; }
</style>
