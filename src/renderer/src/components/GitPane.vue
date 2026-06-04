<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useGit } from '../composables/useGit'
import type { IgnoreTarget } from '../composables/useGit'
import type { useBackend } from '../composables/useBackend'
import { computeGraph, laneColor } from '../lib/git-graph'

const props = defineProps<{
  workspacePath: string
  analyzerModel?: string
  backend: ReturnType<typeof useBackend>
}>()

const emit = defineEmits<{
  (e: 'changes-count', n: number): void
  (e: 'open-workspace', path: string): void
}>()

const {
  gitStatus, showIgnored, gitLog, gitBranches, gitStashes, gitRemotes, gitTags,
  gitWorktrees, gitConfig, gitConfigAllowedKeys,
  logScope, canLoadMoreLog, loadMoreLog, setLogScope, isLoadingLog,
  isCommitting, isFetching, isGenerating, isInitializing,
  syncOutput, syncError, gitError, clearGitError,
  initRepo, stageFile, unstageFile, stageAll, stageFiles, unstageFiles, discardFiles, discardFile, cleanUntracked,
  fetchRemote, pullOnly, pushOnly, pushUpstream, sync,
  createBranch, switchBranch, deleteBranch, mergeBranch, rebaseOn,
  compareBranches, restoreFileFromBranch,
  stashPush, stashPop, stashDrop,
  commit, amendCommit, undoLastCommit, revertCommit, cherryPick, generateMessage,
  fileLog, showFile, blameFile, diffBlame, resolveConflictOurs, resolveConflictTheirs,
  addRemote, removeRemote,
  createTag, deleteTag, showCommit,
  addWorktree, removeWorktree,
  setGitConfig,
  cloneRepo, addToGitignore, checkIgnore, abortOperation, stashApply,
  pullRebase, pushForce,
} = useGit(() => props.workspacePath, props.backend)

// ── path helpers ──────────────────────────────────────────────────────────────
function fileName(path: string): string { return path.split('/').at(-1) ?? path }
function fileDir(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

// ── view / sort ───────────────────────────────────────────────────────────────
const viewMode = ref<'list' | 'tree'>('tree')
const sortBy = ref<'name' | 'path' | 'status'>('path')
const showViewMenu = ref(false)
const viewMenuPos = ref({ top: 0, right: 0 })
const showCommitMenuPos = ref({ top: 0, right: 0 })
const showRemoteMenu = ref(false)
const remoteMenuPos = ref({ top: 0, right: 0 })
function openRemoteMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  remoteMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showRemoteMenu.value = !showRemoteMenu.value
}
const collapsedDirs = ref(new Set<string>())

function openViewMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  viewMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showViewMenu.value = !showViewMenu.value
  showCommitMenu.value = false
}

function openCommitMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  showCommitMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showCommitMenu.value = !showCommitMenu.value
  showViewMenu.value = false
}

function toggleDir(key: string): void {
  const next = new Set(collapsedDirs.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  collapsedDirs.value = next
}

interface GitFileEntry { path: string; status: string }

function sortFiles(files: GitFileEntry[]): GitFileEntry[] {
  return [...files].sort((a, b) => {
    if (sortBy.value === 'name') return fileName(a.path).localeCompare(fileName(b.path))
    if (sortBy.value === 'status') return a.status.localeCompare(b.status) || a.path.localeCompare(b.path)
    return a.path.localeCompare(b.path)
  })
}

// Nested folder tree → flat render rows with depth, honouring collapsed dirs.
interface TreeNode { name: string; path: string; dirs: Map<string, TreeNode>; files: GitFileEntry[] }
interface TreeRow {
  kind: 'folder' | 'file'
  depth: number
  name: string
  key: string            // collapse key (folder) or file path (file)
  dir?: string           // full dir path (folder rows)
  fileCount?: number     // total files under folder
  file?: GitFileEntry    // file rows
}

function countNodeFiles(node: TreeNode): number {
  let n = node.files.length
  for (const d of node.dirs.values()) n += countNodeFiles(d)
  return n
}

function flattenTree(files: GitFileEntry[], prefix: string): TreeRow[] {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of sortFiles(files)) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      const full = node.path ? `${node.path}/${seg}` : seg
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, path: full, dirs: new Map(), files: [] })
      node = node.dirs.get(seg)!
    }
    node.files.push(f)
  }

  const rows: TreeRow[] = []
  function walk(node: TreeNode, depth: number): void {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + dir.path
      rows.push({ kind: 'folder', depth, name: dir.name, key, dir: dir.path, fileCount: countNodeFiles(dir) })
      if (!collapsedDirs.value.has(key)) walk(dir, depth + 1)
    }
    for (const f of node.files) {
      rows.push({ kind: 'file', depth, name: fileName(f.path), key: f.path, file: f })
    }
  }
  walk(root, 0)
  return rows
}

// Depth-based indentation for tree rows (each level nests further in).
function treeIndent(depth: number): Record<string, string> {
  return { paddingLeft: `${10 + depth * 14}px` }
}

// ── file context menu (right-click) ─────────────────────────────────────────────
const ctxMenu = ref<{
  show: boolean; x: number; y: number
  kind: 'file' | 'folder' | 'branch'
  file: GitFileEntry | null
  dir: string
  branch: string
  staged: boolean
}>({ show: false, x: 0, y: 0, kind: 'file', file: null, dir: '', branch: '', staged: false })

function openCtxMenu(e: MouseEvent, file: GitFileEntry, staged: boolean): void {
  e.preventDefault()
  // Clamp so the menu stays on-screen (menu is ~220×300).
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 304)
  ctxMenu.value = { show: true, x, y, kind: 'file', file, dir: '', branch: '', staged }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function openFolderCtxMenu(e: MouseEvent, dir: string, staged: boolean): void {
  e.preventDefault()
  e.stopPropagation()
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 304)
  ctxMenu.value = { show: true, x, y, kind: 'folder', file: null, dir, branch: '', staged }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function openBranchCtxMenu(e: MouseEvent, name: string): void {
  e.preventDefault()
  e.stopPropagation()
  // Branch menu has a single item (~48px), so clamp to its real height, not the file menu's.
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 48)
  ctxMenu.value = { show: true, x, y, kind: 'branch', file: null, dir: '', branch: name, staged: false }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function ctxDeleteBranch(): void {
  if (ctxMenu.value.branch) void doDeleteBranch(ctxMenu.value.branch)
  closeCtxMenu()
}
function closeCtxMenu(): void { ctxMenu.value.show = false }

// All changed-file paths under a folder, scoped to the tree the menu opened on:
// staged tree → staged list; Changes tree → unstaged + untracked.
function filesUnderDir(dir: string, staged: boolean): string[] {
  const pool = staged
    ? gitStatus.value.staged
    : [...(gitStatus.value.unstaged ?? []), ...(gitStatus.value.untracked ?? [])]
  const prefix = dir + '/'
  return pool.filter((f) => f.path === dir || f.path.startsWith(prefix)).map((f) => f.path)
}
function ctxFolderStage(): void {
  void stageFiles(filesUnderDir(ctxMenu.value.dir, false))
  closeCtxMenu()
}
function ctxFolderUnstage(): void {
  void unstageFiles(filesUnderDir(ctxMenu.value.dir, true))
  closeCtxMenu()
}
function ctxFolderDiscard(): void {
  discardTargets.value = filesUnderDir(ctxMenu.value.dir, false)
  closeCtxMenu()
  if (discardTargets.value.length) showDiscardConfirm.value = true
}
async function ctxFolderAddIgnore(target: IgnoreTarget = 'project'): Promise<void> {
  if (ctxMenu.value.dir) await addToGitignore(ctxMenu.value.dir + '/', target)
  closeCtxMenu()
}
async function ctxFolderReveal(): Promise<void> {
  if (ctxMenu.value.dir) await window.agentTeam?.revealPath(absPath(ctxMenu.value.dir))
  closeCtxMenu()
}
async function ctxFolderCopyPath(rel: boolean): Promise<void> {
  const d = ctxMenu.value.dir
  if (d) await navigator.clipboard.writeText(rel ? d : absPath(d))
  closeCtxMenu()
}

function absPath(p: string): string {
  return `${props.workspacePath.replace(/\/+$/, '')}/${p}`
}
async function ctxOpenFile(): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await window.agentTeam?.openPath(absPath(f.path))
  closeCtxMenu()
}
async function ctxOpenFileAtHead(): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await showFile(f.path)
  if (r.ok) await window.agentTeam?.openTempFile(`${fileName(f.path)} (HEAD)`, r.content)
  else { gitError.value = r.error || '無法讀取 HEAD 版本' }
}
async function ctxReveal(): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await window.agentTeam?.revealPath(absPath(f.path))
  closeCtxMenu()
}
function ctxOpenChanges(): void {
  const f = ctxMenu.value.file
  if (f) toggleDiff(f.path, ctxMenu.value.staged)
  closeCtxMenu()
}
function ctxStageToggle(): void {
  const f = ctxMenu.value.file
  if (f) ctxMenu.value.staged ? unstageFile(f.path) : stageFile(f.path)
  closeCtxMenu()
}
function ctxDiscard(): void {
  const f = ctxMenu.value.file
  if (f) discardFile(f.path)
  closeCtxMenu()
}
async function ctxStashFile(): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await stashPush('', [f.path])
  if (!r.ok) gitError.value = r.error || 'draft failed'
}
async function ctxRestoreFromBranch(branch: string): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await restoreFileFromBranch(branch, f.path)
  if (!r.ok) gitError.value = r.error || 'restore failed'
}
function ctxHistory(): void {
  const f = ctxMenu.value.file
  if (f) showFileHistory(f.path)
  closeCtxMenu()
}
function ctxBlame(): void {
  const f = ctxMenu.value.file
  if (f) showBlame(f.path)
  closeCtxMenu()
}
async function ctxCopyPath(rel: boolean): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await navigator.clipboard.writeText(rel ? f.path : absPath(f.path))
  closeCtxMenu()
}
async function ctxAddToGitignore(target: IgnoreTarget = 'project'): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await addToGitignore(f.path, target)
  closeCtxMenu()
}

// "Why is this ignored?" — runs git check-ignore -v and shows the verdict.
const ignoreResult = ref<{ path: string; text: string } | null>(null)
async function ctxWhyIgnored(): Promise<void> {
  const f = ctxMenu.value.file
  const p = f ? f.path : (ctxMenu.value.dir || '')
  closeCtxMenu()
  if (!p) return
  const r = await checkIgnore(p)
  let text: string
  if (!r.ok) {
    text = r.error || 'check-ignore 失敗'
  } else if (r.ignored) {
    text = `被 ${r.source}:${r.line} 的規則「${r.pattern}」忽略`
    if (r.tracked) text += '；但此檔已被 git 追蹤，規則暫不生效 — 用「Add to .gitignore」會自動 untrack。'
  } else {
    text = r.tracked ? '沒有任何忽略規則命中（檔案已被追蹤）。' : '沒有任何忽略規則命中。'
  }
  ignoreResult.value = { path: p, text }
}
// "Why is this ignored?" only makes sense on a file that is actually ignored —
// a file showing up in Staged/Changes is by definition tracked, never ignored.
const ctxIsIgnored = computed(() => {
  const f = ctxMenu.value.file
  return !!f && (gitStatus.value?.ignored ?? []).some((ig) => ig.path === f.path)
})

// ── init ──────────────────────────────────────────────────────────────────────
const initError = ref('')
async function doInit(createGitignore: boolean): Promise<void> {
  initError.value = ''
  const r = await initRepo(createGitignore)
  if (!r.ok) initError.value = r.error || 'git init 失敗'
  else commitMessage.value = 'Initial commit'
}

// ── clone ───────────────────────────────────────────────────────────────────────
const cloneUrl = ref(''), cloneParent = ref(''), cloning = ref(false), cloneError = ref('')
function repoNameFromUrl(url: string): string {
  const seg = url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1)
  return seg || 'repo'
}
async function pickCloneDir(): Promise<void> {
  if (!window.agentTeam?.pickWorkspace) return
  const picked = await window.agentTeam.pickWorkspace(cloneParent.value || undefined)
  if (picked) cloneParent.value = picked
}
async function doClone(): Promise<void> {
  cloneError.value = ''
  if (!cloneUrl.value.trim()) { cloneError.value = '請輸入倉庫 URL'; return }
  if (!cloneParent.value.trim()) { cloneError.value = '請選擇目標資料夾'; return }
  const target = `${cloneParent.value.replace(/\/+$/, '')}/${repoNameFromUrl(cloneUrl.value)}`
  cloning.value = true
  try {
    const r = await cloneRepo(cloneUrl.value.trim(), target)
    if (!r.ok) { cloneError.value = r.error || 'clone 失敗'; return }
    if (r.path) emit('open-workspace', r.path)
  } finally {
    cloning.value = false
  }
}

// ── abort in-progress operation ──────────────────────────────────────────────────
const abortError = ref('')
const opInProgress = computed(() => gitStatus.value?.operation_in_progress ?? '')
async function doAbort(): Promise<void> {
  abortError.value = ''
  const op = opInProgress.value
  if (!op) return
  const r = await abortOperation(op)
  if (!r.ok) abortError.value = r.error || 'abort 失敗'
}

// ── commit graph (DAG lane layout) ───────────────────────────────────────────────
const GRAPH_LANE_W = 14 // px per lane column
const graphLayout = computed(() =>
  computeGraph(filteredLog.value.map((c) => ({ hash: c.hash, parents: c.parents ?? [] }))),
)
const graphWidth = computed(() => Math.max(graphLayout.value.width * GRAPH_LANE_W, GRAPH_LANE_W))
function laneX(lane: number): number { return lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 }

// ── changes ───────────────────────────────────────────────────────────────────
const hasStaged = computed(() => (gitStatus.value?.staged?.length ?? 0) > 0)
const hasChanges = computed(
  () => hasStaged.value || (gitStatus.value?.unstaged?.length ?? 0) > 0 || (gitStatus.value?.untracked?.length ?? 0) > 0
)
watch(gitStatus, (s) => {
  emit('changes-count', (s.staged?.length ?? 0) + (s.unstaged?.length ?? 0) + (s.untracked?.length ?? 0))
}, { immediate: true })

const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: '!', '?': 'U' }
function statusLabel(s: string): string { return STATUS_LABEL[s] ?? s }

// ── commit ────────────────────────────────────────────────────────────────────
const commitMessage = ref('')
const commitError = ref('')
const amendMode = ref(false)
const showCommitMenu = ref(false)
const canCommit = computed(() => hasStaged.value && commitMessage.value.trim().length > 0 && !isCommitting.value)

const commitInputEl = ref<HTMLTextAreaElement | null>(null)
function autoGrowCommit(): void {
  const el = commitInputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
watch(commitMessage, () => nextTick(autoGrowCommit))

// Commit variants mirror VS Code / Cursor's commit dropdown:
// plain Commit, Commit (Amend), Commit & Push, Commit & Sync.
async function runCommit(opts: { amend?: boolean; then?: 'push' | 'sync' } = {}): Promise<void> {
  showCommitMenu.value = false
  commitError.value = ''
  const amend = opts.amend ?? amendMode.value
  const r = amend ? await amendCommit(commitMessage.value) : await commit(commitMessage.value)
  if (!r.ok) { commitError.value = r.error || 'commit failed'; return }
  commitMessage.value = ''; amendMode.value = false; genAttempt.value = 0
  if (opts.then === 'push') await doPush()
  else if (opts.then === 'sync') await doSync()
}
async function doCommit(): Promise<void> { await runCommit() }
async function doUndo(): Promise<void> {
  commitError.value = ''
  const r = await undoLastCommit()
  if (!r.ok) commitError.value = r.error || 'undo failed'
}
// Each successive sparkle click raises the backend temperature (Copilot-style
// retry) to escape a repeated answer; reset to 0 once the form clears.
const genAttempt = ref(0)
async function doGenerate(): Promise<void> {
  commitError.value = ''
  const r = await generateMessage(props.analyzerModel || 'llama3.2', genAttempt.value)
  if (r.ok) { commitMessage.value = r.message; genAttempt.value++ }
  else commitError.value = r.error || 'generation failed'
}

// ── remote actions ────────────────────────────────────────────────────────────
const remoteOutput = ref('')
const remoteError = ref('')
const showRemoteOutput = ref(false)

// Tracks the in-flight remote operation so the clicked button shows a spinner
// and the rest stay disabled until it finishes.
const remoteBusy = ref<'' | 'fetch' | 'pull' | 'push' | 'sync' | 'publish'>('')
async function runRemote(op: Exclude<typeof remoteBusy.value, ''>, fn: () => Promise<void>): Promise<void> {
  if (remoteBusy.value) return
  remoteBusy.value = op
  try { await fn() } finally { remoteBusy.value = '' }
}
async function doFetch(): Promise<void> {
  await runRemote('fetch', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await fetchRemote()
    remoteOutput.value = r.output; remoteError.value = r.error
    showRemoteOutput.value = !!(r.output || r.error)
  })
}
async function doPull(): Promise<void> {
  await runRemote('pull', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await pullOnly()
    remoteOutput.value = r.output; remoteError.value = r.error
    showRemoteOutput.value = !!(r.output || r.error)
  })
}
async function doPush(): Promise<void> {
  await runRemote('push', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await pushOnly()
    remoteOutput.value = r.output; remoteError.value = r.error
    showRemoteOutput.value = !!(r.output || r.error)
  })
}
async function doPullRebase(): Promise<void> {
  showRemoteMenu.value = false
  await runRemote('pull', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await pullRebase()
    remoteOutput.value = r.output ?? ''; remoteError.value = r.error ?? ''
    showRemoteOutput.value = !!(r.output || r.error)
  })
}
async function doPushForce(): Promise<void> {
  showRemoteMenu.value = false
  await runRemote('push', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await pushForce()
    remoteOutput.value = r.output ?? ''; remoteError.value = r.error ?? ''
    showRemoteOutput.value = !!(r.output || r.error)
  })
}
async function doSync(): Promise<void> {
  await runRemote('sync', async () => {
    showRemoteOutput.value = false; remoteOutput.value = ''; remoteError.value = ''
    await sync()
    remoteOutput.value = syncOutput.value; remoteError.value = syncError.value
    showRemoteOutput.value = !!(syncOutput.value || syncError.value)
  })
}
async function doPushUpstream(): Promise<void> {
  const branch = gitStatus.value?.branch; if (!branch) return
  await runRemote('publish', async () => {
    remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
    const r = await pushUpstream(branch)
    remoteOutput.value = r.output || ''; remoteError.value = r.error || ''
    showRemoteOutput.value = !!(r.output || r.error)
  })
}

const aheadBehind = computed(() => {
  const a = gitStatus.value?.ahead ?? 0, b = gitStatus.value?.behind ?? 0
  if (!a && !b) return ''
  return [a ? `↑${a}` : '', b ? `↓${b}` : ''].filter(Boolean).join(' ')
})

// ── branches ──────────────────────────────────────────────────────────────────
const branchExpanded = ref(false)
const newBranchName = ref('')
const branchError = ref('')
const branchCreating = ref(false)

async function doCreateBranch(): Promise<void> {
  if (!newBranchName.value.trim()) return
  branchError.value = ''; branchCreating.value = true
  const r = await createBranch(newBranchName.value.trim())
  branchCreating.value = false
  if (r.ok) newBranchName.value = ''; else branchError.value = r.error || 'failed'
}
async function doSwitch(name: string): Promise<void> {
  branchError.value = ''
  const r = await switchBranch(name); if (!r.ok) branchError.value = r.error || 'switch failed'
}
async function doDeleteBranch(name: string): Promise<void> {
  branchError.value = ''
  const r = await deleteBranch(name, false); if (!r.ok) branchError.value = r.error || 'delete failed'
}

const comparingBranch = ref('')
const compareResult = ref<{ stat: string; files: string[] } | null>(null)
const compareError = ref('')
async function doCompareBranch(branch: string): Promise<void> {
  if (comparingBranch.value === branch) { comparingBranch.value = ''; compareResult.value = null; return }
  comparingBranch.value = branch; compareResult.value = null; compareError.value = ''
  const current = gitStatus.value?.branch; if (!current) return
  const r = await compareBranches(branch, current)
  if (r.ok) compareResult.value = { stat: r.stat, files: r.files }
  else compareError.value = r.error || 'compare failed'
}

const rebaseError = ref(''), rebaseOutput = ref('')
async function doRebase(branch: string): Promise<void> {
  rebaseError.value = ''; rebaseOutput.value = ''
  const r = await rebaseOn(branch)
  rebaseOutput.value = r.output || ''; if (!r.ok) rebaseError.value = r.error || 'rebase failed'
}

const mergeError = ref(''), mergeOutput = ref('')
async function doMerge(branch: string): Promise<void> {
  mergeError.value = ''; mergeOutput.value = ''
  const r = await mergeBranch(branch)
  mergeOutput.value = r.output || ''; if (!r.ok) mergeError.value = r.error || 'merge failed'
}

// ── stash ─────────────────────────────────────────────────────────────────────
const stashExpanded = ref(false), stashMessage = ref(''), stashError = ref('')
const showStashPrompt = ref(false)
// Auto-expand the Stashes section when stashes appear (e.g. after a stash push)
watch(() => gitStashes.value.length, (n, prev) => {
  if (n > 0 && (prev ?? 0) === 0) stashExpanded.value = true
}, { immediate: true })
function openStashPrompt(): void {
  stashError.value = ''; stashMessage.value = ''; showStashPrompt.value = true
}
async function doStash(): Promise<void> {
  stashError.value = ''
  const r = await stashPush(stashMessage.value)
  if (r.ok) { stashMessage.value = ''; showStashPrompt.value = false }
  else stashError.value = r.error || 'draft failed'
}
async function doStashApply(i: number): Promise<void> {
  stashError.value = ''
  const r = await stashApply(i); if (!r.ok) stashError.value = r.error || 'apply failed'
}
async function doStashPop(i: number): Promise<void> {
  stashError.value = ''
  const r = await stashPop(i); if (!r.ok) stashError.value = r.error || 'pop failed'
}
async function doStashDrop(i: number): Promise<void> {
  stashError.value = ''
  const r = await stashDrop(i); if (!r.ok) stashError.value = r.error || 'drop failed'
}

// ── remotes ───────────────────────────────────────────────────────────────────
const remoteExpanded = ref(false), newRemoteName = ref(''), newRemoteUrl = ref(''), remotesMgrError = ref('')
async function doAddRemote(): Promise<void> {
  remotesMgrError.value = ''
  const r = await addRemote(newRemoteName.value.trim(), newRemoteUrl.value.trim())
  if (r.ok) { newRemoteName.value = ''; newRemoteUrl.value = '' } else remotesMgrError.value = r.error || 'failed'
}
async function doRemoveRemote(name: string): Promise<void> {
  remotesMgrError.value = ''
  const r = await removeRemote(name); if (!r.ok) remotesMgrError.value = r.error || 'failed'
}

// ── tags ──────────────────────────────────────────────────────────────────────
const tagExpanded = ref(false), newTagName = ref(''), newTagMessage = ref(''), tagError = ref('')
async function doCreateTag(): Promise<void> {
  tagError.value = ''
  const r = await createTag(newTagName.value.trim(), newTagMessage.value.trim())
  if (r.ok) { newTagName.value = ''; newTagMessage.value = '' } else tagError.value = r.error || 'failed'
}
async function doDeleteTag(name: string): Promise<void> {
  tagError.value = ''
  const r = await deleteTag(name); if (!r.ok) tagError.value = r.error || 'failed'
}

// ── worktrees ─────────────────────────────────────────────────────────────────
const worktreeExpanded = ref(false), newWtPath = ref(''), newWtBranch = ref(''), newWtIsNew = ref(false), worktreeError = ref('')
const worktreeBranchOptions = computed(() => gitBranches.value.filter((b) => !b.is_remote).map((b) => b.name))
watch(newWtIsNew, () => { newWtBranch.value = '' })
async function doAddWorktree(): Promise<void> {
  worktreeError.value = ''
  const r = await addWorktree(newWtPath.value.trim(), newWtBranch.value.trim(), newWtIsNew.value)
  if (r.ok) { newWtPath.value = ''; newWtBranch.value = '' } else worktreeError.value = r.error || 'failed'
}
async function doRemoveWorktree(path: string): Promise<void> {
  worktreeError.value = ''
  const r = await removeWorktree(path); if (!r.ok) worktreeError.value = r.error || 'remove failed'
}
async function pickWorktreeDir(): Promise<void> {
  if (!window.agentTeam?.pickWorkspace) return
  const picked = await window.agentTeam.pickWorkspace(newWtPath.value || undefined)
  if (picked) newWtPath.value = picked
}

// ── config ────────────────────────────────────────────────────────────────────
const configExpanded = ref(false), configError = ref('')
const configDisplayKeys = computed(() =>
  gitConfigAllowedKeys.value.length ? gitConfigAllowedKeys.value
    : ['user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'pull.rebase']
)
const CONFIG_OPTIONS: Record<string, string[]> = {
  'core.autocrlf': ['true', 'false', 'input'],
  'core.filemode': ['true', 'false'],
  'pull.rebase': ['true', 'false'],
}
const inlineEditKey = ref(''), inlineEditValue = ref('')
function startInlineEdit(key: string): void {
  configError.value = ''
  inlineEditKey.value = key
  inlineEditValue.value = gitConfig.value[key] || ''
}
function cancelInlineEdit(): void { inlineEditKey.value = ''; inlineEditValue.value = '' }
async function saveInlineEdit(): Promise<void> {
  configError.value = ''
  const key = inlineEditKey.value
  if (!key) return
  const r = await setGitConfig(key, inlineEditValue.value)
  if (!r.ok) configError.value = r.error || 'failed'
  else cancelInlineEdit()
}

// ── blame ─────────────────────────────────────────────────────────────────────
const blamePath = ref(''), blameLines = ref<import('../composables/useGit').BlameEntry[]>([]), blameLoading = ref(false)
async function showBlame(path: string): Promise<void> {
  if (blamePath.value === path) { blamePath.value = ''; blameLines.value = []; return }
  blamePath.value = path; blameLoading.value = true
  blameLines.value = await blameFile(path); blameLoading.value = false
}

// ── diff blame (single-click inline preview) ────────────────────────────────────
// Shows only the changed lines with per-line blame, rather than the whole file.
const diffBlamePath = ref(''), diffBlameStaged = ref(false)
const diffBlameHunks = ref<import('../composables/useGit').DiffBlameHunk[]>([]), diffBlameLoading = ref(false)
async function showDiffBlame(path: string, staged: boolean): Promise<void> {
  if (diffBlamePath.value === path && diffBlameStaged.value === staged) {
    diffBlamePath.value = ''; diffBlameHunks.value = []; return
  }
  diffBlamePath.value = path; diffBlameStaged.value = staged; diffBlameLoading.value = true
  diffBlameHunks.value = await diffBlame(path, staged); diffBlameLoading.value = false
}

// ── diff ──────────────────────────────────────────────────────────────────────
// Open the standalone side-by-side diff window (kept the `toggleDiff` name so
// every call site stays unchanged). Staging happens inside that window; the
// backend broadcasts git.changed afterwards so this pane refreshes itself.
function toggleDiff(path: string, staged: boolean): void {
  void window.agentTeam?.openDiffWindow({
    workspace_path: props.workspacePath,
    filepath: path,
    staged,
    name: fileName(path),
  })
}

// File-name interaction: single click toggles inline blame; double click opens
// the standalone diff window. A short timer distinguishes the two (a dblclick
// also fires two clicks, so the pending single-click action is cancelled).
let fileClickTimer: ReturnType<typeof setTimeout> | null = null
function onFileClick(path: string, staged: boolean): void {
  if (fileClickTimer) return
  fileClickTimer = setTimeout(() => {
    fileClickTimer = null
    void showDiffBlame(path, staged)
  }, 220)
}
function onFileOpen(path: string, staged: boolean): void {
  if (fileClickTimer) { clearTimeout(fileClickTimer); fileClickTimer = null }
  toggleDiff(path, staged)
}

// ── file history ──────────────────────────────────────────────────────────────
const fileHistoryPath = ref(''), fileHistoryCommits = ref<import('../composables/useGit').GitCommit[]>([]), fileHistoryLoading = ref(false)
async function showFileHistory(path: string): Promise<void> {
  if (fileHistoryPath.value === path) { fileHistoryPath.value = ''; fileHistoryCommits.value = []; return }
  fileHistoryPath.value = path; fileHistoryLoading.value = true
  fileHistoryCommits.value = await fileLog(path); fileHistoryLoading.value = false
}

// ── conflict ──────────────────────────────────────────────────────────────────
const conflictError = ref('')
async function doResolveOurs(path: string): Promise<void> {
  conflictError.value = ''
  const r = await resolveConflictOurs(path); if (!r.ok) conflictError.value = r.error || 'failed'
}
async function doResolveTheirs(path: string): Promise<void> {
  conflictError.value = ''
  const r = await resolveConflictTheirs(path); if (!r.ok) conflictError.value = r.error || 'failed'
}

// ── clean ─────────────────────────────────────────────────────────────────────
const cleanPreview = ref<string[]>([]), cleanError = ref(''), showCleanConfirm = ref(false)
async function doCleanPreview(): Promise<void> {
  cleanError.value = ''
  const r = await cleanUntracked(true)
  if (!r.ok) { cleanError.value = r.error || 'preview failed'; return }
  cleanPreview.value = r.files; showCleanConfirm.value = r.files.length > 0
  if (!r.files.length) cleanError.value = 'No untracked files to clean'
}
async function doCleanConfirm(): Promise<void> {
  cleanError.value = ''
  const r = await cleanUntracked(false)
  showCleanConfirm.value = false; cleanPreview.value = []
  if (!r.ok) cleanError.value = r.error || 'clean failed'
}

// ── group actions: discard all (Changes) / unstage all (Staged) ─────────────────
// Errors surface through the shared gitError channel (set inside useGit's
// runWrite), so these handlers stay thin.
// Discard confirm is shared by the "Discard All" group action and folder-level
// discard; discardTargets holds whichever set of paths is being confirmed.
const showDiscardConfirm = ref(false)
const discardTargets = ref<string[]>([])
function openDiscardAll(): void {
  discardTargets.value = [
    ...(gitStatus.value.unstaged ?? []).map((f) => f.path),
    ...(gitStatus.value.untracked ?? []).map((f) => f.path),
  ]
  if (discardTargets.value.length) showDiscardConfirm.value = true
}
async function doDiscardConfirm(): Promise<void> {
  await discardFiles(discardTargets.value)
  showDiscardConfirm.value = false
}
async function doUnstageAll(): Promise<void> {
  await unstageFiles(gitStatus.value.staged.map((f) => f.path))
}

// ── commit detail ─────────────────────────────────────────────────────────────
const expandedCommitHash = ref(''), commitDetailData = ref<import('../composables/useGit').GitCommitDetail | null>(null), commitDetailLoading = ref(false)
async function toggleCommitDetail(hash: string): Promise<void> {
  if (expandedCommitHash.value === hash) { expandedCommitHash.value = ''; commitDetailData.value = null; return }
  expandedCommitHash.value = hash; commitDetailLoading.value = true
  commitDetailData.value = await showCommit(hash); commitDetailLoading.value = false
}

// ── cherry-pick / revert ──────────────────────────────────────────────────────
const cherryPickError = ref(''), revertError = ref('')
async function doCherryPick(hash: string): Promise<void> {
  cherryPickError.value = ''
  const r = await cherryPick(hash); if (!r.ok) cherryPickError.value = r.error || 'cherry-pick failed'
}
async function doRevert(hash: string): Promise<void> {
  revertError.value = ''
  const r = await revertCommit(hash); if (!r.ok) revertError.value = r.error || 'revert failed'
}

// ── history ───────────────────────────────────────────────────────────────────
const historyExpanded = ref(true), historySearch = ref('')
const filteredLog = computed(() => {
  if (!historySearch.value.trim()) return gitLog.value
  const q = historySearch.value.toLowerCase()
  return gitLog.value.filter(c =>
    c.message.toLowerCase().includes(q) || c.short_hash.toLowerCase().includes(q) ||
    c.branches.some(b => b.toLowerCase().includes(q))
  )
})

// History pagination (mirrors the pipeline list). Each item carries its global
// index `gi` so the commit graph / HEAD / revert logic stays aligned with the
// full filteredLog regardless of the current page.
const HISTORY_PAGE_SIZE = 15
const historyPage = ref(0)
const historyPageCount = computed(() => Math.ceil(filteredLog.value.length / HISTORY_PAGE_SIZE))
const pagedLog = computed(() => {
  const start = historyPage.value * HISTORY_PAGE_SIZE
  return filteredLog.value.slice(start, start + HISTORY_PAGE_SIZE).map((c, k) => ({ c, gi: start + k }))
})
watch(() => filteredLog.value.length, () => { historyPage.value = 0 })

// ── section expand states ─────────────────────────────────────────────────────
const stagedExpanded = ref(true)
const changesExpanded = ref(true)
const ignoredExpanded = ref(false)

// ── draggable split between top (changes) and bottom (history/cards) ────────────
const partTopEl = ref<HTMLElement | null>(null)
const gitTopRatio = ref<number>(
  (() => { try { return parseFloat(localStorage.getItem('agentTeam.gitTopRatio') ?? '') || 0.5 } catch { return 0.5 } })()
)
watch(gitTopRatio, (v) => { try { localStorage.setItem('agentTeam.gitTopRatio', String(v)) } catch {} })

let _gitDragStartY = 0, _gitDragStartTopPx = 0, _gitDragContainerPx = 0
function onGitDividerStart(e: MouseEvent): void {
  const top = partTopEl.value
  if (!top) return
  _gitDragStartY = e.clientY
  _gitDragStartTopPx = top.getBoundingClientRect().height
  _gitDragContainerPx = top.parentElement?.getBoundingClientRect().height || 0
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  document.addEventListener('mousemove', onGitDividerMove)
  document.addEventListener('mouseup', onGitDividerEnd)
  e.preventDefault()
}
function onGitDividerMove(e: MouseEvent): void {
  if (!_gitDragContainerPx) return
  const ratio = (_gitDragStartTopPx + e.clientY - _gitDragStartY) / _gitDragContainerPx
  gitTopRatio.value = Math.max(0.15, Math.min(0.85, ratio))
}
function onGitDividerEnd(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onGitDividerMove)
  document.removeEventListener('mouseup', onGitDividerEnd)
}

watch(() => props.workspacePath, () => {
  commitMessage.value = ''; commitError.value = ''; genAttempt.value = 0
  remoteOutput.value = ''; remoteError.value = ''; showRemoteOutput.value = false
  branchError.value = ''; stashError.value = ''
  clearGitError()
})

function shortBranch(r: string): string { return r.replace(/^refs\/(heads|remotes)\//, '') }
// A commit is HEAD when its ref names include "HEAD" (e.g. "HEAD -> branch", or
// bare "HEAD" when detached). In all-branches mode the topmost row isn't always
// HEAD, so we detect the ref rather than assuming index 0.
function isHeadCommit(c: import('../composables/useGit').GitCommit): boolean {
  return (c.branches ?? []).some(b => b === 'HEAD' || b.startsWith('HEAD '))
}
</script>

<template>
  <div class="git-pane" @click="showViewMenu = false; showCommitMenu = false">

    <div v-if="!workspacePath" class="empty-state">請先選擇 Workspace</div>

    <!-- ── Init panel ─────────────────────────────────────── -->
    <div v-else-if="!gitStatus.is_git_repo" class="init-panel">
      <svg class="init-svg" width="32" height="32" viewBox="0 0 16 16" fill="#3fb950">
        <path d="M15.698 7.287 8.712.302a1.03 1.03 0 0 0-1.457 0l-1.45 1.45 1.84 1.84a1.223 1.223 0 0 1 1.55 1.56l1.773 1.774a1.224 1.224 0 0 1 1.267 2.025 1.226 1.226 0 0 1-2.002-1.334L8.58 5.965v4.233a1.226 1.226 0 0 1 .321 2.432 1.226 1.226 0 0 1-1.11-1.384 1.224 1.224 0 0 1 .787-1.03V5.926a1.224 1.224 0 0 1-.666-1.608L6.076 2.486 .302 8.26a1.03 1.03 0 0 0 0 1.456l6.986 6.986a1.03 1.03 0 0 0 1.456 0l6.953-6.953a1.031 1.031 0 0 0 0-1.462z"/>
      </svg>
      <div class="init-title">尚未初始化 Git Repository</div>
      <div class="init-desc">此目錄還沒有 <code>.git</code> 資料夾</div>
      <button class="btn-primary w-full" :disabled="isInitializing" @click="doInit(true)">
        {{ isInitializing ? '初始化中…' : 'Initialize Repository' }}
      </button>
      <button class="btn-ghost w-full" style="font-size:11px" :disabled="isInitializing" @click="doInit(false)">
        Initialize (不建立 .gitignore)
      </button>
      <p v-if="initError" class="err-text">{{ initError }}</p>

      <!-- Clone an existing repository -->
      <div class="clone-box">
        <div class="clone-title">或 Clone 既有倉庫</div>
        <input
          v-model="cloneUrl"
          class="clone-input"
          placeholder="Repository URL (https://… 或 git@…)"
          :disabled="cloning"
        />
        <div class="clone-dir-row">
          <input
            v-model="cloneParent"
            class="clone-input"
            placeholder="目標資料夾…"
            :disabled="cloning"
          />
          <button class="btn-ghost clone-pick" :disabled="cloning" @click="pickCloneDir">瀏覽</button>
        </div>
        <button class="btn-primary w-full" :disabled="cloning" @click="doClone">
          {{ cloning ? 'Cloning…' : 'Clone Repository' }}
        </button>
        <p v-if="cloneError" class="err-text">{{ cloneError }}</p>
      </div>
    </div>

    <template v-else>

      <!-- ══════════════════════════════════════════════════════
           PART 1 — COMMIT
           ══════════════════════════════════════════════════════ -->

      <!-- Panel header -->
      <div class="panel-header">
        <span class="panel-title">SOURCE CONTROL</span>
        <div class="spacer" />
        <!-- View mode toggle (single button: list ⇄ tree) -->
        <button
          class="hdr-btn"
          :title="viewMode === 'tree' ? 'Switch to List View' : 'Switch to Tree View'"
          @click.stop="viewMode = viewMode === 'tree' ? 'list' : 'tree'; showViewMenu = false"
        >
          <svg v-if="viewMode === 'tree'" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM1.5 8a.75.75 0 1 1 1.5 0A.75.75 0 0 1 1.5 8zm.75 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 3.5h9.5a.75.75 0 0 0 0-1.5h-9.5a.75.75 0 0 0 0 1.5zM4 8.75h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5zm0 5.5h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5z"/></svg>
          <svg v-else width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1.5H2zm0 3.5h12V9H2zm0 3.5h12v1.5H2z"/></svg>
        </button>
        <button class="hdr-btn" title="Refresh" :disabled="isFetching" @click.stop="doFetch">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
        </button>
        <!-- Sort menu -->
        <button class="hdr-btn" title="More options" @click.stop="openViewMenu($event)">···</button>
        <Teleport to="body">
          <div v-if="showViewMenu" class="tp-backdrop" @click="showViewMenu = false" />
          <div v-if="showViewMenu" class="tp-dropdown" :style="{ top: viewMenuPos.top + 'px', right: viewMenuPos.right + 'px' }" @click.stop>
            <div class="menu-group-label">View</div>
            <button class="menu-item" @click="viewMode = 'list'; showViewMenu = false">
              <span class="menu-check">{{ viewMode === 'list' ? '✓' : '' }}</span> View as List
            </button>
            <button class="menu-item" @click="viewMode = 'tree'; showViewMenu = false">
              <span class="menu-check">{{ viewMode === 'tree' ? '✓' : '' }}</span> View as Tree
            </button>
            <div class="menu-sep" />
            <div class="menu-group-label">Sort by</div>
            <button class="menu-item" @click="sortBy = 'name'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'name' ? '✓' : '' }}</span> Name
            </button>
            <button class="menu-item" @click="sortBy = 'path'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'path' ? '✓' : '' }}</span> Path
            </button>
            <button class="menu-item" @click="sortBy = 'status'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'status' ? '✓' : '' }}</span> Status
            </button>
            <div class="menu-sep" />
            <button class="menu-item" @click="showIgnored = !showIgnored; showViewMenu = false">
              <span class="menu-check">{{ showIgnored ? '✓' : '' }}</span> Show Ignored Files
            </button>
          </div>
        </Teleport>
      </div>

      <!-- In-progress operation banner (merge / rebase / cherry-pick) -->
      <div v-if="opInProgress" class="op-banner">
        <span class="op-text">⚠ {{ opInProgress }} 進行中</span>
        <button class="op-abort-btn" @click="doAbort">Abort {{ opInProgress }}</button>
        <span v-if="abortError" class="op-err">{{ abortError }}</span>
      </div>

      <!-- ── PART 1 scroll region ──────────────────────────────── -->
      <div ref="partTopEl" class="git-scroll part-top" :style="{ flexBasis: gitTopRatio * 100 + '%' }">

      <!-- Commit message input -->
      <div class="commit-area">
        <div class="commit-input-row">
          <textarea
            ref="commitInputEl"
            v-model="commitMessage"
            class="commit-input"
            :placeholder="amendMode ? 'Amend message…' : 'Message (⌘↩ to commit)'"
            rows="1"
            @input="autoGrowCommit"
            @keydown.meta.enter.prevent="canCommit && doCommit()"
            @keydown.ctrl.enter.prevent="canCommit && doCommit()"
            @click.stop
          />
          <button class="ai-btn" :class="{ generating: isGenerating }" :disabled="isGenerating || !hasChanges" title="AI 生成 commit message" @click.stop="doGenerate">
            <span v-if="isGenerating" class="spinner">⟳</span><span v-else>✦</span>
          </button>
        </div>
        <p v-if="commitError" class="err-text" style="padding: 0 2px">{{ commitError }}</p>

        <!-- Commit button with dropdown -->
        <div class="commit-btn-row">
          <button class="commit-main-btn" :disabled="!canCommit" @click.stop="doCommit">
            <span v-if="isCommitting">Committing…</span>
            <span v-else>✓ {{ amendMode ? 'Amend Commit' : 'Commit' }}</span>
          </button>
          <button class="commit-arrow-btn" :disabled="!hasStaged && !gitLog.length" title="More options" @click.stop="openCommitMenu($event)">▾</button>
          <Teleport to="body">
            <div v-if="showCommitMenu" class="tp-backdrop" @click="showCommitMenu = false" />
            <div v-if="showCommitMenu" class="tp-dropdown" :style="{ top: showCommitMenuPos.top + 'px', right: showCommitMenuPos.right + 'px' }" @click.stop>
              <button class="menu-item" :disabled="!canCommit" @click="runCommit()">✓ Commit</button>
              <button class="menu-item" :disabled="!gitLog.length" @click="runCommit({ amend: true })">✎ Commit (Amend)</button>
              <div class="menu-sep" />
              <button class="menu-item" :disabled="!canCommit" @click="runCommit({ then: 'push' })">↑ Commit &amp; Push</button>
              <button class="menu-item" :disabled="!canCommit" @click="runCommit({ then: 'sync' })">⇅ Commit &amp; Sync</button>
              <div class="menu-sep" />
              <button class="menu-item" :disabled="!gitLog.length" @click="doUndo(); showCommitMenu = false">
                ↺ Undo Last Commit
              </button>
            </div>
          </Teleport>
        </div>
      </div>

      <!-- ── STAGED CHANGES ──────────────────────────────────── -->
      <div class="sec-hdr clickable" @click="stagedExpanded = !stagedExpanded">
        <span class="sec-caret">{{ stagedExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">Staged Changes</span>
        <span v-if="hasStaged" class="sec-badge">{{ gitStatus.staged.length }}</span>
        <div class="spacer" />
        <div class="sec-actions" @click.stop>
          <button v-if="hasStaged" class="sec-btn" title="Unstage All Changes" @click="doUnstageAll">−</button>
        </div>
      </div>
      <p v-if="gitError" class="err-text git-error-row" style="padding:2px 16px">
        {{ gitError }}
        <button class="git-error-x" title="Dismiss" @click.stop="clearGitError">✕</button>
      </p>

      <div v-if="stagedExpanded && hasStaged" class="file-group">
        <div v-if="conflictError" class="err-text" style="padding:2px 16px">{{ conflictError }}</div>

        <!-- Tree mode -->
        <template v-if="viewMode === 'tree'">
          <template v-for="row in flattenTree(gitStatus.staged, 's:')" :key="'s:' + row.key">
            <div
              v-if="row.kind === 'folder'"
              class="folder-row" :style="treeIndent(row.depth)" @click.stop="toggleDir(row.key)"
              @contextmenu="openFolderCtxMenu($event, row.dir!, true)"
            >
              <span class="folder-caret">{{ collapsedDirs.has(row.key) ? '▸' : '▾' }}</span>
              <svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              <span class="folder-name" :title="row.dir">{{ row.name }}</span>
              <span class="folder-count">{{ row.fileCount }}</span>
            </div>
            <template v-else>
              <div
                class="file-row" :style="treeIndent(row.depth)" :class="{ 'row-conflict': row.file!.status === 'U' }"
                @contextmenu="openCtxMenu($event, row.file!, true)"
              >
                <span class="file-status" :data-s="row.file!.status">{{ statusLabel(row.file!.status) }}</span>
                <span class="file-name-only" :title="row.file!.path" @click="onFileClick(row.file!.path, true)" @dblclick="onFileOpen(row.file!.path, true)">{{ row.name }}</span>
                <div class="row-actions">
                  <template v-if="row.file!.status === 'U'">
                    <button class="row-btn" title="Accept Ours" @click.stop="doResolveOurs(row.file!.path)">↰</button>
                    <button class="row-btn" title="Accept Theirs" @click.stop="doResolveTheirs(row.file!.path)">↱</button>
                  </template>
                  <template v-else>
                    <button class="row-btn" title="File history" @click.stop="showFileHistory(row.file!.path)">⊡</button>
                    <button class="row-btn" title="Unstage" @click.stop="unstageFile(row.file!.path)">−</button>
                  </template>
                </div>
              </div>
              <div v-if="fileHistoryPath === row.file!.path" class="subpanel blue-border">
                <div v-if="fileHistoryLoading" class="loading-text">Loading…</div>
                <div v-else-if="!fileHistoryCommits.length" class="loading-text">尚無提交歷史</div>
                <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                  <code class="hash-tag">{{ hc.short_hash }}</code>
                  <span class="mini-msg">{{ hc.message }}</span>
                </div>
              </div>
              <div v-if="blamePath === row.file!.path" class="subpanel yellow-border blame-inline">
                <div v-if="blameLoading" class="loading-text">Loading…</div>
                <div v-else-if="!blameLines.length" class="loading-text">尚無 blame 資訊</div>
                <div v-for="l in blameLines" :key="l.line_no" class="blame-line">
                  <span class="blame-ln">{{ l.line_no }}</span>
                  <code class="blame-content">{{ l.content }}</code>
                  <span class="blame-annot">{{ l.author }}, {{ l.date }}</span>
                </div>
              </div>
              <div v-if="diffBlamePath === row.file!.path && diffBlameStaged" class="subpanel green-border diffblame-inline">
                <div v-if="diffBlameLoading" class="loading-text">Loading…</div>
                <div v-else-if="!diffBlameHunks.length" class="loading-text">沒有可顯示的變更</div>
                <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                  <div class="db-hunk-head">{{ dh.header }}</div>
                  <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                    <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                    <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                    <code class="db-code">{{ dl.text }}</code>
                    <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : '未提交' }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </template>

        <!-- List mode -->
        <template v-else>
          <template v-for="f in sortFiles(gitStatus.staged)" :key="'sl:' + f.path">
            <div class="file-row" :class="{ 'row-conflict': f.status === 'U' }" @contextmenu="openCtxMenu($event, f, true)">
              <span class="file-status" :data-s="f.status">{{ statusLabel(f.status) }}</span>
              <span class="file-name-main" :title="f.path" @click="onFileClick(f.path, true)" @dblclick="onFileOpen(f.path, true)">{{ fileName(f.path) }}</span>
              <span class="file-path-dim" :title="f.path" @click="onFileClick(f.path, true)" @dblclick="onFileOpen(f.path, true)">{{ fileDir(f.path) }}</span>
              <div class="row-actions">
                <template v-if="f.status === 'U'">
                  <button class="row-btn" title="Accept Ours" @click.stop="doResolveOurs(f.path)">↰</button>
                  <button class="row-btn" title="Accept Theirs" @click.stop="doResolveTheirs(f.path)">↱</button>
                </template>
                <template v-else>
                  <button class="row-btn" title="File history" @click.stop="showFileHistory(f.path)">⊡</button>
                </template>
              </div>
            </div>
            <div v-if="fileHistoryPath === f.path" class="subpanel blue-border">
              <div v-if="fileHistoryLoading" class="loading-text">Loading…</div>
              <div v-else-if="!fileHistoryCommits.length" class="loading-text">尚無提交歷史</div>
              <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                <code class="hash-tag">{{ hc.short_hash }}</code>
                <span class="mini-msg">{{ hc.message }}</span>
              </div>
            </div>
            <div v-if="blamePath === f.path" class="subpanel yellow-border blame-inline">
              <div v-if="blameLoading" class="loading-text">Loading…</div>
              <div v-else-if="!blameLines.length" class="loading-text">尚無 blame 資訊</div>
              <div v-for="l in blameLines" :key="l.line_no" class="blame-line">
                <span class="blame-ln">{{ l.line_no }}</span>
                <code class="blame-content">{{ l.content }}</code>
                <span class="blame-annot">{{ l.author }}, {{ l.date }}</span>
              </div>
            </div>
            <div v-if="diffBlamePath === f.path && diffBlameStaged" class="subpanel green-border diffblame-inline">
              <div v-if="diffBlameLoading" class="loading-text">Loading…</div>
              <div v-else-if="!diffBlameHunks.length" class="loading-text">沒有可顯示的變更</div>
              <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                <div class="db-hunk-head">{{ dh.header }}</div>
                <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                  <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                  <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                  <code class="db-code">{{ dl.text }}</code>
                  <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : '未提交' }}</span>
                </div>
              </template>
            </div>
          </template>
        </template>
      </div>

      <!-- ── CHANGES (unstaged) ──────────────────────────────── -->
      <div class="sec-hdr clickable" @click="changesExpanded = !changesExpanded">
        <span class="sec-caret">{{ changesExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">Changes</span>
        <span v-if="gitStatus.unstaged?.length || gitStatus.untracked?.length" class="sec-badge">
          {{ (gitStatus.unstaged?.length ?? 0) + (gitStatus.untracked?.length ?? 0) }}
        </span>
        <div class="spacer" />
        <div class="sec-actions" @click.stop>
          <button v-if="gitStatus.untracked?.length" class="sec-btn danger" title="Clean untracked" @click="doCleanPreview">🗑</button>
          <button v-if="hasChanges" class="sec-btn danger" title="Discard All Changes" @click="openDiscardAll">↩</button>
          <button v-if="hasChanges" class="sec-btn" title="Save Draft" @click="openStashPrompt">⊙</button>
          <button v-if="hasChanges" class="sec-btn" title="Stage All" @click="stageAll">＋</button>
        </div>
      </div>

      <!-- Discard confirm (shared by Discard All + folder discard) -->
      <div v-if="showDiscardConfirm" class="clean-box">
        <div class="clean-title">捨棄 {{ discardTargets.length }} 項變更？此動作無法復原</div>
        <div v-for="f in discardTargets" :key="f" class="clean-file">{{ f }}</div>
        <div class="clean-actions">
          <button class="btn-ghost" @click="showDiscardConfirm = false">取消</button>
          <button class="btn-danger" @click="doDiscardConfirm">確認捨棄</button>
        </div>
      </div>

      <!-- Stash with optional label -->
      <div v-if="showStashPrompt" class="stash-box">
        <div class="stash-title">儲存為 Draft（標記可留空）</div>
        <div class="input-row">
          <input
            v-model="stashMessage"
            class="git-input"
            type="text"
            placeholder="為這次 Draft 命名…（選填）"
            @keydown.enter="doStash"
            @keydown.esc="showStashPrompt = false"
          />
        </div>
        <div class="clean-actions">
          <button class="btn-ghost" @click="showStashPrompt = false">取消</button>
          <button class="btn-primary" @click="doStash">Save Draft</button>
        </div>
        <p v-if="stashError" class="err-text">{{ stashError }}</p>
      </div>

      <!-- Clean confirm -->
      <div v-if="showCleanConfirm" class="clean-box">
        <div class="clean-title">刪除 {{ cleanPreview.length }} 個未追蹤檔案？</div>
        <div v-for="f in cleanPreview" :key="f" class="clean-file">{{ f }}</div>
        <div class="clean-actions">
          <button class="btn-ghost" @click="showCleanConfirm = false; cleanPreview = []">取消</button>
          <button class="btn-danger" @click="doCleanConfirm">確認刪除</button>
        </div>
      </div>
      <p v-if="cleanError" class="err-text" style="padding: 2px 16px">{{ cleanError }}</p>

      <div v-if="changesExpanded">
        <div v-if="!hasChanges" class="empty-msg">No changes</div>

        <div v-else class="file-group">
          <!-- Tree mode -->
          <template v-if="viewMode === 'tree'">
            <template v-for="row in flattenTree([...gitStatus.unstaged, ...gitStatus.untracked], 'u:')" :key="'u:' + row.key">
              <div
                v-if="row.kind === 'folder'"
                class="folder-row" :style="treeIndent(row.depth)" @click.stop="toggleDir(row.key)"
                @contextmenu="openFolderCtxMenu($event, row.dir!, false)"
              >
                <span class="folder-caret">{{ collapsedDirs.has(row.key) ? '▸' : '▾' }}</span>
                <svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
                <span class="folder-name" :title="row.dir">{{ row.name }}</span>
                <span class="folder-count">{{ row.fileCount }}</span>
              </div>
              <template v-else>
                <div
                  class="file-row" :style="treeIndent(row.depth)"
                  @contextmenu="openCtxMenu($event, row.file!, false)"
                >
                  <span class="file-status unstaged-st" :data-s="row.file!.status">{{ statusLabel(row.file!.status) }}</span>
                  <span class="file-name-only" :title="row.file!.path" @click="onFileClick(row.file!.path, false)" @dblclick="onFileOpen(row.file!.path, false)">{{ row.name }}</span>
                  <div class="row-actions">
                    <button class="row-btn" title="File history" @click.stop="showFileHistory(row.file!.path)">⊡</button>
                    <button class="row-btn danger shrink" title="Discard" @click.stop="discardFile(row.file!.path)">✕</button>
                    <button class="row-btn primary" title="Stage" @click.stop="stageFile(row.file!.path)">＋</button>
                  </div>
                </div>
                <div v-if="fileHistoryPath === row.file!.path" class="subpanel blue-border">
                  <div v-if="fileHistoryLoading" class="loading-text">Loading…</div>
                  <div v-else-if="!fileHistoryCommits.length" class="loading-text">尚無提交歷史</div>
                  <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                    <code class="hash-tag">{{ hc.short_hash }}</code>
                    <span class="mini-msg">{{ hc.message }}</span>
                  </div>
                </div>
                <div v-if="blamePath === row.file!.path" class="subpanel yellow-border blame-inline">
                  <div v-if="blameLoading" class="loading-text">Loading…</div>
                  <div v-else-if="!blameLines.length" class="loading-text">尚無 blame 資訊</div>
                  <div v-for="l in blameLines" :key="l.line_no" class="blame-line">
                    <span class="blame-ln">{{ l.line_no }}</span>
                    <code class="blame-content">{{ l.content }}</code>
                    <span class="blame-annot">{{ l.author }}, {{ l.date }}</span>
                  </div>
                </div>
                <div v-if="diffBlamePath === row.file!.path && !diffBlameStaged" class="subpanel green-border diffblame-inline">
                  <div v-if="diffBlameLoading" class="loading-text">Loading…</div>
                  <div v-else-if="!diffBlameHunks.length" class="loading-text">沒有可顯示的變更</div>
                  <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                    <div class="db-hunk-head">{{ dh.header }}</div>
                    <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                      <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                      <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                      <code class="db-code">{{ dl.text }}</code>
                      <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : '未提交' }}</span>
                    </div>
                  </template>
                </div>
              </template>
            </template>
          </template>

          <!-- List mode -->
          <template v-else>
            <template v-for="f in sortFiles([...gitStatus.unstaged, ...gitStatus.untracked])" :key="'ul:' + f.path">
              <div class="file-row" @contextmenu="openCtxMenu($event, f, false)">
                <span class="file-status unstaged-st" :data-s="f.status">{{ statusLabel(f.status) }}</span>
                <span class="file-name-main" :title="f.path" @click="onFileClick(f.path, false)" @dblclick="onFileOpen(f.path, false)">{{ fileName(f.path) }}</span>
                <span class="file-path-dim" :title="f.path" @click="onFileClick(f.path, false)" @dblclick="onFileOpen(f.path, false)">{{ fileDir(f.path) }}</span>
                <div class="row-actions">
                  <button class="row-btn" title="File history" @click.stop="showFileHistory(f.path)">⊡</button>
                  <button class="row-btn danger shrink" title="Discard" @click.stop="discardFile(f.path)">✕</button>
                  <button class="row-btn primary" title="Stage" @click.stop="stageFile(f.path)">＋</button>
                </div>
              </div>
              <div v-if="fileHistoryPath === f.path" class="subpanel blue-border">
                <div v-if="fileHistoryLoading" class="loading-text">Loading…</div>
                <div v-else-if="!fileHistoryCommits.length" class="loading-text">尚無提交歷史</div>
                <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                  <code class="hash-tag">{{ hc.short_hash }}</code>
                  <span class="mini-msg">{{ hc.message }}</span>
                </div>
              </div>
              <div v-if="blamePath === f.path" class="subpanel yellow-border blame-inline">
                <div v-if="blameLoading" class="loading-text">Loading…</div>
                <div v-else-if="!blameLines.length" class="loading-text">尚無 blame 資訊</div>
                <div v-for="l in blameLines" :key="l.line_no" class="blame-line">
                  <span class="blame-ln">{{ l.line_no }}</span>
                  <code class="blame-content">{{ l.content }}</code>
                  <span class="blame-annot">{{ l.author }}, {{ l.date }}</span>
                </div>
              </div>
              <div v-if="diffBlamePath === f.path && !diffBlameStaged" class="subpanel green-border diffblame-inline">
                <div v-if="diffBlameLoading" class="loading-text">Loading…</div>
                <div v-else-if="!diffBlameHunks.length" class="loading-text">沒有可顯示的變更</div>
                <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                  <div class="db-hunk-head">{{ dh.header }}</div>
                  <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                    <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                    <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                    <code class="db-code">{{ dl.text }}</code>
                    <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : '未提交' }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- ── IGNORED (only when "Show Ignored Files" is on) ──────── -->
      <div v-if="showIgnored" class="sec-hdr clickable" @click="ignoredExpanded = !ignoredExpanded">
        <span class="sec-caret">{{ ignoredExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">Ignored</span>
        <span v-if="gitStatus.ignored?.length" class="sec-badge">{{ gitStatus.ignored.length }}</span>
        <div class="spacer" />
      </div>
      <div v-if="showIgnored && ignoredExpanded">
        <div v-if="!gitStatus.ignored?.length" class="empty-msg">No ignored files</div>
        <template v-for="f in sortFiles(gitStatus.ignored ?? [])" :key="'ig:' + f.path">
          <div class="file-row ignored-row" @contextmenu="openCtxMenu($event, f, false)">
            <span class="file-status" :title="'ignored'">!</span>
            <span class="file-name-main" :title="f.path">{{ fileName(f.path) }}</span>
            <span class="file-path-dim" :title="f.path">{{ fileDir(f.path) }}</span>
          </div>
        </template>
      </div>

      </div><!-- /part-top -->

      <!-- ══════════════════════════════════════════════════════
           PART 2 — REMOTE / HISTORY
           ══════════════════════════════════════════════════════ -->
      <div class="part-resize" title="拖曳調整上下比例" @mousedown="onGitDividerStart">
        <div class="part-resize-grip" />
      </div>

      <!-- ── PART 2 scroll region ──────────────────────────────── -->
      <div class="git-scroll part-bottom">

      <!-- Branch + remote action bar -->
      <div class="remote-bar">
        <button class="branch-pill" :class="{ active: branchExpanded }" @click.stop="branchExpanded = !branchExpanded">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
          <span>{{ gitStatus.branch || '(detached)' }}</span>
          <span v-if="aheadBehind" class="ab-text">{{ aheadBehind }}</span>
        </button>
        <div class="spacer" />
        <button v-if="gitStatus.branch && !gitStatus.remote_branch" class="remote-btn publish-btn" :class="{ busy: remoteBusy === 'publish' }" title="Publish Branch" :disabled="!!remoteBusy" @click="doPushUpstream">
          <span v-if="remoteBusy === 'publish'" class="spinner">⟳</span><template v-else>↑ Publish</template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'fetch' }" title="Fetch" :disabled="!!remoteBusy" @click="doFetch">
          <span v-if="remoteBusy === 'fetch'" class="spinner">⟳</span>
          <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'pull' }" title="Pull" :disabled="!!remoteBusy" @click="doPull">
          <span v-if="remoteBusy === 'pull'" class="spinner">⟳</span><template v-else>↓</template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'push' }" title="Push" :disabled="!!remoteBusy" @click="doPush">
          <span v-if="remoteBusy === 'push'" class="spinner">⟳</span><template v-else>↑<span v-if="gitStatus.ahead" class="ahead-num">{{ gitStatus.ahead }}</span></template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'sync' }" title="Sync (pull --rebase + push)" :disabled="!!remoteBusy" @click="doSync">
          <span v-if="remoteBusy === 'sync'" class="spinner">⟳</span><template v-else>⇅</template>
        </button>
        <button class="remote-btn" title="More pull/push options" :disabled="!!remoteBusy" @click.stop="openRemoteMenu($event)">▾</button>
        <Teleport to="body">
          <div v-if="showRemoteMenu" class="tp-backdrop" @click="showRemoteMenu = false" />
          <div v-if="showRemoteMenu" class="tp-dropdown" :style="{ top: remoteMenuPos.top + 'px', right: remoteMenuPos.right + 'px' }" @click.stop>
            <button class="menu-item" @click="doPull(); showRemoteMenu = false">↓ Pull</button>
            <button class="menu-item" @click="doPullRebase">↓ Pull (Rebase)</button>
            <div class="menu-sep" />
            <button class="menu-item" @click="doPush(); showRemoteMenu = false">↑ Push</button>
            <button class="menu-item danger" @click="doPushForce">↑ Push (Force with lease)</button>
          </div>
        </Teleport>
      </div>

      <!-- Remote output -->
      <div v-if="showRemoteOutput && (remoteOutput || remoteError)" class="remote-output">
        <pre v-if="remoteOutput">{{ remoteOutput }}</pre>
        <pre v-if="remoteError" class="err-pre">{{ remoteError }}</pre>
        <button class="close-btn" @click="showRemoteOutput = false">✕</button>
      </div>

      <!-- Branch panel -->
      <div v-if="branchExpanded" class="collapsible-body">
        <div class="input-row">
          <input v-model="newBranchName" class="git-input" placeholder="New branch name…" @keydown.enter="doCreateBranch" />
          <button class="btn-ghost sm" :disabled="branchCreating || !newBranchName.trim()" @click="doCreateBranch">＋</button>
        </div>
        <p v-if="branchError || mergeError || rebaseError" class="err-text">{{ branchError || mergeError || rebaseError }}</p>
        <p v-if="mergeOutput || rebaseOutput" class="ok-text">{{ mergeOutput || rebaseOutput }}</p>
        <div v-for="b in gitBranches" :key="b.name" class="branch-row" :class="{ current: b.is_current }" @contextmenu.prevent="!b.is_current && openBranchCtxMenu($event, b.name)">
          <span class="b-check">{{ b.is_current ? '✓' : '' }}</span>
          <span class="b-name">{{ b.name }}</span>
          <span v-if="b.tracking" class="b-track">→ {{ b.tracking }}</span>
          <div class="spacer" />
          <template v-if="!b.is_current">
            <button class="row-btn always" title="Compare" @click.stop="doCompareBranch(b.name)">⇔</button>
            <button class="row-btn always" title="Rebase onto" @click.stop="doRebase(b.name)">⇡</button>
            <button class="row-btn always" title="Merge into current" @click.stop="doMerge(b.name)">⇣</button>
            <button class="row-btn always" title="Switch" @click.stop="doSwitch(b.name)">↵</button>
          </template>
        </div>
        <div v-if="comparingBranch && compareResult" class="compare-panel">
          <div class="compare-title">{{ comparingBranch }} ↔ {{ gitStatus.branch }}</div>
          <div class="compare-stat">{{ compareResult.stat }}</div>
          <div v-for="f in compareResult.files" :key="f" class="compare-file">{{ f }}</div>
        </div>
      </div>

      <!-- ── HISTORY ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="historyExpanded = !historyExpanded">
          <span class="sec-caret">{{ historyExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">History</span>
          <div class="spacer" />
        </div>
        <div v-if="historyExpanded" class="card-body">
        <div class="history-search-row">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="#6e7681" style="flex-shrink:0"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
          <input v-model="historySearch" class="search-input" placeholder="Search commits…" @click.stop />
        </div>
        <div class="history-scope-row" @click.stop>
          <button class="scope-btn" :class="{ active: logScope === 'all' }" :disabled="isLoadingLog" @click="setLogScope('all')">All branches</button>
          <button class="scope-btn" :class="{ active: logScope === 'current' }" :disabled="isLoadingLog" @click="setLogScope('current')">Current</button>
        </div>
        <p v-if="revertError || cherryPickError" class="err-text" style="padding:2px 16px">{{ revertError || cherryPickError }}</p>
        <div v-if="!filteredLog.length" class="empty-msg">{{ historySearch ? 'No matches' : 'No commits yet' }}</div>
        <div v-else class="commit-list">
          <div v-for="{ c, gi } in pagedLog" :key="c.hash">
            <div class="commit-row" @click="toggleCommitDetail(c.hash)">
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
                <button v-if="gi > 0" class="row-btn always" title="Revert" @click="doRevert(c.hash)">↺</button>
                <button v-if="gi > 0" class="row-btn always" title="Cherry-pick" @click="doCherryPick(c.hash)">🍒</button>
                <span class="expand-caret">{{ expandedCommitHash === c.hash ? '▾' : '▸' }}</span>
              </div>
            </div>
            <div v-if="expandedCommitHash === c.hash" class="commit-detail">
              <div v-if="commitDetailLoading" class="loading-text">Loading…</div>
              <template v-else-if="commitDetailData">
                <div class="cd-row"><span class="cd-key">Author</span><span>{{ commitDetailData.author_name }} &lt;{{ commitDetailData.author_email }}&gt;</span></div>
                <div class="cd-row"><span class="cd-key">Date</span><span>{{ new Date(commitDetailData.date).toLocaleString() }}</span></div>
                <div v-if="commitDetailData.body" class="cd-body">{{ commitDetailData.body }}</div>
                <div v-if="commitDetailData.files.length">
                  <div class="cd-key">Files ({{ commitDetailData.files.length }})</div>
                  <div v-for="f in commitDetailData.files" :key="f" class="cd-file">{{ f }}</div>
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
        <div v-if="canLoadMoreLog && historyPage >= historyPageCount - 1" class="history-load-more">
          <button class="load-more-btn" :disabled="isLoadingLog" @click="loadMoreLog">
            {{ isLoadingLog ? 'Loading…' : 'Load more' }}
          </button>
        </div>
        </div>
      </div>

      <!-- ── STASHES ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="stashExpanded = !stashExpanded">
          <span class="sec-caret">{{ stashExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">Draft</span>
          <span v-if="gitStashes.length" class="sec-badge">{{ gitStashes.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="stashExpanded" class="card-body">
        <div v-if="!gitStashes.length" class="empty-msg">No draft</div>
        <div v-for="s in gitStashes" :key="s.ref" class="generic-row">
          <span class="stash-ref">{{ s.ref }}</span>
          <span class="stash-msg">{{ s.message }}</span>
          <div class="row-actions always">
            <button class="row-btn always" title="Apply (keep draft)" @click.stop="doStashApply(s.index)">⎘</button>
            <button class="row-btn always" title="Pop (apply &amp; remove)" @click.stop="doStashPop(s.index)">↑</button>
            <button class="row-btn always danger" title="Drop" @click.stop="doStashDrop(s.index)">✕</button>
          </div>
        </div>
        <p v-if="stashError" class="err-text">{{ stashError }}</p>
        </div>
      </div>

      <!-- ── REMOTES ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="remoteExpanded = !remoteExpanded">
          <span class="sec-caret">{{ remoteExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">Remotes</span>
          <span v-if="gitRemotes.length" class="sec-badge">{{ gitRemotes.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="remoteExpanded" class="card-body collapsible-body">
        <div v-if="!gitRemotes.length" class="empty-msg" style="padding:2px 0">No remotes</div>
        <div v-for="r in gitRemotes" :key="r.name" class="generic-row">
          <span class="remote-name">{{ r.name }}</span>
          <span class="remote-url" :title="r.fetch_url">{{ r.fetch_url }}</span>
          <button class="row-btn always danger" @click.stop="doRemoveRemote(r.name)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px">
          <input v-model="newRemoteName" class="git-input" placeholder="Name" style="width:72px;flex:0 0 auto" />
          <input v-model="newRemoteUrl" class="git-input" placeholder="URL" />
          <button class="btn-ghost sm" :disabled="!newRemoteName.trim() || !newRemoteUrl.trim()" @click="doAddRemote">＋</button>
        </div>
        <p v-if="remotesMgrError" class="err-text">{{ remotesMgrError }}</p>
        </div>
      </div>

      <!-- ── TAGS ───────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="tagExpanded = !tagExpanded">
          <span class="sec-caret">{{ tagExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">Tags</span>
          <span v-if="gitTags.length" class="sec-badge">{{ gitTags.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="tagExpanded" class="card-body collapsible-body">
        <div v-if="!gitTags.length" class="empty-msg" style="padding:2px 0">No tags</div>
        <div v-for="t in gitTags" :key="t.name" class="generic-row">
          <span class="b-name">{{ t.name }}</span>
          <code class="chash" style="margin-left:4px">{{ t.commit_hash }}</code>
          <span v-if="t.message" class="b-track">{{ t.message }}</span>
          <div class="spacer" />
          <button class="row-btn always danger" @click.stop="doDeleteTag(t.name)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px; flex-wrap:wrap; gap:4px">
          <input v-model="newTagName" class="git-input" placeholder="v1.0.0" style="flex:1;min-width:72px" />
          <input v-model="newTagMessage" class="git-input" placeholder="Message" style="flex:2;min-width:80px" />
          <button class="btn-ghost sm" :disabled="!newTagName.trim()" @click="doCreateTag">＋</button>
        </div>
        <p v-if="tagError" class="err-text">{{ tagError }}</p>
        </div>
      </div>

      <!-- ── WORKTREES ──────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="worktreeExpanded = !worktreeExpanded">
          <span class="sec-caret">{{ worktreeExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">Worktrees</span>
          <span v-if="gitWorktrees.length > 1" class="sec-badge">{{ gitWorktrees.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="worktreeExpanded" class="card-body collapsible-body">
        <div v-for="wt in gitWorktrees" :key="wt.path" class="generic-row">
          <span class="wt-icon">{{ wt.is_main ? '✦' : '○' }}</span>
          <div style="flex:1;min-width:0">
            <div class="b-name" :title="wt.path">{{ wt.path.split('/').at(-1) }}</div>
            <div class="b-track">{{ wt.branch || 'detached HEAD' }} · {{ wt.head }}</div>
          </div>
          <button v-if="!wt.is_main" class="row-btn always danger" @click.stop="doRemoveWorktree(wt.path)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px; flex-direction:column; gap:4px">
          <div class="input-row">
            <input v-model="newWtPath" class="git-input" placeholder="/path/to/worktree" style="flex:2" />
            <button class="btn-ghost sm icon-only" title="瀏覽資料夾" @click="pickWorktreeDir">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
            </button>
            <input v-if="newWtIsNew" v-model="newWtBranch" class="git-input" placeholder="new branch" style="flex:1" />
            <select v-else v-model="newWtBranch" class="git-input" style="flex:1">
              <option value="" disabled>branch…</option>
              <option v-for="b in worktreeBranchOptions" :key="b" :value="b">{{ b }}</option>
            </select>
            <button class="btn-ghost sm" :disabled="!newWtPath.trim() || !newWtBranch.trim()" @click="doAddWorktree">＋</button>
          </div>
          <label class="check-label">
            <input v-model="newWtIsNew" type="checkbox" /> Create new branch
          </label>
        </div>
        <p v-if="worktreeError" class="err-text">{{ worktreeError }}</p>
        </div>
      </div>

      <!-- ── CONFIG ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="configExpanded = !configExpanded">
          <span class="sec-caret">{{ configExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">Config</span>
          <div class="spacer" />
        </div>
        <div v-if="configExpanded" class="card-body collapsible-body">
        <div v-for="key in configDisplayKeys" :key="key" class="config-row">
          <span class="config-key">{{ key }}</span>
          <template v-if="inlineEditKey === key">
            <select
              v-if="CONFIG_OPTIONS[key]"
              v-model="inlineEditValue"
              class="git-input config-inline-input"
            >
              <option value="" disabled>—</option>
              <option v-for="opt in CONFIG_OPTIONS[key]" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else
              v-model="inlineEditValue"
              class="git-input config-inline-input"
              autofocus
              @keydown.enter="saveInlineEdit"
              @keydown.esc="cancelInlineEdit"
            />
            <button class="btn-ghost sm" @click="saveInlineEdit">✓</button>
            <button class="btn-ghost sm" @click="cancelInlineEdit">✕</button>
          </template>
          <span v-else class="config-val clickable" @click="startInlineEdit(key)">{{ gitConfig[key] || '—' }}</span>
        </div>
        <p v-if="configError" class="err-text">{{ configError }}</p>
        </div>
      </div>

      </div><!-- /part-bottom -->

    </template>

    <!-- ── File context menu (right-click) ──────────────────────────────── -->
    <Teleport to="body">
      <div v-if="ctxMenu.show" class="tp-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <!-- File menu -->
      <div v-if="ctxMenu.show && ctxMenu.kind === 'file'" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpenChanges">Open Changes</button>
        <button class="menu-item" @click="ctxOpenFile">Open File</button>
        <button class="menu-item" @click="ctxOpenFileAtHead">Open File (HEAD)</button>
        <button class="menu-item" @click="ctxStashFile">Save File as Draft</button>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxStageToggle">{{ ctxMenu.staged ? 'Unstage Changes' : 'Stage Changes' }}</button>
        <button v-if="!ctxMenu.staged" class="menu-item danger" @click="ctxDiscard">Discard Changes</button>
        <div v-if="gitBranches.some(x=>!x.is_current)" class="menu-item has-sub danger">
          <span>Restore from branch</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button v-for="b in gitBranches.filter(x=>!x.is_current)" :key="b.name" class="menu-item" @click="ctxRestoreFromBranch(b.name)">{{ b.name }}</button>
          </div>
        </div>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxHistory">File History</button>
        <button class="menu-item" @click="ctxBlame">Blame</button>
        <div class="menu-sep" />
        <div class="menu-item has-sub">
          <span>Add to ignore</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button class="menu-item" @click="ctxAddToGitignore('project')">.gitignore（專案根目錄）</button>
            <button class="menu-item" @click="ctxAddToGitignore('nested')">.gitignore（所在資料夾）</button>
            <button class="menu-item" @click="ctxAddToGitignore('local')">.git/info/exclude（本機限定）</button>
            <button class="menu-item" @click="ctxAddToGitignore('global')">全域 .gitignore</button>
          </div>
        </div>
        <button v-if="ctxIsIgnored" class="menu-item" @click="ctxWhyIgnored">Why is this ignored?</button>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxReveal">Reveal in Finder</button>
        <button class="menu-item" @click="ctxCopyPath(false)">Copy Path</button>
        <button class="menu-item" @click="ctxCopyPath(true)">Copy Relative Path</button>
      </div>

      <!-- Folder menu (applies to all changed files under the folder) -->
      <div v-else-if="ctxMenu.show && ctxMenu.kind === 'folder'" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button v-if="ctxMenu.staged" class="menu-item" @click="ctxFolderUnstage">Unstage Changes</button>
        <template v-else>
          <button class="menu-item" @click="ctxFolderStage">Stage Changes</button>
          <button class="menu-item danger" @click="ctxFolderDiscard">Discard Changes</button>
          <div class="menu-sep" />
          <div class="menu-item has-sub">
            <span>Add to ignore</span><span class="sub-caret">▸</span>
            <div class="ctx-submenu">
              <button class="menu-item" @click="ctxFolderAddIgnore('project')">.gitignore（專案根目錄）</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('nested')">.gitignore（所在資料夾）</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('local')">.git/info/exclude（本機限定）</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('global')">全域 .gitignore</button>
            </div>
          </div>
        </template>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxFolderReveal">Reveal in Finder</button>
        <button class="menu-item" @click="ctxFolderCopyPath(false)">Copy Path</button>
        <button class="menu-item" @click="ctxFolderCopyPath(true)">Copy Relative Path</button>
      </div>

      <!-- Branch menu -->
      <div v-else-if="ctxMenu.show && ctxMenu.kind === 'branch'" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item danger" @click="ctxDeleteBranch">Delete Branch</button>
      </div>
    </Teleport>

    <!-- ── "Why is this ignored?" verdict ───────────────────────────────── -->
    <Teleport to="body">
      <div v-if="ignoreResult" class="tp-backdrop" @click="ignoreResult = null" />
      <div v-if="ignoreResult" class="ignore-modal" @click.stop>
        <div class="ignore-modal-path" :title="ignoreResult.path">{{ ignoreResult.path }}</div>
        <div class="ignore-modal-text">{{ ignoreResult.text }}</div>
        <button class="btn-ghost sm" @click="ignoreResult = null">關閉</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Tokens (GitHub dark) ───────────────────────────────────────────────────── */
.git-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #0d1117;
  color: #c9d1d9;
  font-size: 12px;
  user-select: none;
}
/* Independent scroll regions: top (commit + changes) and bottom (history/cards) */
.git-scroll { min-height: 0; overflow-y: auto; }
.part-top { flex-grow: 0; flex-shrink: 0; }
.part-bottom { flex: 1 1 0; padding-bottom: 20px; }
.spacer { flex: 1; }
.err-text { color: #f85149; font-size: 11px; margin: 0; padding: 2px 12px; }
.git-error-row { display: flex; align-items: flex-start; gap: 6px; }
.git-error-x {
  flex-shrink: 0; margin-left: auto; background: transparent; border: none;
  color: #f85149; cursor: pointer; font-size: 11px; line-height: 1; padding: 0 2px;
}
.git-error-x:hover { color: #ff7b72; }
.ok-text  { color: #3fb950; font-size: 11px; margin: 0; padding: 2px 4px; }
.loading-text { color: #6e7681; font-size: 10px; padding: 3px 8px; }
.empty-msg { color: #6e7681; font-size: 11px; font-style: italic; padding: 3px 20px 6px; }
.w-full { width: 100%; }
.spinner { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Empty state ─────────────────────────────────────────────────────────────── */
.empty-state {
  color: #6e7681; font-size: 11px; font-style: italic; padding: 16px 12px;
}

/* ── Init panel ─────────────────────────────────────────────────────────────── */
.init-panel {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 28px 20px; text-align: center;
}
.init-svg { opacity: 0.8; }
.init-title { font-size: 13px; font-weight: 600; color: #e6edf3; }
.init-desc { font-size: 11px; color: #8b949e; line-height: 1.6; }
.init-desc code { background: #161b22; padding: 1px 5px; border-radius: 3px; font-size: 10px; color: #79c0ff; }
.clone-box {
  width: 100%; margin-top: 14px; padding-top: 14px; border-top: 1px solid #21262d;
  display: flex; flex-direction: column; gap: 6px;
}
.clone-title { font-size: 11px; color: #8b949e; text-align: left; }
.clone-input {
  width: 100%; box-sizing: border-box; background: #0d1117; border: 1px solid #30363d;
  border-radius: 5px; color: #c9d1d9; font-size: 11px; padding: 5px 8px;
}
.clone-input:focus { outline: none; border-color: #1f6feb; }
.clone-dir-row { display: flex; gap: 6px; }
.clone-dir-row .clone-input { flex: 1; }
.clone-pick { flex-shrink: 0; font-size: 11px; }
/* In-progress operation banner */
.op-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: #3d1d00; border-bottom: 1px solid #d2902633;
  padding: 5px 10px; font-size: 11px;
}
.op-text { color: #e3b341; font-weight: 600; text-transform: capitalize; }
.op-abort-btn {
  background: #f8514922; color: #f85149; border: 1px solid #f85149;
  border-radius: 4px; font-size: 11px; padding: 2px 8px; cursor: pointer; text-transform: capitalize;
}
.op-abort-btn:hover { background: #f8514933; }
.op-err { color: #f85149; }
.btn-primary {
  background: #238636; color: #fff; border: 1px solid #2ea043;
  border-radius: 5px; font-size: 12px; padding: 5px 10px; cursor: pointer;
}
.btn-primary:hover { background: #2ea043; }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost {
  background: transparent; border: 1px solid #30363d; border-radius: 4px;
  color: #8b949e; font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.btn-ghost:hover { border-color: #6e7681; color: #c9d1d9; }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost.sm { font-size: 11px; padding: 3px 7px; }
.btn-ghost.icon-only { display: inline-flex; align-items: center; justify-content: center; padding: 4px 6px; flex: 0 0 auto; }
.btn-danger {
  background: #6e1111; border: 1px solid #8a2929; border-radius: 4px;
  color: #f4d2d2; font-size: 11px; padding: 4px 10px; cursor: pointer;
}
.btn-danger:hover { background: #8a2929; }

/* ── Panel header ───────────────────────────────────────────────────────────── */
.panel-header {
  display: flex; align-items: center; gap: 2px;
  padding: 1px 6px; border-bottom: 1px solid #21262d;
  min-height: 24px; flex-shrink: 0; z-index: 10;
  background: #0d1117;
}
.panel-title {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1px; color: #8b949e; padding: 0 4px;
}
.hdr-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: transparent; border: none;
  border-radius: 4px; color: #6e7681; cursor: pointer; font-size: 12px; padding: 0;
}
.hdr-btn:hover { color: #c9d1d9; background: rgba(177,186,196,0.1); }
.hdr-btn.active { color: #58a6ff; }
.hdr-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Dropdown menu ──────────────────────────────────────────────────────────── */
.menu-anchor { position: relative; }
.dropdown-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 100;
  background: #161b22; border: 1px solid #30363d; border-radius: 6px;
  padding: 4px; min-width: 170px; box-shadow: 0 8px 24px rgba(1,4,9,0.8);
}
.menu-group-label {
  font-size: 9px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.6px;
  padding: 4px 8px 2px;
}
.menu-item {
  display: flex; align-items: center; gap: 4px; width: 100%;
  background: transparent; border: none; color: #c9d1d9; font-size: 12px;
  padding: 5px 8px; border-radius: 4px; cursor: pointer; text-align: left;
}
.menu-item:hover { background: rgba(177,186,196,0.1); }
.menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.menu-check { width: 14px; text-align: center; font-size: 11px; color: #58a6ff; flex-shrink: 0; }
.menu-sep { height: 1px; background: #21262d; margin: 4px 0; }

/* ── Commit area ────────────────────────────────────────────────────────────── */
.commit-area {
  padding: 8px 8px 6px; border-bottom: 1px solid #21262d;
  display: flex; flex-direction: column; gap: 5px;
  position: sticky; top: 0; z-index: 6; background: #0d1117;
}
.commit-input-row { display: flex; gap: 5px; align-items: flex-start; }
.commit-input {
  flex: 1; resize: none; background: #161b22; border: 1px solid #30363d;
  border-radius: 5px; color: #e6edf3; font-size: 12px; padding: 6px 8px;
  font-family: inherit; line-height: 1.5;
  min-height: 30px; max-height: 160px; overflow-y: auto;
  box-sizing: border-box;
}
.commit-input:focus { outline: none; border-color: #388bfd; }
.commit-input::placeholder { color: #6e7681; }
.ai-btn {
  flex-shrink: 0; width: 26px; height: 26px; background: transparent;
  border: 1px solid #30363d; border-radius: 4px; color: #6e7681;
  font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.ai-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.ai-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ai-btn.generating { opacity: 1; color: #58a6ff; border-color: #58a6ff; cursor: progress; }
.ai-btn.generating .spinner { font-size: 15px; }
.commit-btn-row { display: flex; gap: 0; }
.commit-main-btn {
  flex: 1; background: #238636; color: #fff; border: 1px solid #2ea043;
  border-right: none; border-radius: 5px 0 0 5px; font-size: 12px; font-weight: 500;
  padding: 6px 10px; cursor: pointer; transition: background 0.12s;
}
.commit-main-btn:hover { background: #2ea043; }
.commit-main-btn:disabled { background: #161b22; border-color: #30363d; color: #6e7681; cursor: not-allowed; }
.commit-arrow-btn {
  background: #238636; color: #fff; border: 1px solid #2ea043; border-left: 1px solid #1a6b27;
  border-radius: 0 5px 5px 0; font-size: 11px; padding: 6px 8px; cursor: pointer;
}
.commit-arrow-btn:hover { background: #2ea043; }
.commit-arrow-btn:disabled { background: #161b22; border-color: #30363d; color: #6e7681; cursor: not-allowed; }

/* ── Section headers ────────────────────────────────────────────────────────── */
.sec-hdr {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; min-height: 22px;
}
.sec-hdr.clickable { cursor: pointer; user-select: none; }
.sec-hdr:hover { background: rgba(177,186,196,0.06); }
.sec-caret { font-size: 9px; color: #6e7681; width: 10px; flex-shrink: 0; }
.sec-label {
  font-size: 11px; font-weight: 600; color: #8b949e;
  letter-spacing: 0.3px;
}
.sec-badge {
  font-size: 10px; color: #8b949e; background: rgba(177,186,196,0.1);
  border-radius: 10px; padding: 0 6px; flex-shrink: 0;
}
.sec-actions { display: flex; align-items: center; gap: 1px; }
.sec-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; background: transparent; border: none;
  border-radius: 3px; color: #6e7681; cursor: pointer; font-size: 12px; padding: 0;
}
.sec-btn:hover { color: #c9d1d9; background: rgba(177,186,196,0.08); }
.sec-btn.danger:hover { color: #f85149; }
.sec-btn.always { opacity: 1; }

/* ── Section cards (History / Stashes / Remotes / Tags / Worktrees / Config) ─── */
.git-card {
  margin: 6px 8px;
  background: #0d1117;
  border: 1px solid #21262d;
  border-radius: 6px;
  overflow: hidden;
}
.card-hdr {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; min-height: 22px;
  background: #161b22;
}
.card-hdr.clickable { cursor: pointer; user-select: none; }
.card-hdr.clickable:hover { background: #1c2330; }
.git-card:has(.card-body) .card-hdr { border-bottom: 1px solid #21262d; }
.card-body { padding: 4px 2px 6px; }

/* ── File rows ──────────────────────────────────────────────────────────────── */
.file-group { padding-bottom: 2px; }

.file-row {
  display: flex; align-items: center; height: 22px;
  padding: 0 8px 0 16px; gap: 0; cursor: default; position: relative;
}
.file-row:hover { background: rgba(177,186,196,0.06); }
.row-conflict { background: rgba(248,81,73,0.05) !important; }

.file-status {
  flex-shrink: 0; width: 14px; text-align: center;
  font-size: 11px; font-weight: 700; margin-right: 5px; color: #56d364;
}
.unstaged-st { color: #e2c08d; }
[data-s="D"] { color: #f85149 !important; }
[data-s="U"] { color: #f85149 !important; }
[data-s="?"] { color: #56d364 !important; }

.file-name-only {
  font-size: 12px; color: #c9d1d9; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.file-name-only:hover { color: #e6edf3; }
.file-name-main {
  font-size: 12px; color: #c9d1d9; flex-shrink: 0; max-width: 55%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.file-name-main:hover { color: #e6edf3; }
.file-path-dim {
  flex: 1; font-size: 11px; color: #6e7681; padding-left: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}

.row-actions {
  display: none; align-items: center; gap: 1px; flex-shrink: 0; margin-left: 4px;
}
.file-row:hover .row-actions { display: flex; }
.row-actions.always { display: flex; }
.row-btn {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; background: transparent; border: none;
  border-radius: 3px; color: #8b949e; font-size: 11px; cursor: pointer; padding: 0 2px;
}
.row-btn:hover { color: #c9d1d9; background: rgba(177,186,196,0.1); }
.row-btn.danger:hover { color: #f85149; }
.row-btn.always { opacity: 1; }
/* Stage = primary action, emphasised and rightmost */
.row-btn.primary { color: #58a6ff; font-size: 13px; font-weight: 700; }
.row-btn.primary:hover { color: #fff; background: rgba(56,139,253,0.25); }
/* Discard = shrunk to avoid accidental clicks */
.row-btn.shrink { min-width: 14px; height: 14px; font-size: 8px; opacity: 0.5; padding: 0; }
.row-btn.shrink:hover { opacity: 1; }

/* ── Folder rows (tree mode) ────────────────────────────────────────────────── */
.folder-row {
  display: flex; align-items: center; height: 22px; gap: 4px;
  padding: 0 8px 0 16px; cursor: pointer;
}
.folder-row:hover { background: rgba(177,186,196,0.06); }
.folder-caret { font-size: 9px; color: #6e7681; width: 10px; flex-shrink: 0; }
.folder-icon { color: #c9d1d9; flex-shrink: 0; }
.folder-name {
  flex: 1; font-size: 11px; color: #8b949e;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.folder-count {
  font-size: 10px; color: #6e7681; background: rgba(177,186,196,0.08);
  border-radius: 8px; padding: 0 5px; flex-shrink: 0;
}

/* ── Subpanels (file history / blame) ──────────────────────────────────────── */
.subpanel {
  margin: 0 0 2px 30px; border-left: 2px solid #21262d;
  max-height: 130px; overflow-y: auto;
}
.blue-border   { border-left-color: #388bfd !important; }
.yellow-border { border-left-color: #d29922 !important; }
.green-border  { border-left-color: #3fb950 !important; }
.mini-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: 11px;
}
.mini-msg { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
/* Inline blame — VS Code style: each source line followed by its author/date */
.blame-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-x: auto; padding: 2px 0; }
/* Each row is only as wide as its content (no full-width stretch → no long trailing
   blank on short lines), full content kept, long lines scroll horizontally. */
.blame-line { display: flex; align-items: baseline; line-height: 1.55; width: max-content; }
.blame-ln { color: #6e7681; min-width: 34px; text-align: right; padding-right: 12px; flex-shrink: 0; user-select: none; }
.blame-content { color: #c9d1d9; white-space: pre; flex-shrink: 0; }
.blame-annot { color: #6e7681; font-style: italic; margin-left: 16px; white-space: nowrap; flex-shrink: 0; }

/* Inline diff-blame — only changed lines, each tagged with last author/date. */
.diffblame-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-x: auto; padding: 2px 0; }
.db-hunk-head { color: #79c0ff; font-size: 10px; opacity: 0.8; padding: 2px 8px; white-space: pre; }
.db-line { display: flex; align-items: baseline; line-height: 1.5; width: max-content; padding: 0 8px; }
.db-no { color: #6e7681; min-width: 30px; text-align: right; padding-right: 8px; flex-shrink: 0; user-select: none; }
.db-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.db-code { white-space: pre; flex-shrink: 0; }
.db-annot { color: #6e7681; font-style: italic; margin-left: 16px; white-space: nowrap; flex-shrink: 0; }
.db-line.db-add { background: rgba(63,185,80,0.12); }
.db-line.db-add .db-code, .db-line.db-add .db-sign { color: #56d364; }
.db-line.db-del { background: rgba(248,81,73,0.12); }
.db-line.db-del .db-code, .db-line.db-del .db-sign { color: #f85149; }
.db-line.db-ctx .db-code { color: #c9d1d9; }

/* ── Part divider ───────────────────────────────────────────────────────────── */
.part-resize {
  flex-shrink: 0; height: 7px; cursor: row-resize;
  display: flex; align-items: center; justify-content: center;
  background: #0d1117;
}
.part-resize-grip {
  height: 1px; width: 100%; background: #21262d;
  transition: background 0.12s, height 0.12s;
}
.part-resize:hover .part-resize-grip { height: 3px; background: #388bfd; }

/* ── Remote bar ─────────────────────────────────────────────────────────────── */
.remote-bar {
  display: flex; align-items: center; gap: 2px;
  padding: 4px 6px; min-height: 30px; border-bottom: 1px solid #21262d;
  position: sticky; top: 0; z-index: 5; background: #0d1117;
}
.branch-pill {
  display: flex; align-items: center; gap: 5px;
  background: transparent; border: none; color: #8b949e; font-size: 11px;
  cursor: pointer; padding: 2px 5px; border-radius: 4px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.branch-pill:hover, .branch-pill.active { color: #c9d1d9; background: rgba(177,186,196,0.08); }
.ab-text { font-size: 10px; color: #d29922; flex-shrink: 0; }
.remote-btn {
  display: flex; align-items: center; gap: 2px; background: transparent; border: none;
  color: #6e7681; font-size: 12px; cursor: pointer; padding: 3px 5px; border-radius: 4px;
  flex-shrink: 0; white-space: nowrap;
}
.remote-btn:hover { color: #c9d1d9; background: rgba(177,186,196,0.08); }
.remote-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.remote-btn.busy { opacity: 1; color: #58a6ff; cursor: progress; }
.publish-btn { color: #d29922; font-size: 10px; }
.ahead-num { font-size: 9px; color: #d29922; font-weight: 700; }

/* ── Remote output ──────────────────────────────────────────────────────────── */
.remote-output {
  margin: 4px 8px; background: #010409; border: 1px solid #21262d;
  border-radius: 5px; padding: 6px 28px 6px 8px; position: relative;
}
.remote-output pre { margin: 0; font-size: 10px; color: #c9d1d9; white-space: pre-wrap; max-height: 80px; overflow: auto; }
.err-pre { color: #f85149 !important; }
.close-btn {
  position: absolute; top: 4px; right: 6px; background: transparent;
  border: none; color: #6e7681; font-size: 10px; cursor: pointer;
}

/* ── Collapsible body (for inline sections) ─────────────────────────────────── */
.collapsible-body {
  padding: 4px 12px 8px; border-bottom: 1px solid #21262d;
  display: flex; flex-direction: column; gap: 2px;
}

/* ── Branch panel ───────────────────────────────────────────────────────────── */
.branch-row {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 0; font-size: 11px; border-radius: 3px;
}
.branch-row:hover { background: rgba(177,186,196,0.05); }
.branch-row.current .b-name { color: #79c0ff; font-weight: 600; }
.b-check { width: 14px; color: #56d364; font-size: 10px; text-align: center; flex-shrink: 0; }
.b-name { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.b-track { color: #6e7681; font-size: 10px; flex-shrink: 0; }
.compare-panel {
  margin: 4px 0; background: #010409; border: 1px solid #21262d;
  border-radius: 4px; padding: 6px 8px; font-size: 11px;
}
.compare-title { color: #79c0ff; font-weight: 600; margin-bottom: 3px; }
.compare-stat  { color: #56d364; margin-bottom: 2px; }
.compare-file  { color: #8b949e; font-family: monospace; font-size: 10px; }
.sub-label { font-size: 10px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.4px; }

/* ── History / commit graph ─────────────────────────────────────────────────── */
.history-search-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px 5px;
}
.search-input {
  flex: 1; background: transparent; border: none;
  border-bottom: 1px solid #30363d; color: #c9d1d9; font-size: 11px; padding: 2px 0;
}
.search-input:focus { outline: none; border-bottom-color: #388bfd; }
.search-input::placeholder { color: #6e7681; }
.history-scope-row {
  display: flex; gap: 4px; padding: 2px 12px 6px;
}
.scope-btn {
  flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 5px;
  color: #8b949e; font-size: 10px; padding: 3px 6px; cursor: pointer;
}
.scope-btn:hover:not(:disabled) { color: #e6edf3; border-color: #388bfd; }
.scope-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.scope-btn:disabled { opacity: 0.5; cursor: default; }
.commit-list { margin-bottom: 4px; }
.history-load-more { display: flex; justify-content: center; padding: 0 0 6px; }
.load-more-btn {
  background: #161b22; border: 1px solid #30363d; border-radius: 5px;
  color: #c9d1d9; font-size: 11px; padding: 3px 14px; cursor: pointer;
}
.load-more-btn:hover:not(:disabled) { border-color: #388bfd; color: #e6edf3; }
.load-more-btn:disabled { opacity: 0.5; cursor: default; }
.history-pagination {
  display: flex; align-items: center; justify-content: center;
  gap: 6px; padding: 4px 0 6px;
}
.history-pagination .pg-btn {
  background: #161b22; border: 1px solid #30363d; border-radius: 5px;
  color: #c9d1d9; font-size: 13px; line-height: 1; min-width: 26px;
  padding: 3px 8px; cursor: pointer;
}
.history-pagination .pg-btn:hover:not(:disabled) { border-color: #388bfd; color: #e6edf3; }
.history-pagination .pg-btn:disabled { opacity: 0.3; cursor: default; }
.history-pagination .pg-info { font-size: 11px; color: #8b949e; min-width: 40px; text-align: center; }
.commit-row {
  display: flex; align-items: flex-start; gap: 0;
  padding: 0 8px 0 0; cursor: pointer;
}
.commit-row:hover { background: rgba(177,186,196,0.05); }
.graph-col {
  position: relative; flex-shrink: 0; align-self: stretch; min-height: 28px;
}
.graph-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.graph-dot {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 8px; height: 8px; border-radius: 50%; background: #388bfd;
  border: 2px solid #0d1117; box-shadow: 0 0 0 1px currentColor;
}
.graph-dot.head { box-shadow: 0 0 0 1px #3fb950, 0 0 4px #3fb950; }
.commit-body { flex: 1; min-width: 0; padding: 3px 0; }
.commit-msg {
  font-size: 11px; color: #c9d1d9; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; line-height: 1.4;
}
.commit-meta {
  display: flex; align-items: center; gap: 3px; margin-top: 1px; flex-wrap: wrap;
}
.chash { font-size: 10px; color: #6e7681; font-family: monospace; background: transparent; }
.ref-pill {
  font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 999px; line-height: 1.5;
}
.ref-pill.local  { background: #1f3a5f; color: #79c0ff; }
.ref-pill.remote { background: #1f3a2f; color: #56d364; }
.commit-btns-right { display: flex; align-items: center; gap: 2px; padding: 3px 0; flex-shrink: 0; }
.expand-caret { font-size: 9px; color: #6e7681; padding: 0 2px; }

.commit-detail {
  margin: 0 8px 4px 24px; background: #0a0e14; border: 1px solid #21262d;
  border-radius: 4px; padding: 6px 10px; font-size: 11px;
}
.cd-row { display: flex; gap: 8px; margin-bottom: 3px; color: #c9d1d9; }
.cd-key { color: #6e7681; min-width: 46px; flex-shrink: 0; }
.cd-body { color: #8b949e; margin: 4px 0; white-space: pre-wrap; font-size: 10px; }
.cd-file { color: #c9d1d9; font-family: monospace; font-size: 10px; padding: 1px 0; }

/* ── Generic rows (stashes, remotes, tags) ──────────────────────────────────── */
.generic-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 0; font-size: 11px;
}
.generic-row:hover { background: rgba(177,186,196,0.04); }
.stash-ref { color: #6e7681; font-size: 10px; flex-shrink: 0; }
.stash-msg { color: #c9d1d9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remote-name { color: #6e7681; font-size: 10px; flex-shrink: 0; min-width: 44px; }
.remote-url  { color: #c9d1d9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.wt-icon { color: #56d364; font-size: 11px; flex-shrink: 0; width: 14px; text-align: center; }

/* ── Config ─────────────────────────────────────────────────────────────────── */
.config-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 11px; }
.config-key { color: #6e7681; min-width: 108px; flex-shrink: 0; font-family: monospace; font-size: 10px; }
.config-val { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-val.clickable { cursor: pointer; border-radius: 3px; padding: 1px 4px; margin: -1px -4px; }
.config-val.clickable:hover { background: #1c2330; color: #fff; }
.config-inline-input { flex: 1; min-width: 0; }

/* ── Clean confirm ──────────────────────────────────────────────────────────── */
.clean-box {
  margin: 4px 8px; background: #1a0a0a; border: 1px solid #f85149;
  border-radius: 4px; padding: 8px 10px; font-size: 11px;
}
.clean-title { color: #f85149; font-weight: 600; margin-bottom: 4px; }
.clean-file { color: #c9d1d9; padding: 1px 4px; font-family: monospace; font-size: 10px; }
.clean-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

.stash-box {
  margin: 4px 8px; background: #161b22; border: 1px solid #30363d;
  border-radius: 4px; padding: 8px 10px; font-size: 11px;
}
.stash-title { color: #c9d1d9; font-weight: 600; margin-bottom: 6px; }

/* ── Inputs ─────────────────────────────────────────────────────────────────── */
.git-input {
  flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 4px;
  color: #c9d1d9; font-size: 11px; padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: #388bfd; }
.input-row { display: flex; gap: 4px; }
.check-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8b949e; cursor: pointer; }
.check-label input { accent-color: #388bfd; cursor: pointer; }
</style>

<!-- Teleported dropdowns render at body level; must be non-scoped -->
<style>
.tp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
.tp-dropdown {
  position: fixed;
  z-index: 9999;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px;
  min-width: 170px;
  box-shadow: 0 8px 24px rgba(1, 4, 9, 0.85);
}
.tp-dropdown .menu-group-label {
  font-size: 9px;
  color: #6e7681;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 4px 8px 2px;
}
.tp-dropdown .menu-item {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  color: #c9d1d9;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.tp-dropdown .menu-item:hover { background: rgba(177, 186, 196, 0.1); }
.tp-dropdown .menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.tp-dropdown .menu-check {
  width: 14px;
  text-align: center;
  font-size: 11px;
  color: #58a6ff;
  flex-shrink: 0;
}
.tp-dropdown .menu-sep {
  height: 1px;
  background: #21262d;
  margin: 4px 0;
}

/* ── File context menu ─────────────────────────────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px;
  min-width: 200px;
  box-shadow: 0 8px 24px rgba(1, 4, 9, 0.85);
}
.ctx-menu .menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  background: transparent;
  border: none;
  color: #c9d1d9;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.ctx-menu .menu-item:hover { background: rgba(177, 186, 196, 0.1); }
.ctx-menu .menu-item.danger { color: #f85149; }
.ctx-menu .menu-item.danger:hover { background: rgba(248, 81, 73, 0.12); }
.ctx-menu .menu-sep {
  height: 1px;
  background: #21262d;
  margin: 4px 0;
}
/* Hover submenu (Add to ignore ▸) */
.ctx-menu .menu-item.has-sub { position: relative; justify-content: space-between; }
.ctx-menu .sub-caret { color: #6e7681; font-size: 10px; }
.ctx-menu .ctx-submenu {
  position: absolute; top: -5px; left: 100%; margin-left: 2px;
  display: none; min-width: 220px;
  background: #161b22; border: 1px solid #30363d; border-radius: 6px;
  padding: 4px; box-shadow: 0 8px 24px rgba(1, 4, 9, 0.85);
}
.ctx-menu .menu-item.has-sub:hover .ctx-submenu { display: block; }

/* Ignored file rows — dimmed */
.file-row.ignored-row { opacity: 0.55; }
.file-row.ignored-row .file-status { color: #6e7681; width: 14px; text-align: center; }

/* "Why is this ignored?" verdict modal */
.ignore-modal {
  position: fixed; z-index: 10000; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(420px, 80vw); background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 16px; box-shadow: 0 12px 32px rgba(1, 4, 9, 0.9);
  display: flex; flex-direction: column; gap: 10px;
}
.ignore-modal-path {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; color: #58a6ff;
  word-break: break-all;
}
.ignore-modal-text { font-size: 13px; color: #c9d1d9; line-height: 1.5; }
.ignore-modal .btn-ghost { align-self: flex-end; }
</style>
