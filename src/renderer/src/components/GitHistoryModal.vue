<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { computeGraph, laneColor } from '../lib/git-graph'
import { useNotify } from '../composables/useNotify'
import type { useBackend } from '../composables/useBackend'
import type { GitCommit, GitCommitDetail, DiffBlameHunk } from '../composables/useGit'

// The full-history dialog reuses the parent GitPane's single useGit instance
// (passed in as capabilities) so it never spawns duplicate event listeners or
// requests. It owns its own search / expand / context-menu state so the main
// panel keeps showing just the latest page untouched.
const props = defineProps<{
  show: boolean
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  gitLog: GitCommit[]
  logScope: 'all' | 'current'
  isLoadingLog: boolean
  canLoadMoreLog: boolean
  setLogScope: (scope: 'all' | 'current') => Promise<void>
  loadMoreLog: () => Promise<void>
  logSearch: (query: string, opts?: { scope?: 'all' | 'current'; limit?: number }) => Promise<GitCommit[]>
  showCommit: (hash: string) => Promise<GitCommitDetail | null>
  commitFileDiff: (hash: string, file: string) => Promise<DiffBlameHunk[]>
  cherryPick: (hash: string) => Promise<{ ok: boolean; error?: string }>
  revertCommit: (hash: string) => Promise<{ ok: boolean; error?: string }>
  checkoutCommit: (hash: string) => Promise<{ ok: boolean; error?: string }>
  createBranch: (name: string, startPoint?: string) => Promise<{ ok: boolean; error?: string }>
  createTag: (name: string, message?: string, hash?: string) => Promise<{ ok: boolean; error?: string }>
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { toast: notifyToast } = useNotify()

// ── search (backend, isolated from the parent's gitLog) ───────────────────────
const SEARCH_LIMIT = 50
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const searchResults = ref<GitCommit[]>([])
const searchLimit = ref(SEARCH_LIMIT)
const searching = ref(false)
const searchActive = computed(() => searchQuery.value.trim().length > 0)

// When searching, show the backend results; otherwise mirror the shared gitLog.
const displayLog = computed<GitCommit[]>(() => (searchActive.value ? searchResults.value : props.gitLog))

let searchTimer: ReturnType<typeof setTimeout> | null = null
async function runSearch(): Promise<void> {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    const r = await props.logSearch(q, { scope: props.logScope, limit: searchLimit.value })
    if (searchQuery.value.trim() === q) searchResults.value = r
  } finally {
    searching.value = false
  }
}
watch(searchQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchLimit.value = SEARCH_LIMIT
  if (!searchActive.value) { searchResults.value = []; searching.value = false; return }
  searchTimer = setTimeout(() => void runSearch(), 280)
})
// Re-run an active search when the scope toggles.
watch(() => props.logScope, () => { if (searchActive.value) void runSearch() })

// ── pagination (mirrors the former main-panel pipeline) ───────────────────────
const HISTORY_PAGE_SIZE = 15
const historyPage = ref(0)
const historyPageCount = computed(() => Math.ceil(displayLog.value.length / HISTORY_PAGE_SIZE))
const pagedLog = computed(() => {
  const start = historyPage.value * HISTORY_PAGE_SIZE
  return displayLog.value.slice(start, start + HISTORY_PAGE_SIZE).map((c, k) => ({ c, gi: start + k }))
})
watch(() => displayLog.value.length, () => { historyPage.value = 0 })

const canLoadMore = computed(() =>
  searchActive.value ? searchResults.value.length >= searchLimit.value : props.canLoadMoreLog,
)
const isLoading = computed(() => (searchActive.value ? searching.value : props.isLoadingLog))
async function doLoadMore(): Promise<void> {
  if (searchActive.value) { searchLimit.value += SEARCH_LIMIT; await runSearch() }
  else await props.loadMoreLog()
}

// ── commit graph (own layout over this dialog's current list) ─────────────────
const GRAPH_LANE_W = 14
const graphLayout = computed(() =>
  computeGraph(displayLog.value.map((c) => ({ hash: c.hash, parents: c.parents ?? [] }))),
)
const graphWidth = computed(() => Math.max(graphLayout.value.width * GRAPH_LANE_W, GRAPH_LANE_W))
function laneX(lane: number): number { return lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 }

function shortBranch(r: string): string { return r.replace(/^refs\/(heads|remotes)\//, '') }
function isHeadCommit(c: GitCommit): boolean {
  return (c.branches ?? []).some((b) => b === 'HEAD' || b.startsWith('HEAD '))
}

// ── commit detail + per-file inline diff ──────────────────────────────────────
const expandedCommitHash = ref('')
const commitDetailData = ref<GitCommitDetail | null>(null)
const commitDetailLoading = ref(false)
const commitDiffFile = ref('')
const commitDiffHunks = ref<DiffBlameHunk[]>([])
const commitDiffLoading = ref(false)
function resetCommitDiff(): void { commitDiffFile.value = ''; commitDiffHunks.value = [] }
async function toggleCommitDetail(hash: string): Promise<void> {
  resetCommitDiff()
  if (expandedCommitHash.value === hash) { expandedCommitHash.value = ''; commitDetailData.value = null; return }
  expandedCommitHash.value = hash; commitDetailLoading.value = true
  try {
    commitDetailData.value = await props.showCommit(hash)
  } finally {
    commitDetailLoading.value = false
  }
}
async function toggleCommitFileDiff(hash: string, file: string): Promise<void> {
  if (commitDiffFile.value === file) { resetCommitDiff(); return }
  commitDiffFile.value = file; commitDiffHunks.value = []; commitDiffLoading.value = true
  try {
    const hunks = await props.commitFileDiff(hash, file)
    if (commitDiffFile.value === file) commitDiffHunks.value = hunks
  } finally {
    commitDiffLoading.value = false
  }
}

// ── commit context-menu actions ───────────────────────────────────────────────
const ctxMenu = ref<{ show: boolean; x: number; y: number; hash: string }>({ show: false, x: 0, y: 0, hash: '' })
function openCommitCtxMenu(e: MouseEvent, hash: string): void {
  e.preventDefault()
  e.stopPropagation()
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 330)
  ctxMenu.value = { show: true, x, y, hash }
}
function closeCtxMenu(): void { ctxMenu.value.show = false }

async function doOpenChanges(hash: string): Promise<void> {
  if (expandedCommitHash.value !== hash) await toggleCommitDetail(hash)
}
async function doCheckoutCommit(hash: string): Promise<void> {
  const r = await props.checkoutCommit(hash); if (!r.ok) notifyToast(r.error || 'checkout failed', { type: 'error' })
}
async function doCherryPick(hash: string): Promise<void> {
  const r = await props.cherryPick(hash); if (!r.ok) notifyToast(r.error || 'cherry-pick failed', { type: 'error' })
}
async function doRevert(hash: string): Promise<void> {
  const r = await props.revertCommit(hash); if (!r.ok) notifyToast(r.error || 'revert failed', { type: 'error' })
}
function copyCommitId(hash: string): void {
  void navigator.clipboard.writeText(hash)
  notifyToast('Commit ID copied', { type: 'info' })
}
function copyCommitMessage(hash: string): void {
  const c = displayLog.value.find((x) => x.hash === hash)
  void navigator.clipboard.writeText(c?.message ?? '')
  notifyToast('Commit message copied', { type: 'info' })
}

// Name-input modal shared by "Create Branch…" / "Create Tag…" from a commit.
const commitRefModal = ref<{ kind: 'branch' | 'tag'; hash: string; name: string; message: string; error: string } | null>(null)
function startCreateBranchFromCommit(hash: string): void {
  commitRefModal.value = { kind: 'branch', hash, name: '', message: '', error: '' }
  closeCtxMenu()
}
function startCreateTagFromCommit(hash: string): void {
  commitRefModal.value = { kind: 'tag', hash, name: '', message: '', error: '' }
  closeCtxMenu()
}
async function submitCommitRef(): Promise<void> {
  const m = commitRefModal.value; if (!m) return
  const name = m.name.trim(); if (!name) { m.error = 'name required'; return }
  const r = m.kind === 'branch'
    ? await props.createBranch(name, m.hash)
    : await props.createTag(name, m.message.trim(), m.hash)
  if (r.ok) commitRefModal.value = null; else m.error = r.error || 'failed'
}

// Reset transient menus when the dialog closes; autofocus search on open.
watch(() => props.show, (visible) => {
  if (!visible) { closeCtxMenu(); commitRefModal.value = null; return }
  void nextTick(() => searchInputRef.value?.focus())
})
</script>

<template>
  <Teleport to="body">
    <template v-if="show">
      <div class="tp-backdrop" @click="emit('close')" />
      <div class="history-modal" @click="closeCtxMenu()" @keydown.esc="emit('close')">
        <div class="hm-hdr">
          <span class="hm-title">{{ $t('label.history') }}</span>
          <div class="spacer" />
          <button class="hm-close" :title="$t('action.close')" @click="emit('close')">✕</button>
        </div>

        <div class="history-search-row">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="var(--text-muted)" style="flex-shrink:0"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
          <input ref="searchInputRef" v-model="searchQuery" class="search-input" :placeholder="$t('label.search-commits')" />
        </div>
        <div class="history-scope-row">
          <button class="scope-btn" :class="{ active: logScope === 'all' }" :disabled="isLoadingLog" @click="setLogScope('all')">{{ $t('label.all-branches') }}</button>
          <button class="scope-btn" :class="{ active: logScope === 'current' }" :disabled="isLoadingLog" @click="setLogScope('current')">{{ $t('label.current') }}</button>
        </div>

        <div class="hm-body">
          <div v-if="!displayLog.length" class="empty-msg">{{ searchActive ? $t('label.no-matches') : $t('label.no-commits-yet') }}</div>
          <div v-else class="commit-list">
            <div v-for="{ c, gi } in pagedLog" :key="c.hash">
              <div class="commit-row" @click="toggleCommitDetail(c.hash)" @contextmenu.prevent="openCommitCtxMenu($event, c.hash)">
                <div class="graph-col" :style="{ width: graphWidth + 'px' }">
                  <svg class="graph-svg" :viewBox="`0 0 ${graphWidth} 100`" preserveAspectRatio="none">
                    <line
                      v-for="(seg, si) in (graphLayout.rows[gi]?.segments ?? [])"
                      :key="si"
                      :x1="laneX(seg.fromLane)" :y1="seg.half === 'top' ? 0 : 50"
                      :x2="laneX(seg.toLane)" :y2="seg.half === 'top' ? 50 : 100"
                      :stroke="laneColor(seg.half === 'top' ? seg.fromLane : seg.toLane)"
                      stroke-width="1.5"
                    />
                  </svg>
                  <span
                    class="graph-dot"
                    :class="{ head: isHeadCommit(c) }"
                    :style="{ left: laneX(graphLayout.rows[gi]?.lane ?? 0) + 'px', background: laneColor(graphLayout.rows[gi]?.lane ?? 0) }"
                  />
                </div>
                <div class="commit-body">
                  <div class="commit-msg">{{ c.message }}</div>
                  <div class="commit-meta">
                    <code class="chash">{{ c.short_hash }}</code>
                    <span v-for="b in c.branches" :key="b" class="ref-pill" :class="b.startsWith('origin') ? 'remote' : 'local'">{{ shortBranch(b) }}</span>
                  </div>
                </div>
                <div class="commit-btns-right" @click.stop>
                  <span class="expand-caret">{{ expandedCommitHash === c.hash ? '▾' : '▸' }}</span>
                </div>
              </div>
              <div v-if="expandedCommitHash === c.hash" class="commit-detail">
                <div v-if="commitDetailLoading" class="loading-text">Loading…</div>
                <template v-else-if="commitDetailData">
                  <div class="cd-body">{{ commitDetailData.message }}</div>
                  <div class="cd-row"><span class="cd-key">Author</span><span>{{ commitDetailData.author_name }} &lt;{{ commitDetailData.author_email }}&gt;</span></div>
                  <div class="cd-row"><span class="cd-key">Date</span><span>{{ new Date(commitDetailData.date).toLocaleString() }}</span></div>
                  <div v-if="commitDetailData.body" class="cd-body">{{ commitDetailData.body }}</div>
                  <div v-if="commitDetailData.files.length">
                    <div class="cd-key">Files ({{ commitDetailData.files.length }})</div>
                    <template v-for="f in commitDetailData.files" :key="f">
                      <div class="cd-file cd-file-clickable" :title="f" @click="toggleCommitFileDiff(c.hash, f)">
                        <span class="expand-caret">{{ commitDiffFile === f ? '▾' : '▸' }}</span> {{ f }}
                      </div>
                      <div v-if="commitDiffFile === f" class="subpanel green-border diffblame-inline">
                        <div v-if="commitDiffLoading" class="loading-text">Loading…</div>
                        <div v-else-if="!commitDiffHunks.length" class="loading-text">No changes to display</div>
                        <template v-else v-for="(dh, dhi) in commitDiffHunks" :key="dhi">
                          <div class="db-hunk-head">{{ dh.header }}</div>
                          <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                            <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                            <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                            <code class="db-code">{{ dl.text }}</code>
                          </div>
                        </template>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
          <div v-if="historyPageCount > 1" class="history-pagination">
            <button class="pg-btn" :disabled="historyPage === 0" @click="historyPage--">‹</button>
            <span class="pg-info">{{ historyPage + 1 }} / {{ historyPageCount }}</span>
            <button class="pg-btn" :disabled="historyPage >= historyPageCount - 1" @click="historyPage++">›</button>
          </div>
          <div v-if="canLoadMore && historyPage >= historyPageCount - 1" class="history-load-more">
            <button class="load-more-btn" :disabled="isLoading" @click="doLoadMore">
              {{ isLoading ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </Teleport>

  <!-- ── commit context-menu ──────────────────────────────────────────── -->
  <Teleport to="body">
    <div v-if="ctxMenu.show" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
      <button class="menu-item" @click="doOpenChanges(ctxMenu.hash); closeCtxMenu()">⇄ {{ $t('action.open-changes') }}</button>
      <div class="menu-sep" />
      <button class="menu-item" @click="doCheckoutCommit(ctxMenu.hash); closeCtxMenu()">⎇ {{ $t('action.checkout-detached') }}</button>
      <button class="menu-item" @click="startCreateBranchFromCommit(ctxMenu.hash)">＋ {{ $t('action.create-branch') }}</button>
      <button class="menu-item" @click="startCreateTagFromCommit(ctxMenu.hash)">🏷 {{ $t('action.create-tag') }}</button>
      <div class="menu-sep" />
      <button class="menu-item" @click="doCherryPick(ctxMenu.hash); closeCtxMenu()">🍒 {{ $t('action.cherry-pick') }}</button>
      <button class="menu-item" @click="doRevert(ctxMenu.hash); closeCtxMenu()">↺ {{ $t('action.revert') }}</button>
      <div class="menu-sep" />
      <button class="menu-item" @click="copyCommitId(ctxMenu.hash); closeCtxMenu()">⧉ {{ $t('action.copy-commit-id') }}</button>
      <button class="menu-item" @click="copyCommitMessage(ctxMenu.hash); closeCtxMenu()">⧉ {{ $t('action.copy-commit-message') }}</button>
    </div>
  </Teleport>

  <!-- ── Create branch / tag from a commit ────────────────────────────── -->
  <Teleport to="body">
    <div v-if="commitRefModal" class="tp-backdrop" @click="commitRefModal = null" />
    <div v-if="commitRefModal" class="ignore-modal" @click.stop>
      <div class="ignore-modal-path">
        {{ commitRefModal.kind === 'branch' ? $t('label.create-branch-from') : $t('label.create-tag-at') }} {{ commitRefModal.hash.slice(0, 7) }}
      </div>
      <input v-model="commitRefModal.name" class="git-input" :placeholder="commitRefModal.kind === 'branch' ? $t('label.branch-name-placeholder') : 'v1.0.0'" @keydown.enter="submitCommitRef" />
      <input v-if="commitRefModal.kind === 'tag'" v-model="commitRefModal.message" class="git-input" :placeholder="$t('label.message-optional')" @keydown.enter="submitCommitRef" />
      <p v-if="commitRefModal.error" class="err-text">{{ commitRefModal.error }}</p>
      <div style="display:flex; gap:6px; justify-content:flex-end">
        <button class="btn-ghost sm" @click="commitRefModal = null">{{ $t('action.cancel') }}</button>
        <button class="btn-ghost sm" @click="submitCommitRef">{{ $t('action.create') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tp-backdrop { position: fixed; inset: 0; z-index: 9998; }

.history-modal {
  position: fixed; z-index: 9999; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(560px, 90vw); max-height: 80vh;
  background: var(--bg-base); border: 1px solid var(--border-default); border-radius: 8px;
  box-shadow: 0 12px 32px var(--shadow-scrim);
  display: flex; flex-direction: column; overflow: hidden;
}
.hm-hdr {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.hm-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.spacer { flex: 1; }
.hm-close {
  background: transparent; border: none; color: var(--text-muted);
  font-size: 13px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.hm-close:hover { background: var(--bg-active); color: var(--text-primary); }
.hm-body { overflow-y: auto; padding: 6px 0; }

/* ── History / commit graph (ported from GitPane) ───────────────────────────── */
.history-search-row {
  display: flex; align-items: center; gap: 6px; padding: 8px 12px 5px;
}
.search-input {
  flex: 1; background: transparent; border: none;
  border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-size: 11px; padding: 2px 0;
}
.search-input:focus { outline: none; border-bottom-color: var(--accent-focus); }
.search-input::placeholder { color: var(--text-muted); }
.history-scope-row {
  display: flex; gap: 4px; padding: 2px 12px 6px; border-bottom: 1px solid var(--border-muted);
}
.scope-btn {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 5px;
  color: var(--text-secondary); font-size: 10px; padding: 3px 6px; cursor: pointer;
}
.scope-btn:hover:not(:disabled) { color: var(--text-bright); border-color: var(--accent-focus); }
.scope-btn.active { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.scope-btn:disabled { opacity: 0.5; cursor: default; }
.commit-list { margin-bottom: 4px; }
.history-load-more { display: flex; justify-content: center; padding: 0 0 6px; }
.load-more-btn {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 5px;
  color: var(--text-primary); font-size: 11px; padding: 3px 14px; cursor: pointer;
}
.load-more-btn:hover:not(:disabled) { border-color: var(--accent-focus); color: var(--text-bright); }
.load-more-btn:disabled { opacity: 0.5; cursor: default; }
.history-pagination {
  display: flex; align-items: center; justify-content: center;
  gap: 6px; padding: 4px 0 6px;
}
.history-pagination .pg-btn {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 5px;
  color: var(--text-primary); font-size: 13px; line-height: 1; min-width: 26px;
  padding: 3px 8px; cursor: pointer;
}
.history-pagination .pg-btn:hover:not(:disabled) { border-color: var(--accent-focus); color: var(--text-bright); }
.history-pagination .pg-btn:disabled { opacity: 0.3; cursor: default; }
.history-pagination .pg-info { font-size: 11px; color: var(--text-secondary); min-width: 40px; text-align: center; }
.commit-row {
  display: flex; align-items: flex-start; gap: 0;
  padding: 0 8px 0 0; cursor: pointer;
}
.commit-row:hover { background: var(--bg-hover-faint); }
.graph-col {
  position: relative; flex-shrink: 0; align-self: stretch; min-height: 28px;
}
.graph-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.graph-dot {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent-focus);
  border: 2px solid var(--bg-base); box-shadow: 0 0 0 1px currentColor;
}
.graph-dot.head { box-shadow: 0 0 0 1px var(--success-fg), 0 0 4px var(--success-fg); }
.commit-body { flex: 1; min-width: 0; padding: 3px 0; }
.commit-msg {
  font-size: 11px; color: var(--text-primary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; line-height: 1.4;
}
.commit-meta {
  display: flex; align-items: center; gap: 3px; margin-top: 1px; flex-wrap: wrap;
}
.chash { font-size: 10px; color: var(--text-muted); font-family: monospace; background: transparent; }
.ref-pill {
  font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 999px; line-height: 1.5;
}
.ref-pill.local  { background: var(--accent-muted); color: var(--accent-bright); }
.ref-pill.remote { background: var(--success-subtle); color: var(--success-bright); }
.commit-btns-right { display: flex; align-items: center; gap: 2px; padding: 3px 0; flex-shrink: 0; }
.expand-caret { font-size: 9px; color: var(--text-muted); padding: 0 2px; }

.commit-detail {
  margin: 0 8px 4px 24px; background: var(--bg-inset); border: 1px solid var(--border-muted);
  border-radius: 4px; padding: 6px 10px; font-size: 11px;
}
.cd-row { display: flex; gap: 8px; margin-bottom: 3px; color: var(--text-primary); }
.cd-key { color: var(--text-muted); min-width: 46px; flex-shrink: 0; }
.cd-body { color: var(--text-secondary); margin: 4px 0; white-space: pre-wrap; font-size: 10px; }
.cd-file { color: var(--text-primary); font-family: monospace; font-size: 10px; padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd-file-clickable { cursor: pointer; }
.cd-file-clickable:hover { color: var(--accent, #4a9eff); }

.empty-msg { color: var(--text-muted); font-size: 11px; font-style: italic; padding: 3px 20px 6px; }
.loading-text { color: var(--text-muted); font-size: 10px; padding: 3px 8px; }
.err-text { color: var(--danger-fg); font-size: 11px; margin: 0; padding: 2px 12px; }

/* Inline per-file diff */
.subpanel {
  margin: 0 0 2px 30px; border-left: 2px solid var(--border-muted);
  max-height: 130px; overflow-y: auto;
}
.green-border { border-left-color: var(--success-fg) !important; }
.diffblame-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-x: auto; padding: 2px 0; }
.db-hunk-head { color: var(--accent-bright); font-size: 10px; opacity: 0.8; padding: 2px 8px; white-space: pre; }
.db-line { display: flex; align-items: baseline; line-height: 1.5; width: max-content; padding: 0 8px; }
.db-no { color: var(--text-muted); min-width: 30px; text-align: right; padding-right: 8px; flex-shrink: 0; user-select: none; }
.db-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.db-code { white-space: pre; flex-shrink: 0; }
.db-line.db-add { background: var(--diff-add-bg); }
.db-line.db-add .db-code, .db-line.db-add .db-sign { color: var(--success-bright); }
.db-line.db-del { background: var(--diff-del-bg); }
.db-line.db-del .db-code, .db-line.db-del .db-sign { color: var(--danger-fg); }
.db-line.db-ctx .db-code { color: var(--text-primary); }

/* ── commit context menu ────────────────────────────────────────────────────── */
.ctx-menu {
  position: fixed; z-index: 10001;
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 6px; padding: 4px; min-width: 200px;
  box-shadow: 0 8px 24px var(--shadow-scrim);
}
.ctx-menu .menu-item {
  display: flex; align-items: center; width: 100%;
  background: transparent; border: none; color: var(--text-primary);
  font-size: 12px; padding: 5px 10px; border-radius: 4px; cursor: pointer;
  text-align: left; font-family: inherit;
}
.ctx-menu .menu-item:hover { background: var(--bg-active); }
.ctx-menu .menu-sep { height: 1px; background: var(--border-muted); margin: 4px 0; }

/* ── Create branch / tag modal ──────────────────────────────────────────────── */
.ignore-modal {
  position: fixed; z-index: 10000; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(420px, 80vw); background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 8px; padding: 16px; box-shadow: 0 12px 32px rgba(1, 4, 9, 0.9);
  display: flex; flex-direction: column; gap: 10px;
}
.ignore-modal-path {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; color: var(--accent-fg);
  word-break: break-all;
}
.git-input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-primary); font-size: 11px; padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: var(--accent-focus); }

/* Mirrors GitPane.vue's .btn-ghost — scoped styles don't cross components. */
.btn-ghost {
  background: transparent; border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }
.btn-ghost.sm { font-size: 11px; padding: 3px 7px; }
</style>
