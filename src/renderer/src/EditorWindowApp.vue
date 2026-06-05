<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBackend } from './composables/useBackend'
import ExplorerPane from './components/ExplorerPane.vue'
import SearchPane from './components/SearchPane.vue'
import GitPane from './components/GitPane.vue'
import EditorPane from './editor/EditorPane.vue'
import DiffPane from './editor/DiffPane.vue'
import NotificationHost from './components/NotificationHost.vue'
import { useKeybindings, registerCommand, setContext, executeCommand } from './keybindings/useKeybindings'

// ── window params (Electron appends ?window=editor&workspace_path=…&filepath=…) ──
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const initialRel = params.get('filepath') ?? ''
const initialName = params.get('name') ?? (initialRel.split('/').pop() || initialRel)
const initialLine = Number(params.get('line')) || 0

const backend = useBackend()

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

// ── Open files (VS Code-style tabs); each EditorPane stays mounted (v-show) so
//    edits/undo survive tab switches. ──────────────────────────────────────────
// kind='diff': relPath is a synthetic key (\x00diff:<staged>:<filepath>), filepath/staged hold the real values.
interface OpenFile { kind: 'file' | 'diff'; relPath: string; name: string; line: number; dirty: boolean; revealAt?: number; revealSeq: number; filepath?: string; staged?: boolean }
const openFiles = ref<OpenFile[]>([])
const activeRel = ref('')
const initialSidebar = (['explorer', 'search', 'git'] as const).find(
  (v) => v === params.get('sidebar'),
) ?? 'explorer'
const sidebarView = ref<'explorer' | 'search' | 'git'>(initialSidebar)
const sidebarHidden = ref(false)
const changesCount = ref(0)
const activePath = computed(() => {
  const f = openFiles.value.find((x) => x.relPath === activeRel.value)
  const displayPath = f?.kind === 'diff' ? (f.filepath ?? '') : activeRel.value
  return displayPath.split('/').filter(Boolean)
})

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

function closeFile(relPath: string): void {
  const f = openFiles.value.find((x) => x.relPath === relPath)
  if (f?.dirty && !window.confirm(`「${f.name}」有未存檔的變更，確定要關閉？`)) return
  const i = openFiles.value.findIndex((x) => x.relPath === relPath)
  if (i === -1) return
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
registerCommand('editor.action.nextMatch',     () => activeEditor()?.nextMatch())
registerCommand('editor.action.prevMatch',     () => activeEditor()?.prevMatch())
registerCommand('editor.action.gotoLine',      () => activeEditor()?.openGoto())
registerCommand('workbench.action.findInFiles', () => { sidebarHidden.value = false; sidebarView.value = 'search' })
registerCommand('workbench.action.toggleSidebar', () => { sidebarHidden.value = !sidebarHidden.value })
registerCommand('workbench.action.focusExplorer', () => { sidebarHidden.value = false; sidebarView.value = 'explorer' })
registerCommand('workbench.action.focusSourceControl', () => { sidebarHidden.value = false; sidebarView.value = 'git' })
registerCommand('editor.action.toggleComment',    () => activeEditor()?.toggleLineComment())
registerCommand('editor.action.deleteLines',      () => activeEditor()?.deleteLine())
registerCommand('editor.action.insertLineAfter',  () => activeEditor()?.insertLineBelow())
registerCommand('editor.action.insertLineBefore', () => activeEditor()?.insertLineAbove())
registerCommand('editor.action.moveLineUp',       () => activeEditor()?.moveLineUp())
registerCommand('editor.action.moveLineDown',     () => activeEditor()?.moveLineDown())
registerCommand('editor.action.selectHighlights',  () => activeEditor()?.selectAllOccurrences())
registerCommand('editor.action.jumpToBracket',     () => activeEditor()?.jumpToBracket())
registerCommand('editor.action.duplicateLineDown',  () => activeEditor()?.duplicateLineDown())
registerCommand('editor.action.duplicateLineUp',    () => activeEditor()?.duplicateLineUp())
registerCommand('editor.action.indentLines',         () => activeEditor()?.indentLine())
registerCommand('editor.action.outdentLines',        () => activeEditor()?.dedentLine())
registerCommand('editor.action.cursorTop',           () => activeEditor()?.cursorTop())
registerCommand('editor.action.cursorBottom',        () => activeEditor()?.cursorBottom())
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

watch(activeRel, (rel) => setContext('editorOpen', !!rel), { immediate: true })

// ── Tab bar: auto-scroll active tab into view ─────────────────────────────────
const tabsEl = ref<HTMLElement | null>(null)
watch(activeRel, async () => {
  await nextTick()
  tabsEl.value?.querySelector<HTMLElement>('.ide-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
})

// ── Command Palette ──────────────────────────────────────────────────────────
interface PaletteCmd { id: string; label: string; keys?: string }
const PALETTE_COMMANDS: PaletteCmd[] = [
  { id: 'editor.action.save',           label: '儲存檔案',       keys: '⌘S' },
  { id: 'editor.action.openFind',        label: '尋找',           keys: '⌘F' },
  { id: 'editor.action.gotoLine',        label: '跳到行',         keys: '⌘L' },
  { id: 'editor.action.toggleComment',   label: '切換行註解',     keys: '⌘/' },
  { id: 'editor.action.deleteLines',     label: '刪除行',         keys: '⌘⇧K' },
  { id: 'editor.action.insertLineAfter', label: '在下方插入行',   keys: '⌘↵' },
  { id: 'editor.action.insertLineBefore',label: '在上方插入行',   keys: '⌘⇧↵' },
  { id: 'editor.action.moveLineUp',      label: '向上移動行',     keys: '⌥↑' },
  { id: 'editor.action.moveLineDown',    label: '向下移動行',     keys: '⌥↓' },
  { id: 'editor.action.selectHighlights',  label: '選取所有出現',   keys: '⌘⇧L' },
  { id: 'editor.action.jumpToBracket',     label: '跳到配對括號' },
  { id: 'editor.action.duplicateLineDown', label: '向下複製行',   keys: '⇧⌥↓' },
  { id: 'editor.action.duplicateLineUp',   label: '向上複製行',   keys: '⇧⌥↑' },
  { id: 'editor.action.indentLines',       label: '縮排行',        keys: '⌘]' },
  { id: 'editor.action.outdentLines',      label: '取消縮排行',    keys: '⌘[' },
  { id: 'editor.action.cursorTop',         label: '跳到檔案開頭',  keys: '⌘↑' },
  { id: 'editor.action.cursorBottom',      label: '跳到檔案結尾',  keys: '⌘↓' },
  { id: 'editor.action.nextMatch',         label: '下一個符合項',  keys: '⌘G' },
  { id: 'editor.action.prevMatch',       label: '上一個符合項',   keys: '⌘⇧G' },
  { id: 'editor.action.inlineRewrite',   label: 'AI 改寫 (Cmd+K)',keys: '⌘K' },
  { id: 'editor.action.triggerGhost',    label: 'AI 補全 (Cmd+I)',keys: '⌘I' },
  { id: 'workbench.action.toggleSidebar',label: '切換側邊欄',     keys: '⌘B' },
  { id: 'workbench.action.focusExplorer',label: '顯示檔案總管',   keys: '⌘⇧E' },
  { id: 'workbench.action.focusSourceControl', label: '顯示原始碼控制', keys: '⌘⇧G' },
  { id: 'workbench.action.findInFiles',  label: '在檔案中搜尋',   keys: '⌘⇧F' },
  { id: 'workbench.action.openNextEditor',     label: '切換下一分頁', keys: '⌃Tab' },
  { id: 'workbench.action.openPreviousEditor', label: '切換上一分頁', keys: '⌃⇧Tab' },
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

function onAppKeydown(e: KeyboardEvent): void {
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
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
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
</script>

<template>
  <div class="ide">
    <!-- Activity bar -->
    <div class="ide-activity">
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
        v-show="sidebarView === 'explorer'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
      />
      <SearchPane
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
        @changes-count="changesCount = $event"
      />
    </div>
    <div v-show="!sidebarHidden" class="ide-resize-handle" @mousedown.prevent="onResizeStart" />

    <!-- Editor area -->
    <div class="ide-main">
      <div v-if="openFiles.length" ref="tabsEl" class="ide-tabs">
        <div
          v-for="f in openFiles"
          :key="f.relPath"
          class="ide-tab"
          :class="{ active: f.relPath === activeRel }"
          :title="f.kind === 'diff' ? f.filepath : f.relPath"
          @click="activeRel = f.relPath"
        >
          <span v-if="f.kind === 'diff'" class="ide-tab-diff-badge" :class="f.staged ? 'staged' : 'unstaged'">{{ f.staged ? 'S' : 'U' }}</span>
          <span class="ide-tab-name">{{ f.name }}</span>
          <span v-if="f.dirty" class="ide-tab-dirty" title="未存檔">●</span>
          <button class="ide-tab-close" title="關閉" @click.stop="closeFile(f.relPath)">✕</button>
        </div>
      </div>

      <!-- Breadcrumb -->
      <div v-if="activeRel" class="ide-breadcrumb">
        <template v-for="(seg, i) in activePath" :key="i">
          <span v-if="i > 0" class="ide-bc-sep">›</span>
          <span class="ide-bc-seg" :class="{ 'ide-bc-file': i === activePath.length - 1 }">{{ seg }}</span>
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
          />
        </template>
        <div v-if="!openFiles.length" class="ide-empty">
          從左側 Explorer 或 Search 開啟檔案
        </div>
      </div>
    </div>
  </div>
  <!-- Command Palette -->
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
.ide-bc-seg { color: var(--text-secondary); white-space: nowrap; }
.ide-bc-file { color: var(--text-primary); font-weight: 500; }

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
</style>
