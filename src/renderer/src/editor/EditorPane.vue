<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useNotify } from '../composables/useNotify'
import { setContext } from '../keybindings/useKeybindings'
import EditorView from './view/EditorView.vue'
import type { Range, Position } from './types'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  relPath: string
  name: string
  initialLine?: number
  // Inside the IDE shell the file name is shown by the host tab strip, so the
  // editor hides its own name chip and keeps only the action buttons.
  embedded?: boolean
  // Multiple EditorPanes stay mounted (v-show) in the IDE; only the active one
  // should respond to global keyboard shortcuts. Defaults true for standalone use.
  active?: boolean
  // When an already-open file needs to navigate to a new line (e.g. search result),
  // the host bumps revealSeq so the watch fires even when revealAt is unchanged.
  revealAt?: number
  revealSeq?: number
}>()

const emit = defineEmits<{
  (e: 'dirty', value: boolean): void
}>()

const { toast, alert } = useNotify()

const content = ref('')
const dirty = ref(false)
watch(dirty, (v) => emit('dirty', v))
// Navigate to a specific line when the host signals a new target (e.g. search results
// clicking an already-open file). revealSeq ensures the watch fires even when revealAt
// is the same line number as before.
watch([() => props.revealAt, () => props.revealSeq] as const, ([line]) => {
  if (line && line > 0) editorRef.value?.revealLine(line)
})
const loadError = ref('')
const loaded = ref(false)
const editorRef = ref<InstanceType<typeof EditorView> | null>(null)

const model = 'llama3.2' // analyzer's default; rewrite/complete proxy to local LLM
const langOverride = ref<string | null>(null)
const lang = computed(() => langOverride.value ?? (props.name.split('.').pop() ?? ''))

const LANG_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', jsx: 'JavaScript JSX',
  vue: 'Vue', py: 'Python', json: 'JSON', md: 'Markdown', html: 'HTML',
  css: 'CSS', scss: 'SCSS', sh: 'Shell', go: 'Go', rs: 'Rust', rb: 'Ruby',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C', yaml: 'YAML',
  toml: 'TOML', xml: 'XML', sql: 'SQL',
}
const langDisplay = computed(() => LANG_MAP[lang.value] ?? (lang.value ? lang.value.toUpperCase() : 'Text'))

// ── Status bar cursor position ─────────────────────────────────────────────────
const cursorLine = ref(1)
const cursorCol = ref(1)
const selectionInfo = ref('')
function onCursorChange(pos: Position): void {
  cursorLine.value = pos.line + 1
  cursorCol.value = pos.col + 1
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) {
    const lineCount = sel.split('\n').length
    selectionInfo.value = lineCount > 1 ? `${lineCount} 行已選` : `${sel.length} 字元已選`
  } else {
    selectionInfo.value = ''
  }
}

interface FsRead { ok: boolean; content?: string; error?: string }
interface AiResult { ok: boolean; text?: string; error?: string }

async function load(): Promise<void> {
  try {
    const resp = await props.backend.send<FsRead>('fs.read_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    if (!resp.payload?.ok) {
      loadError.value = resp.payload?.error || '無法讀取檔案'
      return
    }
    content.value = resp.payload.content ?? ''
    loaded.value = true
    if (props.initialLine && props.initialLine > 0) {
      await nextTick()
      editorRef.value?.revealLine(props.initialLine)
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '讀取檔案失敗'
  }
}

function onChange(v: string): void {
  content.value = v
  dirty.value = true
}

async function save(): Promise<void> {
  if (!dirty.value) return
  const snapshot = content.value
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
    workspace_path: props.workspacePath,
    rel_path: props.relPath,
    content: snapshot,
  })
  if (!resp.payload?.ok) {
    void alert(resp.payload?.error || '存檔失敗', { title: '存檔錯誤' })
    return
  }
  // Only clear dirty when no further edits landed while the request was in-flight.
  if (content.value === snapshot) dirty.value = false
  toast('已存檔', { type: 'success' })
}

// ── Cmd+K rewrite ─────────────────────────────────────────────────────────────
const cmdk = ref<{ open: boolean; instruction: string; busy: boolean; range: Range | null; code: string }>(
  { open: false, instruction: '', busy: false, range: null, code: '' }
)
const proposal = ref<{ range: Range; oldText: string; newText: string } | null>(null)
const cmdkInput = ref<HTMLInputElement | null>(null)

function openCmdK(): void {
  const range = editorRef.value?.getSelectionRange() ?? null
  const code = editorRef.value?.getSelectionText() ?? ''
  cmdk.value = { open: true, instruction: '', busy: false, range, code }
  proposal.value = null
  void Promise.resolve().then(() => cmdkInput.value?.focus())
}
function closeCmdK(): void {
  cmdk.value.open = false
  editorRef.value?.focus()
}

async function submitCmdK(): Promise<void> {
  if (cmdk.value.busy) return
  if (!cmdk.value.instruction.trim()) return
  if (!cmdk.value.range || !cmdk.value.code) {
    void alert('請先選取要改寫的程式碼', { title: 'Cmd+K' })
    return
  }
  cmdk.value.busy = true
  const resp = await props.backend.send<AiResult>('editor.rewrite', {
    code: cmdk.value.code,
    instruction: cmdk.value.instruction,
    language: lang.value,
    model,
  })
  cmdk.value.busy = false
  if (!resp.payload?.ok || !resp.payload.text) {
    void alert(resp.payload?.error || '改寫失敗', { title: 'Cmd+K' })
    return
  }
  proposal.value = { range: cmdk.value.range, oldText: cmdk.value.code, newText: resp.payload.text }
  cmdk.value.open = false
}

function acceptProposal(): void {
  if (!proposal.value) return
  editorRef.value?.applyEditExternal(proposal.value.range, proposal.value.newText)
  proposal.value = null
  dirty.value = true
  editorRef.value?.focus()
}
function rejectProposal(): void {
  proposal.value = null
  editorRef.value?.focus()
}

// ── Ghost completion (Cmd/Ctrl+I) ────────────────────────────────────────────
const ghostBusy = ref(false)

// ── Find bar (⌘F) ─────────────────────────────────────────────────────────────
const findOpen = ref(false)
const findQuery = ref('')
const findCase = ref(false)
const findWholeWord = ref(false)
const findMatches = ref<Array<{ line: number; startCol: number; endCol: number }>>([])
const findIdx = ref(-1)
const findInputEl = ref<HTMLInputElement | null>(null)
const replaceOpen = ref(false)
const replaceQuery = ref('')
const replaceInputEl = ref<HTMLInputElement | null>(null)

function isWordBoundary(haystack: string, matchStart: number, matchLen: number): boolean {
  const isWC = (ch: string) => /[a-zA-Z0-9_]/.test(ch)
  const before = matchStart === 0 || !isWC(haystack[matchStart - 1])
  const after = matchStart + matchLen >= haystack.length || !isWC(haystack[matchStart + matchLen])
  return before && after
}
/** True when the query contains only word characters — whole-word is meaningful. */
function queryIsAllWord(q: string): boolean { return /^[a-zA-Z0-9_]+$/.test(q) }

watch([findQuery, findCase, findWholeWord], () => { if (findOpen.value) computeMatches() })
// Content changed while find is open → recompute highlights but don't scroll/steal focus.
// The user may be editing in the editor itself; navigating to a match would be disruptive.
watch(content, () => { if (findOpen.value && findQuery.value) computeMatches({ navigate: false }) })

// Sync findOpen/editorTextFocus to keybinding context so when-clauses work.
watch(findOpen, (v) => {
  if (!props.embedded || props.active !== false) setContext('findOpen', v)
})
watch(() => props.active, (active) => {
  if (!props.embedded) return
  if (active === false) {
    setContext('findOpen', false)
    setContext('editorTextFocus', false)
  } else {
    // Restore find context in nextTick so the deactivating tab's synchronous
    // context clear (above) always runs before the new tab's restore, regardless
    // of Vue watcher order (which depends on component mount order).
    void nextTick(() => setContext('findOpen', findOpen.value))
  }
})

function openFind(): void {
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (!findOpen.value) {
    findOpen.value = true
    if (sel) findQuery.value = sel
  }
  void nextTick(() => { findInputEl.value?.focus(); findInputEl.value?.select() })
  if (findQuery.value) computeMatches()
}
function closeFind(): void {
  findOpen.value = false
  replaceOpen.value = false
  findMatches.value = []
  findIdx.value = -1
  editorRef.value?.setDecorations([])
  editorRef.value?.focus()
}
function computeMatches({ navigate = true }: { navigate?: boolean } = {}): void {
  const q = findQuery.value
  if (!q) {
    findMatches.value = []
    findIdx.value = -1
    editorRef.value?.setDecorations([])
    return
  }
  const text = editorRef.value?.getValue() ?? content.value
  const lines = text.split('\n')
  const needle = findCase.value ? q : q.toLowerCase()
  const matches: Array<{ line: number; startCol: number; endCol: number }> = []
  for (let li = 0; li < lines.length; li++) {
    const haystack = findCase.value ? lines[li] : lines[li].toLowerCase()
    let start = 0
    while (true) {
      const idx = haystack.indexOf(needle, start)
      if (idx === -1) break
      if (!findWholeWord.value || !queryIsAllWord(q) || isWordBoundary(haystack, idx, q.length)) {
        matches.push({ line: li, startCol: idx, endCol: idx + q.length })
      }
      start = idx + 1
    }
  }
  findMatches.value = matches
  if (findIdx.value < 0 || findIdx.value >= matches.length) findIdx.value = matches.length > 0 ? 0 : -1
  updateFindDecorations()
  if (navigate && findIdx.value >= 0) goToMatch(findIdx.value)
}
function updateFindDecorations(): void {
  editorRef.value?.setDecorations(findMatches.value.map((m, i) => ({
    id: `find-${i}`,
    type: 'highlight' as const,
    range: { start: { line: m.line, col: m.startCol }, end: { line: m.line, col: m.endCol } },
    className: i === findIdx.value ? 'ev-dec-current' : undefined,
  })))
}
function goToMatch(idx: number): void {
  findIdx.value = idx
  updateFindDecorations()
  const m = findMatches.value[idx]
  if (m) {
    editorRef.value?.revealPosition(m.line, m.startCol)
    // revealPosition schedules an async focus() on the editor textarea.
    // Queue a later microtask to give focus back to the find input so the user
    // can keep pressing Enter/Shift+Enter without re-clicking the search box.
    if (findOpen.value) void Promise.resolve().then(() => findInputEl.value?.focus())
  }
}
function nextMatch(): void {
  if (!findMatches.value.length) return
  goToMatch((findIdx.value + 1) % findMatches.value.length)
}
function prevMatch(): void {
  if (!findMatches.value.length) return
  goToMatch((findIdx.value - 1 + findMatches.value.length) % findMatches.value.length)
}
function openReplace(): void {
  replaceOpen.value = true
  openFind()
  void nextTick(() => replaceInputEl.value?.focus())
}
function replaceNext(): void {
  if (findIdx.value < 0 || !findMatches.value.length) return
  const m = findMatches.value[findIdx.value]
  editorRef.value?.applyEditExternal(
    { start: { line: m.line, col: m.startCol }, end: { line: m.line, col: m.endCol } },
    replaceQuery.value,
  )
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: true }))
}
function replaceAll(): void {
  if (!findMatches.value.length) return
  const q = findQuery.value
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const needWordBoundary = findWholeWord.value && queryIsAllWord(q)
  const pattern = needWordBoundary ? `\\b${escaped}\\b` : escaped
  const flags = findCase.value ? 'g' : 'gi'
  const re = new RegExp(pattern, flags)
  content.value = content.value.replace(re, replaceQuery.value)
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: false }))
}
function onFindKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch() }
  else if (e.key === 'Tab' && replaceOpen.value) { e.preventDefault(); replaceInputEl.value?.focus() }
}
function onReplaceKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); replaceAll() }
  else if (e.key === 'Enter') { e.preventDefault(); replaceNext() }
  else if (e.key === 'Tab') { e.preventDefault(); findInputEl.value?.focus() }
}

// ── Go-to-line overlay (⌘L) ──────────────────────────────────────────────────
const gotoOpen = ref(false)
const gotoLineInput = ref('')
const gotoInputEl = ref<HTMLInputElement | null>(null)

function openGoto(): void {
  gotoOpen.value = true
  gotoLineInput.value = String(cursorLine.value)
  void nextTick(() => { gotoInputEl.value?.focus(); gotoInputEl.value?.select() })
}
function closeGoto(): void {
  gotoOpen.value = false
  editorRef.value?.focus()
}
function submitGoto(): void {
  const n = parseInt(gotoLineInput.value, 10)
  if (!isNaN(n) && n > 0) editorRef.value?.revealLine(n)
  closeGoto()
}
function onGotoKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeGoto() }
  else if (e.key === 'Enter') { e.preventDefault(); submitGoto() }
}

function onEditorBodyFocusin(e: FocusEvent): void {
  if (props.embedded && props.active === false) return
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'TEXTAREA') {
    setContext('editorTextFocus', true)
  } else if (tag === 'INPUT') {
    // goto-line input is inside ep-body; clear editor focus so keybindings don't fire
    setContext('editorTextFocus', false)
  }
}
function onEditorBodyFocusout(e: FocusEvent): void {
  if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') {
    const body = e.currentTarget as HTMLElement
    const related = e.relatedTarget as HTMLElement | null
    if (!related || !body.contains(related)) {
      setContext('editorTextFocus', false)
    }
  }
}

async function requestGhost(): Promise<void> {
  if (ghostBusy.value) return
  const cur = editorRef.value?.getCursor()
  const value = editorRef.value?.getValue() ?? ''
  if (!cur) return
  const lines = value.split('\n')
  const prefix = [...lines.slice(0, cur.line), lines[cur.line]?.slice(0, cur.col) ?? ''].join('\n')
  const suffix = [lines[cur.line]?.slice(cur.col) ?? '', ...lines.slice(cur.line + 1)].join('\n')
  ghostBusy.value = true
  const resp = await props.backend.send<AiResult>('editor.complete', {
    prefix, suffix, language: lang.value, model,
  })
  ghostBusy.value = false
  if (resp.payload?.ok && resp.payload.text) {
    // Guard: cursor may have moved while waiting for the AI response.
    // Showing ghost text at a different position than where it was computed is wrong.
    const newCur = editorRef.value?.getCursor()
    if (!newCur || newCur.line !== cur.line || newCur.col !== cur.col) return
    editorRef.value?.setGhost(resp.payload.text)
    editorRef.value?.focus()
  } else {
    toast(resp.payload?.error || '無補全建議', { type: 'info' })
  }
}

// ── Keyboard shortcuts (window-level) ─────────────────────────────────────────
function onKeydown(e: KeyboardEvent): void {
  // When embedded, several panes share the window; only the active one reacts so
  // a shortcut never fires on a hidden file.
  if (props.embedded && props.active === false) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save() }
  else if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdK() }
  else if (mod && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); void requestGhost() }
  else if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind() }
  else if (mod && (e.key === 'g' || e.key === 'G') && findOpen.value) {
    e.preventDefault()
    e.shiftKey ? prevMatch() : nextMatch()
  }
  else if (mod && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); openGoto() }
}

onMounted(() => {
  // The host (IDE shell) owns the window title when embedded.
  if (!props.embedded) document.title = `Editor · ${props.name}`
  window.addEventListener('keydown', onKeydown)
  // 編輯器為獨立視窗，開窗當下後端 WebSocket 通常尚未連上，
  // 若立即 send 會以「ws not open」reject 且不會重試，畫面卡在「載入中」。
  // 改為等 status 變 connected 後再讀檔。
  watch(
    () => props.backend.status.value,
    (s) => {
      if (s === 'connected' && !loaded.value && !loadError.value) void load()
    },
    { immediate: true },
  )
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function toggleLineComment(): void { editorRef.value?.toggleLineComment() }
function addLineComment(): void { editorRef.value?.addLineComment() }
function removeLineComment(): void { editorRef.value?.removeLineComment() }
function jumpToLine(n: number): void { editorRef.value?.revealLine(n); editorRef.value?.focus() }
function deleteLine(): void { editorRef.value?.deleteLine() }
function insertLineBelow(): void { editorRef.value?.insertLineBelow() }
function insertLineAbove(): void { editorRef.value?.insertLineAbove() }
function moveLineUp(): void { editorRef.value?.moveLineUp() }
function moveLineDown(): void { editorRef.value?.moveLineDown() }
function jumpToBracket(): void { editorRef.value?.jumpToBracket() }
function duplicateLineDown(): void { editorRef.value?.duplicateLineDown() }
function duplicateLineUp(): void { editorRef.value?.duplicateLineUp() }
function indentLine(): void { editorRef.value?.indentLine() }
function dedentLine(): void { editorRef.value?.dedentLine() }
function cursorTop(): void { editorRef.value?.cursorTop() }
function cursorBottom(): void { editorRef.value?.cursorBottom() }
function scrollLineUp(): void { editorRef.value?.scrollLineUp() }
function scrollLineDown(): void { editorRef.value?.scrollLineDown() }
function transformToUppercase(): void { editorRef.value?.transformToUppercase() }
function transformToLowercase(): void { editorRef.value?.transformToLowercase() }
function trimTrailingWhitespace(): void { editorRef.value?.trimTrailingWhitespace() }
function formatDocument(): void { editorRef.value?.formatDocument() }

function selectNextOccurrence(): void {
  const curSel = editorRef.value?.getSelectionText() ?? ''
  if (!curSel) {
    // First press: select word at cursor
    const word = editorRef.value?.getWordAtCursor() ?? ''
    if (!word) return
    const cur = editorRef.value?.getCursor()
    if (!cur) return
    const lineText = (editorRef.value?.getValue() ?? '').split('\n')[cur.line] ?? ''
    let start = cur.col
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) start--
    editorRef.value?.setSelection({ line: cur.line, col: start }, { line: cur.line, col: start + word.length })
    return
  }
  // Subsequent presses: find next occurrence of selected text after current selection end
  const text = editorRef.value?.getValue() ?? ''
  const lines = text.split('\n')
  const selRange = editorRef.value?.getSelectionRange()
  const searchFrom = selRange?.end ?? editorRef.value?.getCursor() ?? { line: 0, col: 0 }

  for (let pass = 0; pass < 2; pass++) {
    for (let l = (pass === 0 ? searchFrom.line : 0); l < lines.length; l++) {
      const startCol = pass === 0 && l === searchFrom.line ? searchFrom.col : 0
      const idx = lines[l].indexOf(curSel, startCol)
      if (idx !== -1) {
        editorRef.value?.setSelection({ line: l, col: idx }, { line: l, col: idx + curSel.length })
        return
      }
    }
  }
}

function selectAllOccurrences(): void {
  const sel = editorRef.value?.getSelectionText() || editorRef.value?.getWordAtCursor() || ''
  if (!sel) return
  findQuery.value = sel
  if (!findOpen.value) findOpen.value = true
  computeMatches()
  void nextTick(() => { findInputEl.value?.focus(); findInputEl.value?.select() })
}

function setLanguage(l: string): void { langOverride.value = l || null }
function zoomIn(): void { editorRef.value?.zoomIn() }
function zoomOut(): void { editorRef.value?.zoomOut() }
function zoomReset(): void { editorRef.value?.zoomReset() }
function undo(): void { editorRef.value?.undo() }
function redo(): void { editorRef.value?.redo() }
function selectAll(): void { editorRef.value?.selectAll() }

defineExpose({
  save, openCmdK, requestGhost, openFind, nextMatch, prevMatch, openGoto,
  toggleLineComment, addLineComment, removeLineComment, jumpToLine,
  deleteLine, insertLineBelow, insertLineAbove,
  moveLineUp, moveLineDown, jumpToBracket, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine, cursorTop, cursorBottom, scrollLineUp, scrollLineDown,
  transformToUppercase, transformToLowercase, trimTrailingWhitespace, formatDocument,
  selectNextOccurrence, selectAllOccurrences,
  setLanguage, zoomIn, zoomOut, zoomReset,
  undo, redo, selectAll,
  openReplace,
  getContent: () => content.value,
})
</script>

<template>
  <div class="editor-pane">
    <!-- Tabs -->
    <div class="ep-tabs">
      <div v-if="!embedded" class="ep-tab active">
        <span class="ep-tab-name">{{ name }}</span>
        <span v-if="dirty" class="ep-dirty" title="未存檔">●</span>
      </div>
      <div class="ep-spacer" />
      <button class="ep-act" :disabled="!dirty" title="存檔 (⌘S)" @click="save">儲存</button>
      <button class="ep-act" title="AI 補全 (⌘I)" :disabled="ghostBusy || !loaded" @click="requestGhost">
        {{ ghostBusy ? '…' : '✦ 補全' }}
      </button>
      <button class="ep-act" title="AI 改寫選取 (⌘K)" :disabled="!loaded" @click="openCmdK">✦ Cmd+K</button>
    </div>

    <!-- Editor -->
    <div class="ep-body" @focusin="onEditorBodyFocusin" @focusout="onEditorBodyFocusout">
      <div v-if="loadError" class="ep-error">{{ loadError }}</div>
      <EditorView
        v-else-if="loaded"
        ref="editorRef"
        :model-value="content"
        :language="lang"
        @update:model-value="onChange"
        @cursor-change="onCursorChange"
      />
      <div v-else class="ep-loading">載入中…</div>

      <!-- Go-to-line overlay -->
      <div v-if="gotoOpen" class="ep-goto-overlay">
        <div class="ep-goto-box">
          <span class="ep-goto-label">跳到行</span>
          <input
            ref="gotoInputEl"
            v-model="gotoLineInput"
            type="number"
            class="ep-goto-input"
            placeholder="行號"
            min="1"
            @keydown="onGotoKeydown"
          />
          <button class="ep-act" @click="submitGoto">跳</button>
        </div>
      </div>
    </div>

    <!-- Cmd+K bar -->
    <div v-if="cmdk.open" class="ep-cmdk">
      <span class="ep-cmdk-badge">✦ Cmd+K</span>
      <input
        ref="cmdkInput"
        v-model="cmdk.instruction"
        class="ep-cmdk-input"
        placeholder="描述你想對選取程式碼做的修改…"
        @keydown.enter="submitCmdK"
        @keydown.esc="closeCmdK"
      />
      <button class="ep-act primary" :disabled="cmdk.busy" @click="submitCmdK">{{ cmdk.busy ? '思考中…' : '改寫' }}</button>
      <button class="ep-act" @click="closeCmdK">取消</button>
    </div>

    <!-- AI diff proposal -->
    <div v-if="proposal" class="ep-proposal">
      <div class="ep-prop-head">
        <span>AI 建議改寫</span>
        <div class="ep-prop-actions">
          <button class="ep-act success" @click="acceptProposal">✓ 接受</button>
          <button class="ep-act" @click="rejectProposal">✕ 拒絕</button>
        </div>
      </div>
      <div class="ep-prop-diff">
        <pre class="ep-old">{{ proposal.oldText }}</pre>
        <pre class="ep-new">{{ proposal.newText }}</pre>
      </div>
    </div>

    <!-- Find / Replace bar (⌘F / ⌘H / Esc) -->
    <div v-if="findOpen" class="ep-find">
      <div class="ep-find-row">
        <input
          ref="findInputEl"
          v-model="findQuery"
          class="ep-find-input"
          placeholder="搜尋…"
          @keydown="onFindKeydown"
        />
        <button
          class="ep-find-btn"
          :class="{ active: findCase }"
          title="區分大小寫"
          @click="findCase = !findCase"
        >Aa</button>
        <button
          class="ep-find-btn"
          :class="{ active: findWholeWord }"
          title="全字比對"
          @click="findWholeWord = !findWholeWord"
        >W|</button>
        <span class="ep-find-count">
          <template v-if="findQuery && findMatches.length === 0">無結果</template>
          <template v-else-if="findMatches.length">{{ findIdx + 1 }}/{{ findMatches.length }}</template>
        </span>
        <button class="ep-find-nav" title="上一個 (⇧↵)" :disabled="!findMatches.length" @click="prevMatch">↑</button>
        <button class="ep-find-nav" title="下一個 (↵)" :disabled="!findMatches.length" @click="nextMatch">↓</button>
        <button
          class="ep-find-btn"
          :class="{ active: replaceOpen }"
          title="顯示取代 (⌘H)"
          @click="replaceOpen = !replaceOpen"
        >ab</button>
        <button class="ep-find-close" title="關閉 (Esc)" @click="closeFind">✕</button>
      </div>
      <div v-if="replaceOpen" class="ep-find-row">
        <input
          ref="replaceInputEl"
          v-model="replaceQuery"
          class="ep-find-input"
          placeholder="取代…"
          @keydown="onReplaceKeydown"
        />
        <button class="ep-find-nav" title="取代 (↵)" :disabled="findIdx < 0" @click="replaceNext">⇥</button>
        <button class="ep-find-nav" title="全部取代 (⌥↵)" :disabled="!findMatches.length" @click="replaceAll">⇥⇥</button>
      </div>
    </div>

    <!-- Status bar -->
    <div class="ep-statusbar">
      <span class="ep-status-pos">Ln {{ cursorLine }}, Col {{ cursorCol }}</span>
      <span v-if="selectionInfo" class="ep-status-sel">{{ selectionInfo }}</span>
      <span class="ep-status-right">
        <span class="ep-status-lang">{{ langDisplay }}</span>
        <span class="ep-status-sep">·</span>
        <span class="ep-status-enc">UTF-8</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-primary);
}
.ep-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 12px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
}
.ep-tab.active { border-color: var(--accent-emphasis); }
.ep-dirty { color: var(--attention-fg); font-size: 10px; }
.ep-spacer { flex: 1; }
.ep-act {
  font-size: 11.5px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-act:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ep-act:disabled { opacity: 0.5; cursor: default; }
.ep-act.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ep-act.success { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); }
.ep-body { flex: 1; position: relative; min-height: 0; }
.ep-error, .ep-loading { padding: 24px; color: var(--text-muted); font-size: 12px; }
.ep-error { color: var(--danger-fg); }

.ep-cmdk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-cmdk-badge { font-size: 11px; font-weight: 700; color: var(--accent-fg); }
.ep-cmdk-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.ep-cmdk-input:focus { border-color: var(--accent-emphasis); }

.ep-proposal {
  flex-shrink: 0;
  max-height: 40%;
  overflow: auto;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
}
.ep-prop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
}
.ep-prop-actions { display: flex; gap: 6px; }
.ep-prop-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border-muted); }
.ep-old, .ep-new {
  margin: 0;
  padding: 8px 12px;
  font: 12px/1.5 ui-monospace, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-base);
}
.ep-old { color: var(--diff-del-fg); background: var(--diff-del-bg); }
.ep-new { color: var(--diff-add-fg); background: var(--diff-add-bg); }

.ep-find {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-find-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ep-find-input {
  flex: 1;
  max-width: 240px;
  padding: 4px 8px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  outline: none;
}
.ep-find-input:focus { border-color: var(--accent-emphasis); }
.ep-find-btn {
  padding: 3px 7px;
  font-size: 11px;
  font-family: inherit;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-find-btn.active { background: var(--accent-muted); color: var(--accent-fg); border-color: var(--accent-emphasis); }
.ep-find-count { font-size: 11px; color: var(--text-muted); min-width: 52px; text-align: center; }
.ep-find-nav {
  padding: 3px 8px;
  font-size: 13px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-find-nav:hover:not(:disabled) { background: var(--bg-muted); }
.ep-find-nav:disabled { opacity: 0.4; cursor: default; }
.ep-find-close {
  padding: 3px 7px;
  font-size: 11px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ep-find-close:hover { color: var(--text-primary); }

.ep-goto-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 20;
}
.ep-goto-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-top: none;
  border-radius: 0 0 8px 8px;
  pointer-events: all;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ep-goto-label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.ep-goto-input {
  width: 72px;
  padding: 4px 8px;
  font-size: 13px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  outline: none;
  text-align: center;
}
.ep-goto-input:focus { border-color: var(--accent-emphasis); }
.ep-goto-input::-webkit-inner-spin-button,
.ep-goto-input::-webkit-outer-spin-button { -webkit-appearance: none; }

.ep-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  height: 20px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 11px;
  flex-shrink: 0;
  user-select: none;
  opacity: 0.9;
}
.ep-status-pos { font-variant-numeric: tabular-nums; }
.ep-status-sel { color: var(--accent-fg); font-variant-numeric: tabular-nums; padding-left: 8px; }
.ep-status-right { display: flex; align-items: center; gap: 6px; opacity: 0.85; }
.ep-status-sep { opacity: 0.5; }
</style>
