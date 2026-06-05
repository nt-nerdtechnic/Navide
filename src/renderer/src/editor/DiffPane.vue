<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useNotify } from '../composables/useNotify'
import { parseHunks, buildPatch, hunkHasChanges, toSideBySide, type Hunk } from '../lib/git-diff'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  workspacePath: string
  filepath: string
  staged: boolean
  name: string
  backend: ReturnType<typeof useBackend>
}>()

const notify = useNotify()

const rawDiff = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const selected = ref<Record<number, Set<number>>>({})

const parsed = computed(() => (rawDiff.value ? parseHunks(rawDiff.value) : { fileHeader: '', hunks: [] }))
const isEmpty = computed(() => rawDiff.value !== null && parsed.value.hunks.length === 0)

async function loadDiff(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; diff: string; error?: string }>('git.diff_file', {
      workspace_path: props.workspacePath,
      filepath: props.filepath,
      staged: props.staged,
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

watch(
  () => props.backend.status.value,
  (s) => { if (s === 'connected' && rawDiff.value === null) void loadDiff() },
  { immediate: true },
)

watch([() => props.filepath, () => props.staged], () => {
  rawDiff.value = null
  void loadDiff()
})

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

async function apply(patch: string, reverse: boolean, cached: boolean): Promise<void> {
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('git.apply_patch', {
    workspace_path: props.workspacePath,
    patch,
    reverse,
    cached,
  })
  if (!(resp.ok && resp.payload?.ok)) {
    notify.toast(resp.payload?.error || resp.error?.message || 'apply patch 失敗', { type: 'error' })
    return
  }
  await loadDiff()
}

function stageHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), false, true) }
function unstageHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), true, true) }
function discardHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), true, false) }
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
  <div class="diff-pane">
    <div class="dp-toolbar">
      <span class="dp-badge" :class="staged ? 'staged' : 'unstaged'">{{ staged ? 'STAGED' : 'WORKING TREE' }}</span>
      <span class="dp-filepath" :title="filepath">{{ filepath }}</span>
      <button class="dp-refresh" title="Reload diff" @click="loadDiff">⟳</button>
    </div>

    <div class="dp-body">
      <div v-if="loading" class="dp-msg">Loading…</div>
      <div v-else-if="loadError" class="dp-msg err">{{ loadError }}</div>
      <div v-else-if="isEmpty" class="dp-msg">沒有可顯示的變更（可能是 binary 檔或無差異）</div>
      <div v-else-if="rawDiff === null" class="dp-msg">
        尚未載入 diff
        <button class="dp-refresh" style="margin-left: 8px" @click="loadDiff">重新載入</button>
      </div>
      <div v-else class="dp-hunks">
        <div v-for="(hunk, hi) in parsed.hunks" :key="hi" class="dp-hunk">
          <div class="dp-hunk-head">
            <span class="dp-range">{{ hunk.header }}</span>
            <span class="dp-actions">
              <template v-if="staged">
                <button class="hk-btn" @click="unstageHunk(hunk)">Unstage Hunk</button>
              </template>
              <template v-else>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn" @click="stageHunk(hunk)">Stage Hunk</button>
                <button v-if="selectedCount(hi) > 0" class="hk-btn primary" @click="stageSelected(hunk, hi)">Stage Selected ({{ selectedCount(hi) }})</button>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn danger" @click="discardHunk(hunk)">Discard Hunk</button>
              </template>
            </span>
          </div>
          <div class="dp-grid">
            <template v-for="(row, ri) in toSideBySide(hunk)" :key="ri">
              <div class="dp-side left" :class="cellClass(row.left)">
                <span class="dp-no">{{ row.left ? row.left.lineNo : '' }}</span>
                <input v-if="!staged && row.left && row.left.kind === '-'" class="dp-check" type="checkbox" :checked="isSelected(hi, row.left.idx)" @change="toggleLine(hi, row.left.idx)" />
                <span v-else class="dp-check-sp" />
                <span class="dp-sign">{{ row.left ? row.left.kind : '' }}</span>
                <span class="dp-code">{{ row.left ? row.left.text : '' }}</span>
              </div>
              <div class="dp-side right" :class="cellClass(row.right)">
                <span class="dp-no">{{ row.right ? row.right.lineNo : '' }}</span>
                <input v-if="!staged && row.right && row.right.kind === '+'" class="dp-check" type="checkbox" :checked="isSelected(hi, row.right.idx)" @change="toggleLine(hi, row.right.idx)" />
                <span v-else class="dp-check-sp" />
                <span class="dp-sign">{{ row.right ? row.right.kind : '' }}</span>
                <span class="dp-code">{{ row.right ? row.right.text : '' }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.dp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
  font-size: 12px;
}
.dp-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.dp-badge.staged { background: #1f3a2f; color: #56d364; }
.dp-badge.unstaged { background: #3a2f1f; color: #e3b341; }
.dp-filepath {
  flex: 1;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Menlo, monospace;
}
.dp-refresh {
  background: transparent;
  border: 1px solid var(--border-muted);
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  padding: 2px 7px;
  font-size: 13px;
}
.dp-refresh:hover { color: var(--text-primary); border-color: var(--border-default); }

.dp-body { flex: 1; overflow: auto; }
.dp-msg { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.dp-msg.err { color: var(--danger-fg, #f85149); }

.dp-hunk { border-bottom: 1px solid var(--border-muted); }
.dp-hunk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-subtle);
  padding: 3px 10px;
  position: sticky;
  top: 0;
  z-index: 1;
}
.dp-range { color: var(--accent-fg, #79c0ff); font-family: ui-monospace, Menlo, monospace; font-size: 11px; opacity: 0.85; }
.dp-actions { display: flex; gap: 5px; }
.hk-btn {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.hk-btn:hover { background: var(--bg-base); }
.hk-btn.primary { background: rgba(31,111,235,0.2); border-color: var(--accent-emphasis, #1f6feb); color: var(--accent-fg, #58a6ff); }
.hk-btn.danger:hover { background: rgba(248,81,73,0.13); border-color: var(--danger-fg, #f85149); color: var(--danger-fg, #f85149); }

.dp-grid { display: grid; grid-template-columns: 1fr 1fr; }
.dp-side {
  display: flex;
  align-items: flex-start;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  padding-right: 8px;
  min-height: 18px;
}
.dp-side.left { border-right: 1px solid var(--border-muted); }
.dp-side.empty { background: var(--bg-subtle); }
.dp-no { width: 42px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--text-muted); user-select: none; font-size: 11px; }
.dp-check { margin: 2px 3px 0 0; flex-shrink: 0; cursor: pointer; }
.dp-check-sp { width: 16px; flex-shrink: 0; }
.dp-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.dp-code { white-space: pre-wrap; word-break: break-all; }
.dp-side.k-del { background: rgba(248,81,73,0.12); }
.dp-side.k-del .dp-code, .dp-side.k-del .dp-sign { color: #f85149; }
.dp-side.k-add { background: rgba(63,185,80,0.12); }
.dp-side.k-add .dp-code, .dp-side.k-add .dp-sign { color: #56d364; }
.dp-side.k-ctx .dp-code { color: var(--text-primary); }
</style>
