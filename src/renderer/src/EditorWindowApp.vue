<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBackend } from './composables/useBackend'
import ExplorerPane from './components/ExplorerPane.vue'
import SearchPane from './components/SearchPane.vue'
import GitPane from './components/GitPane.vue'
import EditorPane from './editor/EditorPane.vue'
import DiffPane from './editor/DiffPane.vue'
import ConflictPane from './editor/ConflictPane.vue'
import NotificationHost from './components/NotificationHost.vue'
import AIChatPane from './components/AIChatPane.vue'
import { useKeybindings, registerCommand, setContext, executeCommand } from './keybindings/useKeybindings'
import { useTheme, BUILTIN_THEMES } from './composables/useTheme'
import { useNotify } from './composables/useNotify'

// ── window params (Electron appends ?window=editor&workspace_path=…&filepath=…) ──
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const initialRel = params.get('filepath') ?? ''
const initialName = params.get('name') ?? (initialRel.split('/').pop() || initialRel)
const initialLine = Number(params.get('line')) || 0
// diff pre-load: when opened via openDiffWindow with no existing editor window
const initialDiffFile = params.get('diff_filepath') ?? ''
const initialDiffStaged = params.get('diff_staged') === 'true'
const initialDiffName = params.get('diff_name') ?? (initialDiffFile.split('/').pop() || initialDiffFile)

const backend = useBackend()
const { confirm } = useNotify()

// ── Sidebar resize ────────────────────────────────────────────────────────────
const SIDEBAR_W_KEY = 'ide-sidebar-width'
const sidebarWidth = ref(Math.max(120, Math.min(500, parseInt(localStorage.getItem(SIDEBAR_W_KEY) ?? '260', 10))))
let resizing = false
function onResizeStart(): void {
  resizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
}
function onResizeMove(e: MouseEvent): void {
  if (!resizing) return
  sidebarWidth.value = Math.max(120, Math.min(500, e.clientX - 48))
}
function onResizeEnd(): void {
  if (!resizing) return
  resizing = false
  localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth.value))
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}

// ── AI Panel resize ───────────────────────────────────────────────────────────
const AI_PANEL_W_KEY = 'ide-ai-panel-width'
const aiPanelOpen = ref(false)
const aiPanelWidth = ref(Math.max(280, Math.min(600, parseInt(localStorage.getItem(AI_PANEL_W_KEY) ?? '320', 10))))
let aiResizing = false
function onAiResizeStart(): void {
  aiResizing = true
  document.addEventListener('mousemove', onAiResizeMove)
  document.addEventListener('mouseup', onAiResizeEnd)
}
function onAiResizeMove(e: MouseEvent): void {
  if (!aiResizing) return
  const newWidth = window.innerWidth - e.clientX
  aiPanelWidth.value = Math.max(280, Math.min(600, newWidth))
}
function onAiResizeEnd(): void {
  if (!aiResizing) return
  aiResizing = false
  localStorage.setItem(AI_PANEL_W_KEY, String(aiPanelWidth.value))
  document.removeEventListener('mousemove', onAiResizeMove)
  document.removeEventListener('mouseup', onAiResizeEnd)
}

// ── Open files (VS Code-style tabs); each EditorPane stays mounted (v-show) so
//    edits/undo survive tab switches. ──────────────────────────────────────────
// kind='diff': relPath is a synthetic key (\x00diff:<staged>:<filepath>), filepath/staged hold the real values.
// kind='conflict': relPath is a synthetic key (\x00conflict:<filepath>), filepath holds the real path.
interface OpenFile { kind: 'file' | 'diff' | 'conflict'; relPath: string; name: string; line: number; dirty: boolean; revealAt?: number; revealSeq: number; filepath?: string; staged?: boolean }
const openFiles = ref<OpenFile[]>([])
const activeRel = ref('')
const initialSidebar = (['explorer', 'search', 'git'] as const).find(
  (v) => v === params.get('sidebar'),
) ?? 'explorer'
const sidebarView = ref<'explorer' | 'search' | 'git'>(initialSidebar)
const sidebarHidden = ref(false)
const zenMode = ref(false)
const changesCount = ref(0)
const activePath = computed(() => {
  const f = openFiles.value.find((x) => x.relPath === activeRel.value)
  const displayPath = (f?.kind === 'diff' || f?.kind === 'conflict') ? (f.filepath ?? '') : activeRel.value
  return displayPath.split('/').filter(Boolean)
})

// ── Breadcrumb dropdown ───────────────────────────────────────────────────────
interface BcItem { name: string; isDir: boolean; relPath: string; line?: number; kind?: string }
interface BcDropdown { segIdx: number; items: BcItem[]; x: number; y: number }
const bcDropdown = ref<BcDropdown | null>(null)
const bcActiveIdx = ref(-1)

function _extractSymbols(text: string, ext: string): BcItem[] {
  const lines = text.split('\n')
  const out: BcItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    let m: RegExpMatchArray | null
    if ((m = raw.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
    else if ((m = raw.match(/^\s*(?:export\s+)?class\s+(\w+)/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'class' })
    else if ((m = raw.match(/^\s*(?:export\s+)?interface\s+(\w+)/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'interface' })
    else if ((m = raw.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'type' })
    else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
    else if (ext === 'py' && (m = raw.match(/^(\s*)def\s+(\w+)/)))
      out.push({ name: m[2], isDir: false, relPath: '', line: i + 1, kind: 'function' })
    else if (ext === 'py' && (m = raw.match(/^class\s+(\w+)/)))
      out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'class' })
  }
  return out
}

async function openBcDropdown(segIdx: number, e: MouseEvent): Promise<void> {
  e.stopPropagation()
  const rect = (e.target as HTMLElement).getBoundingClientRect()
  const isFile = segIdx === activePath.value.length - 1
  if (bcDropdown.value?.segIdx === segIdx) { bcDropdown.value = null; return }
  if (isFile) {
    const fileContent = activeEditor()?.getContent?.() ?? ''
    const ext = activePath.value[segIdx].split('.').pop() ?? ''
    const symbols = _extractSymbols(fileContent, ext)
    bcDropdown.value = { segIdx, items: symbols, x: rect.left, y: rect.bottom }
    bcActiveIdx.value = -1
  } else {
    const parentPath = activePath.value.slice(0, segIdx).join('/')
    interface LsResp { ok: boolean; entries?: Array<{ name: string; is_dir: boolean; rel_path: string }> }
    const resp = await backend.send<LsResp>('fs.list_dir', { workspace_path: workspacePath, rel_path: parentPath, show_hidden: false })
    const entries = resp.payload?.entries
    // Guard: if the user closed the dropdown (or opened another) while we waited, don't reopen.
    if (entries && bcDropdown.value === null) {
      bcDropdown.value = {
        segIdx,
        items: entries.map((en) => ({ name: en.name, isDir: en.is_dir, relPath: en.rel_path })),
        x: rect.left,
        y: rect.bottom,
      }
      bcActiveIdx.value = -1
    }
  }
}

function onBcItemClick(item: BcItem): void {
  bcDropdown.value = null
  if (item.line) {
    const f = openFiles.value.find((x) => x.relPath === activeRel.value)
    if (f) { f.revealAt = item.line; f.revealSeq = (f.revealSeq ?? 0) + 1 }
  } else if (!item.isDir && item.relPath) {
    openFile({ filepath: item.relPath })
  }
}

function closeBcDropdown(): void { bcDropdown.value = null; bcActiveIdx.value = -1 }

function onBcCaptureKeydown(e: KeyboardEvent): void {
  const dd = bcDropdown.value
  if (!dd) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.stopImmediatePropagation()
    e.preventDefault()
    const n = dd.items.length
    if (!n) return
    bcActiveIdx.value = e.key === 'ArrowDown'
      ? (bcActiveIdx.value + 1) % n
      : (bcActiveIdx.value - 1 + n) % n
  } else if (e.key === 'Enter') {
    e.stopImmediatePropagation()
    e.preventDefault()
    const item = dd.items[bcActiveIdx.value]
    if (item) onBcItemClick(item)
    else closeBcDropdown()
  } else if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    e.preventDefault()
    closeBcDropdown()
  }
}

function openFile(p: { filepath: string; name?: string; line?: number }): void {
  const relPath = p.filepath
  if (!relPath) return
  const name = p.name ?? (relPath.split('/').pop() || relPath)
  const existing = openFiles.value.find((f) => f.relPath === relPath)
  if (existing) {
    if (p.line && p.line > 0) {
      existing.revealAt = p.line
      existing.revealSeq = (existing.revealSeq ?? 0) + 1
    }
  } else {
    openFiles.value.push({ kind: 'file', relPath, name, line: p.line ?? 0, dirty: false, revealSeq: 0 })
  }
  activeRel.value = relPath
}

function openDiff(p: { filepath: string; staged: boolean; name?: string }): void {
  const tabKey = `\x00diff:${p.staged ? '1' : '0'}:${p.filepath}`
  const name = p.name ?? (p.filepath.split('/').pop() || p.filepath)
  if (!openFiles.value.find((f) => f.relPath === tabKey)) {
    openFiles.value.push({ kind: 'diff', relPath: tabKey, filepath: p.filepath, staged: p.staged, name, line: 0, dirty: false, revealSeq: 0 })
  }
  activeRel.value = tabKey
}

function openConflict(p: { filepath: string; name?: string }): void {
  const tabKey = `\x00conflict:${p.filepath}`
  const name = p.name ?? (p.filepath.split('/').pop() || p.filepath)
  if (!openFiles.value.find((f) => f.relPath === tabKey)) {
    openFiles.value.push({ kind: 'conflict', relPath: tabKey, filepath: p.filepath, name, line: 0, dirty: false, revealSeq: 0 })
  }
  activeRel.value = tabKey
}

const closedHistory: Array<{ relPath: string; name: string }> = []

async function closeFile(relPath: string): Promise<void> {
  const f = openFiles.value.find((x) => x.relPath === relPath)
  if (f?.dirty) {
    const ok = await confirm(`「${f.name}」有未存檔的變更，確定要關閉？`, {
      title: '關閉檔案', confirmText: '關閉',
    })
    if (!ok) return
  }
  const i = openFiles.value.findIndex((x) => x.relPath === relPath)
  if (i === -1) return
  if (f?.kind === 'file') closedHistory.push({ relPath: f.relPath, name: f.name })
  openFiles.value.splice(i, 1)
  if (activeRel.value === relPath) {
    activeRel.value = openFiles.value[Math.min(i, openFiles.value.length - 1)]?.relPath ?? ''
  }
}

// ── EditorPane ref tracking (for command delegation) ─────────────────────────
const editorPaneRefs = new Map<string, InstanceType<typeof EditorPane>>()
function setEditorRef(relPath: string, el: unknown): void {
  if (el) editorPaneRefs.set(relPath, el as InstanceType<typeof EditorPane>)
  else editorPaneRefs.delete(relPath)
}
function activeEditor(): InstanceType<typeof EditorPane> | undefined {
  return editorPaneRefs.get(activeRel.value)
}

// ── Keybinding system ─────────────────────────────────────────────────────────
useKeybindings()
registerCommand('editor.action.save',          () => activeEditor()?.save())
registerCommand('editor.action.inlineRewrite', () => activeEditor()?.openCmdK())
registerCommand('editor.action.triggerGhost',  () => activeEditor()?.requestGhost())
registerCommand('editor.action.openFind',      () => activeEditor()?.openFind())
registerCommand('editor.action.openReplace',   () => activeEditor()?.openReplace())
registerCommand('editor.action.nextMatch',     () => activeEditor()?.nextMatch())
registerCommand('editor.action.prevMatch',     () => activeEditor()?.prevMatch())
registerCommand('editor.action.gotoLine',      () => activeEditor()?.openGoto())
registerCommand('workbench.action.findInFiles', () => {
  sidebarHidden.value = false
  sidebarView.value = 'search'
  // If pane was already visible, the watcher on 'active' prop won't fire — focus explicitly.
  void nextTick(() => searchRef.value?.focusInput())
})
registerCommand('workbench.action.toggleSidebar', () => { sidebarHidden.value = !sidebarHidden.value })
registerCommand('workbench.action.toggleZenMode', () => {
  zenMode.value = !zenMode.value
  if (zenMode.value) sidebarHidden.value = true
})
registerCommand('workbench.action.focusExplorer', () => {
  sidebarHidden.value = false
  sidebarView.value = 'explorer'
  void nextTick(() => explorerRef.value?.focusTree())
})
registerCommand('workbench.action.focusSourceControl', () => { sidebarHidden.value = false; sidebarView.value = 'git' })
registerCommand('workbench.action.toggleAIChat', () => { aiPanelOpen.value = !aiPanelOpen.value })
function getActiveRelPath(): string { return activeRel.value }
registerCommand('editor.action.toggleComment',    () => activeEditor()?.toggleLineComment())
registerCommand('editor.action.deleteLines',      () => activeEditor()?.deleteLine())
registerCommand('editor.action.deleteWordLeft',   () => activeEditor()?.deleteWordLeft())
registerCommand('editor.action.deleteWordRight',  () => activeEditor()?.deleteWordRight())
registerCommand('editor.action.deleteAllLeft',    () => activeEditor()?.deleteLineLeft())
registerCommand('editor.action.deleteAllRight',   () => activeEditor()?.deleteLineRight())
registerCommand('editor.action.insertLineAfter',  () => activeEditor()?.insertLineBelow())
registerCommand('editor.action.insertLineBefore', () => activeEditor()?.insertLineAbove())
registerCommand('editor.action.moveLineUp',       () => activeEditor()?.moveLineUp())
registerCommand('editor.action.moveLineDown',     () => activeEditor()?.moveLineDown())
registerCommand('editor.action.selectHighlights',  () => activeEditor()?.selectAllOccurrences())
registerCommand('editor.action.jumpToBracket',     () => activeEditor()?.jumpToBracket())
registerCommand('editor.action.selectToBracket',   () => activeEditor()?.selectToBracket())
registerCommand('editor.action.duplicateLineDown',  () => activeEditor()?.duplicateLineDown())
registerCommand('editor.action.duplicateLineUp',    () => activeEditor()?.duplicateLineUp())
registerCommand('editor.action.indentLines',         () => activeEditor()?.indentLine())
registerCommand('editor.action.outdentLines',        () => activeEditor()?.dedentLine())
registerCommand('editor.action.cursorTop',            () => activeEditor()?.cursorTop())
registerCommand('editor.action.cursorBottom',         () => activeEditor()?.cursorBottom())
registerCommand('editor.action.scrollLineUp',         () => activeEditor()?.scrollLineUp())
registerCommand('editor.action.scrollLineDown',       () => activeEditor()?.scrollLineDown())
registerCommand('editor.action.transformToUppercase',  () => activeEditor()?.transformToUppercase())
registerCommand('editor.action.transformToLowercase',  () => activeEditor()?.transformToLowercase())
registerCommand('editor.action.transformToTitlecase',  () => activeEditor()?.transformToTitleCase())
registerCommand('editor.action.joinLines',               () => activeEditor()?.joinLines())
registerCommand('editor.action.sortLinesAscending',     () => activeEditor()?.sortLinesAscending())
registerCommand('editor.action.sortLinesDescending',    () => activeEditor()?.sortLinesDescending())
registerCommand('editor.action.navigateToLastEditLocation', () => activeEditor()?.navigateToLastEdit())
registerCommand('editor.action.trimTrailingWhitespace', () => activeEditor()?.trimTrailingWhitespace())
registerCommand('editor.action.formatDocument',         () => activeEditor()?.formatDocument())
registerCommand('editor.action.formatSelection',        () => activeEditor()?.formatSelection())
registerCommand('editor.action.smartSelect.expand',     () => activeEditor()?.expandSelection())
registerCommand('editor.action.smartSelect.shrink',     () => activeEditor()?.shrinkSelection())
registerCommand('workbench.action.copyFilePath', async () => {
  const path = activeRel.value
  if (!path) return
  await navigator.clipboard.writeText(`${workspacePath.replace(/\/+$/, '')}/${path}`)
})
registerCommand('workbench.action.copyRelativeFilePath', async () => {
  const path = activeRel.value
  if (!path) return
  await navigator.clipboard.writeText(path)
})
registerCommand('workbench.action.revealInExplorer', () => {
  sidebarHidden.value = false
  sidebarView.value = 'explorer'
  if (activeRel.value) void nextTick(() => explorerRef.value?.revealFile(activeRel.value))
})
registerCommand('workbench.action.revealFileInOS', async () => {
  if (!activeRel.value) return
  const absPath = `${workspacePath.replace(/\/+$/, '')}/${activeRel.value}`
  await window.agentTeam?.revealPath(absPath)
})
registerCommand('workbench.action.newWindow', async () => {
  await window.agentTeam?.openEditorWindow({ workspace_path: workspacePath })
})
registerCommand('workbench.action.openFolder', async () => {
  const path = await window.agentTeam?.pickWorkspace()
  if (path) await window.agentTeam?.openEditorWindow({ workspace_path: path })
})
registerCommand('workbench.action.reloadWindow', () => { window.location.reload() })
registerCommand('workbench.action.openFile', async () => {
  const result = await window.agentTeam?.pickFile({ title: '開啟檔案' })
  if (!result?.ok || !result.path) return
  const prefix = workspacePath.replace(/\/+$/, '') + '/'
  const relPath = result.path.startsWith(prefix) ? result.path.slice(prefix.length) : result.path
  openFile({ filepath: relPath })
})
registerCommand('workbench.action.openSettings', openKeyboardShortcuts)
registerCommand('editor.action.addSelectionToNextFindMatch',  () => activeEditor()?.selectNextOccurrence())
registerCommand('editor.action.moveSelectionToNextFindMatch', () => activeEditor()?.selectNextOccurrence())
registerCommand('editor.action.undo',      () => activeEditor()?.undo())
registerCommand('editor.action.redo',      () => activeEditor()?.redo())
registerCommand('editor.action.selectAll', () => activeEditor()?.selectAll())
for (let _i = 1; _i <= 9; _i++) {
  const idx = _i - 1
  registerCommand(`workbench.action.openEditorAtIndex${_i}`, () => {
    const f = openFiles.value[idx] ?? openFiles.value[openFiles.value.length - 1]
    if (f) activeRel.value = f.relPath
  })
}
registerCommand('workbench.action.closeActiveEditor', async () => {
  if (!activeRel.value) return
  await closeFile(activeRel.value)
})
registerCommand('workbench.action.saveAll', async () => {
  for (const [relPath, pane] of editorPaneRefs.entries()) {
    const f = openFiles.value.find((x) => x.relPath === relPath)
    if (f?.kind === 'file' && f.dirty) await pane.save()
  }
})
registerCommand('workbench.action.closeAllEditors', async () => {
  const dirty = openFiles.value.filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(`有 ${dirty.length} 個未存檔的檔案，確定要全部關閉？`, {
      title: '關閉所有分頁', confirmText: '全部關閉',
    })
    if (!ok) return
  }
  openFiles.value = []
  activeRel.value = ''
})
registerCommand('workbench.action.closeOtherEditors', async () => {
  const cur = activeRel.value
  if (!cur) return
  const others = openFiles.value.filter((f) => f.relPath !== cur && f.kind === 'file' && f.dirty)
  if (others.length > 0) {
    const ok = await confirm(`有 ${others.length} 個未存檔的檔案，確定要關閉其他分頁？`, {
      title: '關閉其他分頁', confirmText: '關閉',
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.filter((f) => f.relPath === cur)
})
registerCommand('workbench.action.closeEditorsToTheRight', async () => {
  const cur = activeRel.value
  if (!cur) return
  const idx = openFiles.value.findIndex((f) => f.relPath === cur)
  if (idx < 0) return
  const dirty = openFiles.value.slice(idx + 1).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(`有 ${dirty.length} 個未存檔的檔案，確定要關閉右側分頁？`, {
      title: '關閉右側分頁', confirmText: '關閉',
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.slice(0, idx + 1)
})
registerCommand('workbench.action.closeEditorsToTheLeft', async () => {
  const cur = activeRel.value
  if (!cur) return
  const idx = openFiles.value.findIndex((f) => f.relPath === cur)
  if (idx <= 0) return
  const dirty = openFiles.value.slice(0, idx).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(`有 ${dirty.length} 個未存檔的檔案，確定要關閉左側分頁？`, {
      title: '關閉左側分頁', confirmText: '關閉',
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.slice(idx)
})
registerCommand('workbench.action.openNextEditor', () => {
  const files = openFiles.value
  if (!files.length) return
  const idx = files.findIndex((f) => f.relPath === activeRel.value)
  activeRel.value = files[(idx + 1) % files.length]?.relPath ?? ''
})
registerCommand('workbench.action.openPreviousEditor', () => {
  const files = openFiles.value
  if (!files.length) return
  const idx = files.findIndex((f) => f.relPath === activeRel.value)
  activeRel.value = files[(idx - 1 + files.length) % files.length]?.relPath ?? ''
})
registerCommand('workbench.action.moveEditorRightInGroup', () => {
  const files = openFiles.value
  const idx = files.findIndex((f) => f.relPath === activeRel.value)
  if (idx < 0 || idx >= files.length - 1) return
  ;[files[idx], files[idx + 1]] = [files[idx + 1], files[idx]]
})
registerCommand('workbench.action.moveEditorLeftInGroup', () => {
  const files = openFiles.value
  const idx = files.findIndex((f) => f.relPath === activeRel.value)
  if (idx <= 0) return
  ;[files[idx], files[idx - 1]] = [files[idx - 1], files[idx]]
})

// ── Navigation history (⌃- / ⌃⇧-) ──────────────────────────────────────────
const _navHistory: string[] = []
let _navIdx = -1
let _navIgnore = false
watch(activeRel, (v) => {
  if (!v || _navIgnore) return
  if (_navIdx < _navHistory.length - 1) _navHistory.splice(_navIdx + 1)
  _navHistory.push(v)
  _navIdx = _navHistory.length - 1
})
registerCommand('workbench.action.navigateBack', () => {
  if (_navIdx <= 0) return
  _navIgnore = true
  activeRel.value = _navHistory[--_navIdx]
  void nextTick(() => { _navIgnore = false })
})
registerCommand('workbench.action.navigateForward', () => {
  if (_navIdx >= _navHistory.length - 1) return
  _navIgnore = true
  activeRel.value = _navHistory[++_navIdx]
  void nextTick(() => { _navIgnore = false })
})

watch(activeRel, (rel) => setContext('editorOpen', !!rel), { immediate: true })

// ── Explorer pane ref (for revealFile) ───────────────────────────────────────
const explorerRef = ref<{ revealFile: (path: string) => Promise<void>; focusTree: () => void } | null>(null)

// ── Search pane ref (for openReplace / focusInput) ───────────────────────────
const searchRef = ref<{ openReplace: () => void; focusInput: () => void } | null>(null)
registerCommand('workbench.action.findInFilesReplace', () => {
  sidebarHidden.value = false
  sidebarView.value = 'search'
  void nextTick(() => searchRef.value?.openReplace())
})
registerCommand('editor.action.selectLine',          () => activeEditor()?.selectLine())
registerCommand('editor.action.transpose',           () => activeEditor()?.transpose())
registerCommand('editor.action.indentationToSpaces', () => activeEditor()?.indentationToSpaces())
registerCommand('editor.action.indentationToTabs',   () => activeEditor()?.indentationToTabs())

// ── Tab bar: auto-scroll active tab into view ─────────────────────────────────
const tabsEl = ref<HTMLElement | null>(null)
watch(activeRel, async () => {
  await nextTick()
  tabsEl.value?.querySelector<HTMLElement>('.ide-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
})

// ── Command Palette ──────────────────────────────────────────────────────────
interface PaletteCmd { id: string; label: string; keys?: string }
const PALETTE_COMMANDS: PaletteCmd[] = [
  { id: 'editor.action.save',                     label: '儲存檔案',     keys: '⌘S' },
  { id: 'workbench.action.saveAll',               label: '全部儲存',     keys: '⌘⇧S' },
  { id: 'workbench.action.closeActiveEditor',     label: '關閉編輯器',   keys: '⌘W' },
  { id: 'editor.action.undo',      label: '復原',       keys: '⌘Z' },
  { id: 'editor.action.redo',      label: '重做',       keys: '⌘⇧Z' },
  { id: 'editor.action.selectAll', label: '全選',       keys: '⌘A' },
  { id: 'editor.action.openFind',  label: '尋找',       keys: '⌘F' },
  { id: 'editor.action.gotoLine',  label: '跳到行',     keys: '⌘L' },
  { id: 'editor.action.toggleComment',   label: '切換行註解',     keys: '⌘/' },
  { id: 'editor.action.deleteLines',     label: '刪除行',         keys: '⌘⇧K' },
  { id: 'editor.action.insertLineAfter', label: '在下方插入行',   keys: '⌘↵' },
  { id: 'editor.action.insertLineBefore',label: '在上方插入行',   keys: '⌘⇧↵' },
  { id: 'editor.action.moveLineUp',      label: '向上移動行',     keys: '⌥↑' },
  { id: 'editor.action.moveLineDown',    label: '向下移動行',     keys: '⌥↓' },
  { id: 'editor.action.selectHighlights',  label: '選取所有出現',   keys: '⌘⇧L' },
  { id: 'editor.action.jumpToBracket',     label: '跳到配對括號' },
  { id: 'editor.action.selectToBracket',  label: '選取到配對括號' },
  { id: 'editor.action.duplicateLineDown', label: '向下複製行',   keys: '⇧⌥↓' },
  { id: 'editor.action.duplicateLineUp',   label: '向上複製行',   keys: '⇧⌥↑' },
  { id: 'editor.action.indentLines',       label: '縮排行',        keys: '⌘]' },
  { id: 'editor.action.outdentLines',      label: '取消縮排行',    keys: '⌘[' },
  { id: 'editor.action.cursorTop',         label: '跳到檔案開頭',  keys: '⌘↑' },
  { id: 'editor.action.cursorBottom',      label: '跳到檔案結尾',  keys: '⌘↓' },
  { id: 'editor.action.scrollLineUp',      label: '向上捲動一行',  keys: '⌃↑' },
  { id: 'editor.action.scrollLineDown',    label: '向下捲動一行',  keys: '⌃↓' },
  { id: 'editor.action.addSelectionToNextFindMatch', label: '選取下一個出現', keys: '⌘D' },
  { id: 'editor.action.addLineComment',       label: '加入行注釋',       keys: '⌘K ⌘C' },
  { id: 'editor.action.removeLineComment',    label: '移除行注釋',       keys: '⌘K ⌘U' },
  { id: 'editor.action.blockComment',         label: '切換區塊注釋',     keys: '⌘⌥/' },
  { id: 'editor.action.transformToUppercase',  label: '轉換為大寫' },
  { id: 'editor.action.transformToLowercase',  label: '轉換為小寫' },
  { id: 'editor.action.transformToTitlecase',  label: '轉換為標題大小寫' },
  { id: 'editor.action.joinLines',              label: '合併行',         keys: '⌃J' },
  { id: 'editor.action.sortLinesAscending',    label: '行遞增排序' },
  { id: 'editor.action.sortLinesDescending',   label: '行遞減排序' },
  { id: 'editor.action.trimTrailingWhitespace', label: '移除行尾空白',   keys: '⌘K ⌘X' },
  { id: 'workbench.action.gotoSymbol',         label: '前往符號',     keys: '⌘⇧O' },
  { id: 'workbench.action.changeLanguageMode', label: '變更語言模式', keys: '⌘K ⌘M' },
  { id: 'editor.action.fontZoomIn',    label: '放大字體',     keys: '⌘=' },
  { id: 'editor.action.fontZoomOut',   label: '縮小字體',     keys: '⌘-' },
  { id: 'editor.action.fontZoomReset', label: '重設字體大小', keys: '⌘0' },
  { id: 'workbench.action.newFile',            label: '新增檔案',     keys: '⌘N' },
  { id: 'workbench.action.closeAllEditors', label: '關閉所有編輯器', keys: '⌘K ⌘W' },
  { id: 'editor.action.nextMatch',         label: '下一個符合項',  keys: '⌘G' },
  { id: 'editor.action.prevMatch',       label: '上一個符合項',   keys: '⌘⇧G' },
  { id: 'editor.action.inlineRewrite',   label: 'AI 改寫',        keys: '⌘K ⌘K' },
  { id: 'editor.action.triggerGhost',    label: 'AI 補全 (Cmd+I)',keys: '⌘I' },
  { id: 'workbench.action.toggleSidebar',label: '切換側邊欄',     keys: '⌘B' },
  { id: 'workbench.action.focusExplorer',label: '顯示檔案總管',   keys: '⌘⇧E' },
  { id: 'workbench.action.focusSourceControl', label: '顯示原始碼控制', keys: '⌘⇧G' },
  { id: 'workbench.action.focusActiveEditorGroup', label: '聚焦編輯器', keys: '⌘K ⌘E' },
  { id: 'workbench.action.findInFiles',  label: '在檔案中搜尋',   keys: '⌘⇧F' },
  { id: 'workbench.action.openNextEditor',      label: '切換下一分頁',   keys: '⌃Tab' },
  { id: 'workbench.action.openPreviousEditor',  label: '切換上一分頁',   keys: '⌃⇧Tab' },
  { id: 'workbench.action.quickOpen',             label: '快速開啟檔案',     keys: '⌘P' },
  { id: 'workbench.action.reopenClosedEditor',    label: '重開最後關閉的分頁', keys: '⌘⇧T' },
  { id: 'workbench.action.openKeyboardShortcuts', label: '顯示快捷鍵',       keys: '⌘K ⌘S' },
  { id: 'workbench.action.selectTheme',           label: '選擇顏色主題',     keys: '⌘K ⌘T' },
  { id: 'editor.action.openReplace',    label: '尋找並取代',       keys: '⌘H' },
  { id: 'editor.action.formatDocument', label: '格式化文件',       keys: '⌥⇧F' },
  { id: 'editor.action.formatSelection',label: '格式化選取範圍',   keys: '⌘K ⌘F' },
  { id: 'workbench.action.toggleAIChat',            label: '切換 AI 對話',    keys: '⌘⇧A' },
  { id: 'editor.action.smartSelect.expand',          label: '擴展選取範圍',   keys: '⇧⌥→' },
  { id: 'editor.action.smartSelect.shrink',          label: '縮小選取範圍',   keys: '⇧⌥←' },
  { id: 'workbench.action.copyFilePath',         label: '複製絕對路徑',      keys: '⌘K ⌘P' },
  { id: 'workbench.action.copyRelativeFilePath', label: '複製相對路徑' },
  { id: 'workbench.action.revealInExplorer',label: '在檔案總管中顯示', keys: '⌘K ⌘R' },
  { id: 'workbench.action.revealFileInOS',  label: '在 Finder 中顯示',  keys: '⇧⌥R' },
  { id: 'workbench.action.newWindow',       label: '新增編輯器視窗',    keys: '⌘⇧N' },
  { id: 'workbench.action.openEditorAtIndex1', label: '切換到第 1 個分頁', keys: '⌘1' },
  { id: 'workbench.action.openEditorAtIndex2', label: '切換到第 2 個分頁', keys: '⌘2' },
  { id: 'workbench.action.openEditorAtIndex3', label: '切換到第 3 個分頁', keys: '⌘3' },
  { id: 'editor.action.deleteWordLeft',              label: '刪除前一個字詞',   keys: '⌥⌫' },
  { id: 'editor.action.deleteWordRight',             label: '刪除後一個字詞',   keys: '⌥⌦' },
  { id: 'editor.action.deleteAllLeft',              label: '刪除到行首',       keys: '⌘⌫' },
  { id: 'editor.action.deleteAllRight',             label: '刪除到行尾',       keys: '⌘⌦' },
  { id: 'workbench.action.closeOtherEditors',       label: '關閉其他編輯器' },
  { id: 'workbench.action.closeEditorsToTheRight', label: '關閉右側的編輯器' },
  { id: 'workbench.action.closeEditorsToTheLeft',  label: '關閉左側的編輯器' },
  { id: 'workbench.action.moveEditorRightInGroup',  label: '將分頁向右移動',   keys: '⌘⇧]' },
  { id: 'workbench.action.moveEditorLeftInGroup',   label: '將分頁向左移動',   keys: '⌘⇧[' },
  { id: 'workbench.action.navigateBack',    label: '返回上一個位置', keys: '⌃-' },
  { id: 'workbench.action.navigateForward', label: '前往下一個位置', keys: '⌃⇧-' },
  { id: 'workbench.action.toggleZenMode',  label: '切換禪模式',    keys: '⌘K ⌘Z' },
  { id: 'workbench.action.openFolder',    label: '開啟資料夾',    keys: '⌘K ⌘O' },
  { id: 'workbench.action.reloadWindow',  label: '重新載入視窗' },
  { id: 'workbench.action.openFile',      label: '開啟檔案',     keys: '⌘O' },
  { id: 'workbench.action.openSettings',  label: '開啟設定',     keys: '⌘,' },
  { id: 'workbench.action.findInFilesReplace', label: '在檔案中取代', keys: '⌘⇧H' },
  { id: 'editor.action.transpose',           label: '轉置字元',     keys: '⌃T' },
  { id: 'editor.action.selectLine',          label: '選取目前行',     keys: '⌃L' },
  { id: 'editor.action.indentationToSpaces', label: '縮排轉換為空格' },
  { id: 'editor.action.indentationToTabs',   label: '縮排轉換為 Tab' },
  { id: 'editor.action.navigateToLastEditLocation', label: '跳到最後編輯位置', keys: '⌘K ⌘Q' },
  { id: 'editor.action.moveSelectionToNextFindMatch', label: '移動選取到下一個符合', keys: '⌘K ⌘D' },
  { id: 'workbench.action.copyRelativeFilePath', label: '複製相對路徑', keys: '⌘⇧⌥C' },
]
const paletteOpen = ref(false)
const paletteQuery = ref('')
const paletteIdx = ref(0)
const paletteInputEl = ref<HTMLInputElement | null>(null)
const filteredCmds = computed(() => {
  const q = paletteQuery.value.toLowerCase()
  return q
    ? PALETTE_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    : PALETTE_COMMANDS
})
function openPalette(): void {
  paletteOpen.value = true
  paletteQuery.value = ''
  paletteIdx.value = 0
  void nextTick(() => paletteInputEl.value?.focus())
}
function closePalette(): void { paletteOpen.value = false }
function runPaletteCmd(id: string | undefined): void {
  if (!id) return
  closePalette()
  void Promise.resolve().then(() => executeCommand(id))
}
function onPaletteKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closePalette() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx.value = (paletteIdx.value + 1) % Math.max(1, filteredCmds.value.length) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx.value = (paletteIdx.value - 1 + filteredCmds.value.length) % Math.max(1, filteredCmds.value.length) }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteCmd(filteredCmds.value[paletteIdx.value]?.id) }
}
watch(paletteQuery, () => { paletteIdx.value = 0 })
registerCommand('workbench.action.showCommands', openPalette)

// ── Quick Open (⌘P) ─────────────────────────────────────────────────────────
type QoFileItem   = { qoKind: 'file';   name: string; relPath: string }
type QoLineItem   = { qoKind: 'line';   line: number }
type QoSymbolItem = { qoKind: 'symbol'; name: string; line: number; kind: string }
type QoItem = QoFileItem | QoLineItem | QoSymbolItem

const qoOpen = ref(false)
const qoQuery = ref('')
const qoIdx = ref(0)
const qoInputEl = ref<HTMLInputElement | null>(null)
const qoPlaceholder = computed(() => {
  const q = qoQuery.value
  if (q.startsWith(':')) return '輸入行號跳轉… (例: :42)'
  if (q.startsWith('@')) return '輸入符號名稱… (例: @myFunction)'
  return '搜尋開放的檔案… (:行號  @符號)'
})
const qoItems = computed((): QoItem[] => {
  const q = qoQuery.value
  // :N → jump to line in current file
  if (q.startsWith(':')) {
    const n = parseInt(q.slice(1).trim(), 10)
    if (!isNaN(n) && n > 0) return [{ qoKind: 'line', line: n }]
    return []
  }
  // @name → filter symbols from active file
  if (q.startsWith('@')) {
    const symQ = q.slice(1).toLowerCase()
    const f = openFiles.value.find((f) => f.relPath === activeRel.value)
    if (!f || f.kind !== 'file') return []
    const content = activeEditor()?.getContent?.() ?? ''
    const ext = f.name.split('.').pop() ?? ''
    const all = _extractSymbols(content, ext)
    const filtered = symQ ? all.filter((s) => s.name.toLowerCase().includes(symQ)) : all
    return filtered.map((s): QoSymbolItem => ({ qoKind: 'symbol', name: s.name, line: s.line ?? 1, kind: s.kind ?? '' }))
  }
  // default: filter open files
  const ql = q.toLowerCase()
  const files = openFiles.value.filter((f) => f.kind === 'file')
  const matching = ql ? files.filter((f) => f.name.toLowerCase().includes(ql) || f.relPath.toLowerCase().includes(ql)) : files
  return matching.map((f): QoFileItem => ({ qoKind: 'file', name: f.name, relPath: f.relPath }))
})
function openQuickOpen(): void {
  qoQuery.value = ''
  qoIdx.value = 0
  qoOpen.value = true
  void nextTick(() => qoInputEl.value?.focus())
}
function closeQuickOpen(): void { qoOpen.value = false }
function confirmQuickOpen(): void {
  const item = qoItems.value[qoIdx.value]
  if (!item) { closeQuickOpen(); return }
  if (item.qoKind === 'file') { activeRel.value = item.relPath }
  else if (item.qoKind === 'line') { activeEditor()?.jumpToLine(item.line) }
  else if (item.qoKind === 'symbol') { activeEditor()?.jumpToLine(item.line) }
  closeQuickOpen()
}
function qoItemKey(item: QoItem, i: number): string {
  if (item.qoKind === 'file') return item.relPath
  if (item.qoKind === 'line') return `line:${item.line}`
  return `sym:${i}:${item.name}`
}
function onQoKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeQuickOpen(); return }
  if (e.key === 'Enter') { e.preventDefault(); confirmQuickOpen(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); qoIdx.value = Math.min(qoIdx.value + 1, qoItems.value.length - 1); return }
  if (e.key === 'ArrowUp') { e.preventDefault(); qoIdx.value = Math.max(0, qoIdx.value - 1); return }
}
watch(qoQuery, (q) => {
  qoIdx.value = 0
  // VS Code: typing '>' in Quick Open switches to command palette mode
  if (q.startsWith('>')) {
    const cmd = q.slice(1).trimStart()
    closeQuickOpen()
    openPalette()
    paletteQuery.value = cmd
  }
})
registerCommand('workbench.action.quickOpen', openQuickOpen)
registerCommand('workbench.action.focusActiveEditorGroup', () => { activeEditor()?.focus?.() })
registerCommand('workbench.action.reopenClosedEditor', () => {
  const last = closedHistory.pop()
  if (last) openFile({ filepath: last.relPath, name: last.name })
})

// ── Line comment ─────────────────────────────────────────────────────────────
registerCommand('editor.action.addLineComment',    () => activeEditor()?.addLineComment())
registerCommand('editor.action.removeLineComment', () => activeEditor()?.removeLineComment())
registerCommand('editor.action.blockComment',      () => activeEditor()?.toggleBlockComment())

// ── Font zoom (⌘=/⌘-/⌘0) ─────────────────────────────────────────────────────
registerCommand('editor.action.fontZoomIn',    () => activeEditor()?.zoomIn())
registerCommand('editor.action.fontZoomOut',   () => activeEditor()?.zoomOut())
registerCommand('editor.action.fontZoomReset', () => activeEditor()?.zoomReset())

// ── Go to Symbol (⌘⇧O) ──────────────────────────────────────────────────────
const symOpen = ref(false)
const symQuery = ref('')
const symIdx = ref(0)
const symInputEl = ref<HTMLInputElement | null>(null)
const symItems = computed(() => {
  if (!symOpen.value) return []
  const f = openFiles.value.find((f) => f.relPath === activeRel.value)
  if (!f || f.kind !== 'file') return []
  const content = activeEditor()?.getContent?.() ?? ''
  const ext = f.name.split('.').pop() ?? ''
  const all = _extractSymbols(content, ext)
  const q = symQuery.value.toLowerCase()
  return q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all
})
function openGotoSymbol(): void {
  symOpen.value = true
  symQuery.value = ''
  symIdx.value = 0
  void nextTick(() => symInputEl.value?.focus())
}
function closeGotoSymbol(): void { symOpen.value = false }
function confirmGotoSymbol(): void {
  const item = symItems.value[symIdx.value]
  if (item?.line != null) activeEditor()?.jumpToLine(item.line)
  closeGotoSymbol()
}
function onSymKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeGotoSymbol() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmGotoSymbol() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); symIdx.value = Math.min(symIdx.value + 1, symItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); symIdx.value = Math.max(0, symIdx.value - 1) }
}
watch(symQuery, () => { symIdx.value = 0 })
registerCommand('workbench.action.gotoSymbol', openGotoSymbol)

// ── Language mode picker (⌘K ⌘M) ────────────────────────────────────────────
interface LangOption { ext: string; label: string }
const LANGUAGES: LangOption[] = [
  { ext: 'ts', label: 'TypeScript' }, { ext: 'tsx', label: 'TypeScript JSX' },
  { ext: 'js', label: 'JavaScript' }, { ext: 'jsx', label: 'JavaScript JSX' },
  { ext: 'vue', label: 'Vue' }, { ext: 'py', label: 'Python' },
  { ext: 'json', label: 'JSON' }, { ext: 'md', label: 'Markdown' },
  { ext: 'html', label: 'HTML' }, { ext: 'css', label: 'CSS' },
  { ext: 'scss', label: 'SCSS' }, { ext: 'sh', label: 'Shell' },
  { ext: 'go', label: 'Go' }, { ext: 'rs', label: 'Rust' },
  { ext: 'java', label: 'Java' }, { ext: 'kt', label: 'Kotlin' },
  { ext: 'swift', label: 'Swift' }, { ext: 'cpp', label: 'C++' },
  { ext: 'c', label: 'C' }, { ext: 'yaml', label: 'YAML' },
  { ext: 'toml', label: 'TOML' }, { ext: 'sql', label: 'SQL' },
  { ext: '', label: 'Plain Text' },
]
const langOpen = ref(false)
const langQuery = ref('')
const langIdx = ref(0)
const langInputEl = ref<HTMLInputElement | null>(null)
const langItems = computed(() => {
  const q = langQuery.value.toLowerCase()
  return q ? LANGUAGES.filter((l) => l.label.toLowerCase().includes(q) || l.ext.includes(q)) : LANGUAGES
})
function openLangPicker(): void {
  langOpen.value = true
  langQuery.value = ''
  langIdx.value = 0
  void nextTick(() => langInputEl.value?.focus())
}
function closeLangPicker(): void { langOpen.value = false }
function confirmLangPicker(): void {
  const item = langItems.value[langIdx.value]
  if (item) activeEditor()?.setLanguage(item.ext)
  closeLangPicker()
}
function onLangKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeLangPicker() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmLangPicker() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); langIdx.value = Math.min(langIdx.value + 1, langItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); langIdx.value = Math.max(0, langIdx.value - 1) }
}
watch(langQuery, () => { langIdx.value = 0 })
registerCommand('workbench.action.changeLanguageMode', openLangPicker)

// ── Keyboard shortcuts reference (⌘K ⌘S) ─────────────────────────────────────
const kbOpen = ref(false)
const kbQuery = ref('')
const kbInputEl = ref<HTMLInputElement | null>(null)
const kbItems = computed(() => {
  const q = kbQuery.value.toLowerCase()
  return q
    ? PALETTE_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || (c.keys ?? '').toLowerCase().includes(q))
    : PALETTE_COMMANDS
})
function openKeyboardShortcuts(): void {
  kbOpen.value = true; kbQuery.value = ''
  void nextTick(() => kbInputEl.value?.focus())
}
function closeKeyboardShortcuts(): void { kbOpen.value = false }
function onKbKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeKeyboardShortcuts() }
}
registerCommand('workbench.action.openKeyboardShortcuts', openKeyboardShortcuts)

// ── Color theme picker (⌘K ⌘T) ───────────────────────────────────────────────
const { theme: currentTheme, setTheme } = useTheme()
const themeOpen = ref(false)
const themeQuery = ref('')
const themeIdx = ref(0)
const themeInputEl = ref<HTMLInputElement | null>(null)
let _themeBeforeOpen = ''
const themeItems = computed(() => {
  const q = themeQuery.value.toLowerCase()
  return q ? BUILTIN_THEMES.filter((t) => t.label.toLowerCase().includes(q)) : BUILTIN_THEMES
})
function openThemePicker(): void {
  _themeBeforeOpen = currentTheme.value
  themeOpen.value = true
  themeQuery.value = ''
  themeIdx.value = BUILTIN_THEMES.findIndex((t) => t.id === currentTheme.value)
  if (themeIdx.value < 0) themeIdx.value = 0
  void nextTick(() => themeInputEl.value?.focus())
}
function closeThemePicker(restoreOriginal = true): void {
  if (restoreOriginal) setTheme(_themeBeforeOpen)
  themeOpen.value = false
}
function confirmThemePicker(): void {
  const item = themeItems.value[themeIdx.value]
  if (item) setTheme(item.id)
  themeOpen.value = false
}
function previewTheme(idx: number): void {
  themeIdx.value = idx
  const item = themeItems.value[idx]
  if (item) setTheme(item.id)
}
function onThemeKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeThemePicker(true) }
  else if (e.key === 'Enter') { e.preventDefault(); confirmThemePicker() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); previewTheme(Math.min(themeIdx.value + 1, themeItems.value.length - 1)) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); previewTheme(Math.max(0, themeIdx.value - 1)) }
}
watch(themeQuery, () => { themeIdx.value = 0 })
registerCommand('workbench.action.selectTheme', openThemePicker)

// ── Modal context (any overlay open) → Escape can close via keybinding ────────
const anyOverlayOpen = computed(() => paletteOpen.value || qoOpen.value || symOpen.value || langOpen.value || kbOpen.value || themeOpen.value)
watch(anyOverlayOpen, (v) => setContext('modalOpen', v))

// ── Close modal (Escape when any overlay is open) ────────────────────────────
registerCommand('workbench.action.closeModal', () => {
  if (paletteOpen.value) { closePalette(); return }
  if (qoOpen.value) { closeQuickOpen(); return }
  if (symOpen.value) { closeGotoSymbol(); return }
  if (langOpen.value) { closeLangPicker(); return }
  if (kbOpen.value) { closeKeyboardShortcuts(); return }
  if (themeOpen.value) { closeThemePicker(true); return }
})

// ── New file (⌘N) ─────────────────────────────────────────────────────────────
registerCommand('workbench.action.newFile', async () => {
  if (!workspacePath) return
  const name = window.prompt('新檔案路徑（相對工作區）：', 'untitled.txt')
  if (!name?.trim()) return
  const relPath = name.trim()
  const resp = await backend.send('fs.write_file', { workspace_path: workspacePath, rel_path: relPath, content: '' })
  if (resp.ok) openFile({ filepath: relPath })
})

function onAppKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && bcDropdown.value) { bcDropdown.value = null; return }
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'w' || e.key === 'W') && activeRel.value) {
    // Don't close the tab while focus is in a find/goto/cmdk text input.
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT') return
    e.preventDefault()
    closeFile(activeRel.value)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onAppKeydown)
  window.addEventListener('keydown', onBcCaptureKeydown, { capture: true })
  document.addEventListener('click', closeBcDropdown)
  const api = (window as Window & {
    agentTeam?: {
      onSwitchEditorSidebar?: (cb: (s: string) => void) => void
      onOpenEditorDiff?: (cb: (params: Record<string, string>) => void) => void
    }
  }).agentTeam
  api?.onSwitchEditorSidebar?.((sidebar) => {
    if (sidebar === 'explorer' || sidebar === 'search' || sidebar === 'git') {
      sidebarView.value = sidebar
    }
  })
  api?.onOpenEditorDiff?.((params) => {
    openDiff({
      filepath: params.filepath ?? '',
      staged: params.staged === 'true',
      name: params.name,
    })
  })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onAppKeydown)
  window.removeEventListener('keydown', onBcCaptureKeydown, { capture: true })
  document.removeEventListener('click', closeBcDropdown)
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  document.removeEventListener('mousemove', onAiResizeMove)
  document.removeEventListener('mouseup', onAiResizeEnd)
})

function markDirty(relPath: string, v: boolean): void {
  const f = openFiles.value.find((x) => x.relPath === relPath)
  if (f) f.dirty = v
}

// Host owns the window title — tracks the active file (+ dirty marker).
watch(
  [activeRel, openFiles],
  () => {
    const f = openFiles.value.find((x) => x.relPath === activeRel.value)
    document.title = f ? `${f.dirty ? '● ' : ''}${f.name} — Editor` : 'Editor'
  },
  { deep: true, immediate: true },
)

if (workspacePath && initialRel) openFile({ filepath: initialRel, name: initialName, line: initialLine })
if (workspacePath && initialDiffFile) openDiff({ filepath: initialDiffFile, staged: initialDiffStaged, name: initialDiffName })
</script>

<template>
  <div class="ide">
    <!-- Activity bar -->
    <div v-show="!zenMode" class="ide-activity">
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'explorer' }"
        title="Explorer"
        @click="sidebarView = 'explorer'"
      >
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'search' }"
        title="Search"
        @click="sidebarView = 'search'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'git' }"
        title="Source Control"
        @click="sidebarView = 'git'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/></svg>
        <span v-if="changesCount" class="ide-act-badge">{{ changesCount > 99 ? '99+' : changesCount }}</span>
      </button>
    </div>

    <!-- Sidebar -->
    <div v-show="!sidebarHidden" class="ide-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <ExplorerPane
        ref="explorerRef"
        v-show="sidebarView === 'explorer'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
      />
      <SearchPane
        ref="searchRef"
        v-show="sidebarView === 'search'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        :active="sidebarView === 'search'"
        @open-file="openFile"
      />
      <GitPane
        v-show="sidebarView === 'git'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
        @open-conflict="openConflict"
        @changes-count="changesCount = $event"
      />
    </div>
    <div v-show="!sidebarHidden" class="ide-resize-handle" @mousedown.prevent="onResizeStart" />

    <!-- Editor area -->
    <div class="ide-main">
      <div v-if="openFiles.length && !zenMode" ref="tabsEl" class="ide-tabs">
        <div
          v-for="f in openFiles"
          :key="f.relPath"
          class="ide-tab"
          :class="{ active: f.relPath === activeRel }"
          :title="(f.kind === 'diff' || f.kind === 'conflict') ? f.filepath : f.relPath"
          @click="activeRel = f.relPath"
        >
          <span v-if="f.kind === 'diff'" class="ide-tab-diff-badge" :class="f.staged ? 'staged' : 'unstaged'">{{ f.staged ? 'S' : 'U' }}</span>
          <span v-else-if="f.kind === 'conflict'" class="ide-tab-diff-badge conflict-badge">!</span>
          <span class="ide-tab-name">{{ f.name }}</span>
          <span v-if="f.dirty" class="ide-tab-dirty" title="未存檔">●</span>
          <button class="ide-tab-close" title="關閉" @click.stop="closeFile(f.relPath)">✕</button>
        </div>
      </div>

      <!-- Breadcrumb -->
      <div v-if="activeRel" class="ide-breadcrumb">
        <template v-for="(seg, i) in activePath" :key="i">
          <span v-if="i > 0" class="ide-bc-sep">›</span>
          <span
            class="ide-bc-seg"
            :class="{ 'ide-bc-file': i === activePath.length - 1, 'ide-bc-seg--open': bcDropdown?.segIdx === i }"
            @click.stop="openBcDropdown(i, $event)"
          >{{ seg }}</span>
        </template>
      </div>

      <div class="ide-editors">
        <template v-for="f in openFiles" :key="f.relPath">
          <EditorPane
            v-if="f.kind === 'file'"
            v-show="f.relPath === activeRel"
            :ref="(el) => setEditorRef(f.relPath, el)"
            :workspace-path="workspacePath"
            :backend="backend"
            :rel-path="f.relPath"
            :name="f.name"
            :initial-line="f.line"
            :reveal-at="f.revealAt"
            :reveal-seq="f.revealSeq"
            embedded
            :active="f.relPath === activeRel"
            @dirty="(v) => markDirty(f.relPath, v)"
          />
          <DiffPane
            v-else-if="f.kind === 'diff'"
            v-show="f.relPath === activeRel"
            :workspace-path="workspacePath"
            :filepath="f.filepath!"
            :staged="f.staged!"
            :name="f.name"
            :backend="backend"
            @open-file="openFile"
          />
          <ConflictPane
            v-else-if="f.kind === 'conflict'"
            v-show="f.relPath === activeRel"
            :workspace-path="workspacePath"
            :filepath="f.filepath!"
            :name="f.name"
            :backend="backend"
            @resolved="closeFile(f.relPath)"
          />
        </template>
        <div v-if="!openFiles.length" class="ide-empty">
          從左側 Explorer 或 Search 開啟檔案
        </div>
      </div>
    </div>

    <!-- Right activity bar (AI Chat toggle) -->
    <div class="ide-right-act">
      <button
        class="ide-right-act-btn"
        :class="{ active: aiPanelOpen }"
        title="AI Chat (⌘⇧A)"
        @click="aiPanelOpen = !aiPanelOpen"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
        </svg>
      </button>
    </div>

    <!-- AI Chat Panel (right) -->
    <div v-show="aiPanelOpen" class="ide-ai-resize-handle" @mousedown.prevent="onAiResizeStart" />
    <div v-show="aiPanelOpen" class="ide-ai-panel" :style="{ width: aiPanelWidth + 'px' }">
      <AIChatPane
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        :active="aiPanelOpen"
        :get-editor-content="() => activeEditor()?.getContent?.() ?? ''"
        :get-editor-selection="() => activeEditor()?.getSelection?.() ?? ''"
        :get-active-rel-path="getActiveRelPath"
        :insert-text-at-cursor="(text: string) => activeEditor()?.insertTextAtCursor?.(text)"
      />
    </div>
  </div>
  <!-- Color Theme Picker -->
  <div v-if="themeOpen" class="ide-palette-overlay" @mousedown.self="closeThemePicker(true)">
    <div class="ide-palette">
      <input
        ref="themeInputEl"
        v-model="themeQuery"
        class="ide-palette-input"
        placeholder="選擇顏色主題…"
        @keydown="onThemeKeydown"
      />
      <ul class="ide-palette-list">
        <li
          v-for="(t, i) in themeItems"
          :key="t.id"
          class="ide-palette-item"
          :class="{ active: i === themeIdx }"
          @mouseover="previewTheme(i)"
          @click="confirmThemePicker"
        >
          <span class="ide-palette-label">{{ t.label }}</span>
          <span v-if="t.id === currentTheme" class="ide-palette-key">目前</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Keyboard Shortcuts Reference -->
  <div v-if="kbOpen" class="ide-palette-overlay" @mousedown.self="closeKeyboardShortcuts">
    <div class="ide-palette ide-palette--wide">
      <input
        ref="kbInputEl"
        v-model="kbQuery"
        class="ide-palette-input"
        placeholder="搜尋快捷鍵…"
        @keydown="onKbKeydown"
      />
      <ul class="ide-palette-list">
        <li v-for="c in kbItems" :key="c.id" class="ide-palette-item ide-palette-item--static">
          <span class="ide-palette-label">{{ c.label }}</span>
          <span v-if="c.keys" class="ide-palette-key">{{ c.keys }}</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Language Mode Picker -->
  <div v-if="langOpen" class="ide-palette-overlay" @mousedown.self="closeLangPicker">
    <div class="ide-palette">
      <input
        ref="langInputEl"
        v-model="langQuery"
        class="ide-palette-input"
        placeholder="選擇語言模式…"
        @keydown="onLangKeydown"
      />
      <ul class="ide-palette-list">
        <li
          v-for="(l, i) in langItems"
          :key="l.ext + l.label"
          class="ide-palette-item"
          :class="{ active: i === langIdx }"
          @mouseover="langIdx = i"
          @click="confirmLangPicker"
        >
          <span class="ide-palette-label">{{ l.label }}</span>
          <span v-if="l.ext" class="ide-palette-key">{{ l.ext }}</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Go to Symbol -->
  <div v-if="symOpen" class="ide-palette-overlay" @mousedown.self="closeGotoSymbol">
    <div class="ide-palette">
      <input
        ref="symInputEl"
        v-model="symQuery"
        class="ide-palette-input"
        placeholder="前往符號…"
        @keydown="onSymKeydown"
      />
      <ul v-if="symItems.length" class="ide-palette-list">
        <li
          v-for="(s, i) in symItems"
          :key="s.name + s.line"
          class="ide-palette-item"
          :class="{ active: i === symIdx }"
          @mouseover="symIdx = i"
          @click="confirmGotoSymbol"
        >
          <span class="ide-palette-label">{{ s.name }}</span>
          <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ s.kind }} · 第 {{ s.line }} 行</span>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">目前檔案沒有偵測到符號</div>
    </div>
  </div>
  <div v-if="qoOpen" class="ide-palette-overlay" @mousedown.self="closeQuickOpen">
    <div class="ide-palette">
      <input
        ref="qoInputEl"
        v-model="qoQuery"
        class="ide-palette-input"
        :placeholder="qoPlaceholder"
        @keydown="onQoKeydown"
      />
      <ul v-if="qoItems.length" class="ide-palette-list">
        <li
          v-for="(item, i) in qoItems"
          :key="qoItemKey(item, i)"
          class="ide-palette-item"
          :class="{ active: i === qoIdx }"
          @mouseover="qoIdx = i"
          @click="confirmQuickOpen"
        >
          <template v-if="item.qoKind === 'file'">
            <span class="ide-palette-label">{{ item.name }}</span>
            <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ item.relPath }}</span>
          </template>
          <template v-else-if="item.qoKind === 'line'">
            <span class="ide-palette-label">跳到第 {{ item.line }} 行</span>
          </template>
          <template v-else-if="item.qoKind === 'symbol'">
            <span class="ide-palette-label">{{ item.name }}</span>
            <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ item.kind }} · 第 {{ item.line }} 行</span>
          </template>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">
        <template v-if="qoQuery.startsWith(':')">輸入有效行號</template>
        <template v-else-if="qoQuery.startsWith('@')">目前檔案沒有偵測到符號</template>
        <template v-else>無開放的檔案</template>
      </div>
    </div>
  </div>
  <div v-if="paletteOpen" class="ide-palette-overlay" @mousedown.self="closePalette">
    <div class="ide-palette">
      <input
        ref="paletteInputEl"
        v-model="paletteQuery"
        class="ide-palette-input"
        placeholder="輸入指令名稱…"
        @keydown="onPaletteKeydown"
      />
      <ul v-if="filteredCmds.length" class="ide-palette-list">
        <li
          v-for="(cmd, i) in filteredCmds"
          :key="cmd.id"
          class="ide-palette-item"
          :class="{ active: i === paletteIdx }"
          @mouseover="paletteIdx = i"
          @click="runPaletteCmd(cmd.id)"
        >
          <span class="ide-palette-label">{{ cmd.label }}</span>
          <span v-if="cmd.keys" class="ide-palette-key">{{ cmd.keys }}</span>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">無符合指令</div>
    </div>
  </div>
  <NotificationHost />

  <!-- Breadcrumb dropdown -->
  <teleport to="body">
    <div
      v-if="bcDropdown"
      class="ide-bc-dd"
      :style="{ left: bcDropdown.x + 'px', top: bcDropdown.y + 'px' }"
      @click.stop
    >
      <div v-if="!bcDropdown.items.length" class="ide-bc-dd-empty">（空）</div>
      <div
        v-for="(item, i) in bcDropdown.items"
        :key="(item.relPath || '') + (item.line ?? 0)"
        class="ide-bc-dd-item"
        :class="{ 'is-dir': item.isDir, 'is-sym': !!item.line, 'is-active': i === bcActiveIdx }"
        @mouseover="bcActiveIdx = i"
        @click="onBcItemClick(item)"
      >
        <span class="ide-bc-dd-icon">
          <svg v-if="item.isDir" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
          <svg v-else-if="!item.line" width="12" height="14" viewBox="0 0 12 16" fill="currentColor"><path d="M6 5H2V4h4v1zM2 8h7V7H2v1zm0 2h7V9H2v1zm0 2h7v-1H2v1zm10-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5z"/></svg>
          <span v-else class="ide-bc-dd-sym-badge" :data-kind="item.kind">{{ item.kind === 'function' ? 'ƒ' : item.kind === 'class' ? 'C' : item.kind === 'interface' ? 'I' : item.kind === 'type' ? 'T' : '·' }}</span>
        </span>
        <span class="ide-bc-dd-name">{{ item.name }}</span>
        <span v-if="item.line" class="ide-bc-dd-line">L{{ item.line }}</span>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.ide {
  display: flex;
  height: 100vh;
  background: var(--bg-base);
  color: var(--text-primary);
  overflow: hidden;
}
.ide-activity {
  flex-shrink: 0;
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 8px;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
}
.ide-act-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 0;
}
.ide-act-btn:hover { color: var(--text-bright); }
.ide-act-btn.active { color: var(--text-bright); border-left-color: var(--accent-emphasis); }
.ide-act-btn { position: relative; }
.ide-act-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 9px;
  line-height: 15px;
  text-align: center;
}

.ide-sidebar {
  flex-shrink: 0;
  min-width: 120px;
  max-width: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ide-resize-handle {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  border-right: 1px solid var(--border-muted);
  transition: background 0.15s;
}
.ide-resize-handle:hover { background: var(--accent-emphasis); }
.ide-sidebar > * { flex: 1; min-height: 0; }

.ide-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ide-tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: none;
}
.ide-tabs::-webkit-scrollbar { display: none; }
.ide-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border-right: 1px solid var(--border-muted);
  cursor: pointer;
  white-space: nowrap;
  border-top: 2px solid transparent;
}
.ide-tab:hover { background: var(--bg-muted); }
.ide-tab.active {
  background: var(--bg-base);
  color: var(--text-bright);
  border-top-color: var(--accent-emphasis);
}
.ide-tab-dirty { color: var(--attention-fg); font-size: 10px; }
.ide-tab-diff-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.ide-tab-diff-badge.staged { background: #1f3a2f; color: #56d364; }
.ide-tab-diff-badge.unstaged { background: #3a2f1f; color: #e3b341; }
.ide-tab-diff-badge.conflict-badge { background: #3a1f1f; color: #f85149; }
.ide-tab-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px;
  border-radius: 3px;
}
.ide-tab-close:hover { background: var(--bg-muted); color: var(--text-bright); }

.ide-breadcrumb {
  display: flex;
  align-items: center;
  padding: 2px 12px;
  height: 22px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  font-size: 11.5px;
  flex-shrink: 0;
  gap: 4px;
  overflow: hidden;
}
.ide-bc-sep { color: var(--text-muted); opacity: 0.6; font-size: 10px; }
.ide-bc-seg {
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 4px;
  margin: 0 -4px;
}
.ide-bc-seg:hover { color: var(--text-primary); background: var(--bg-muted); }
.ide-bc-seg--open { color: var(--text-primary) !important; background: var(--bg-muted) !important; }
.ide-bc-file { color: var(--text-primary); font-weight: 500; }

/* ── Breadcrumb Dropdown ─────────────────────────────────────────────────── */
.ide-bc-dd {
  position: fixed;
  z-index: 300;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  min-width: 180px;
  max-width: 300px;
  max-height: 320px;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  padding: 4px 0;
  font-size: 12px;
}
.ide-bc-dd-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}
.ide-bc-dd-item:hover, .ide-bc-dd-item.is-active { background: var(--bg-muted); }
.ide-bc-dd-item.is-dir { color: var(--accent-fg); }
.ide-bc-dd-icon { flex-shrink: 0; display: flex; align-items: center; width: 16px; }
.ide-bc-dd-sym-badge {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.ide-bc-dd-sym-badge[data-kind="class"] { background: #6c9ef8; }
.ide-bc-dd-sym-badge[data-kind="interface"] { background: #56b6c2; }
.ide-bc-dd-sym-badge[data-kind="type"] { background: #c678dd; }
.ide-bc-dd-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.ide-bc-dd-line { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.ide-bc-dd-empty { padding: 8px 10px; color: var(--text-muted); font-size: 11.5px; }

.ide-editors { flex: 1; position: relative; min-height: 0; }
.ide-editors > * { height: 100%; }
.ide-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}

/* ── Command Palette ─────────────────────────────────────────────────────── */
.ide-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  padding-top: 72px;
}
.ide-palette {
  width: 520px;
  max-height: 420px;
}
.ide-palette--wide {
  width: 640px;
  max-height: 560px;
  display: flex;
  flex-direction: column;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  align-self: flex-start;
}
.ide-palette-input {
  padding: 11px 14px;
  font-size: 13px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-primary);
  outline: none;
}
.ide-palette-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
}
.ide-palette-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 12.5px;
}
.ide-palette-item.active { background: var(--bg-muted); }
.ide-palette-label { color: var(--text-primary); }
.ide-palette-key {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: ui-monospace, Menlo, monospace;
  flex-shrink: 0;
}
.ide-palette-empty { padding: 12px 14px; color: var(--text-muted); font-size: 12px; }

.ide-right-act {
  flex-shrink: 0;
  width: 36px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 0;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  gap: 2px;
}
.ide-right-act-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-right: 2px solid transparent;
  border-radius: 0;
}
.ide-right-act-btn:hover { color: var(--text-bright); }
.ide-right-act-btn.active { color: var(--accent-fg); border-right-color: var(--accent-emphasis); }

.ide-ai-resize-handle {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  border-left: 1px solid var(--border-muted);
  transition: background 0.15s;
}
.ide-ai-resize-handle:hover { background: var(--accent-emphasis); }
.ide-ai-panel {
  flex-shrink: 0;
  min-width: 280px;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--border-muted);
}
</style>
