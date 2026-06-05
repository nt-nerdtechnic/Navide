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
  (e: 'addToChat', selection: string): void
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
    const lines = sel.split('\n')
    const words = sel.trim().split(/\s+/).filter(Boolean).length
    if (lines.length > 1) {
      selectionInfo.value = `${lines.length} lines  ${sel.length} chars  ${words} words`
    } else {
      selectionInfo.value = `${sel.length} chars  ${words} words`
    }
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
      loadError.value = resp.payload?.error || 'Unable to read file'
      return
    }
    content.value = resp.payload.content ?? ''
    loaded.value = true
    if (props.initialLine && props.initialLine > 0) {
      await nextTick()
      editorRef.value?.revealLine(props.initialLine)
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to read file'
  }
}

// Track last edit position so cmd+k cmd+q can navigate back to it.
const lastEditLine = ref<number | null>(null)
const lastEditCol = ref<number | null>(null)

function onChange(v: string): void {
  content.value = v
  dirty.value = true
  const cur = editorRef.value?.getCursor()
  if (cur) { lastEditLine.value = cur.line; lastEditCol.value = cur.col }
}

function navigateToLastEdit(): void {
  if (lastEditLine.value === null) return
  editorRef.value?.revealPosition(lastEditLine.value, lastEditCol.value ?? 0)
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
    void alert(resp.payload?.error || 'Save failed', { title: 'Save error' })
    return
  }
  // Only clear dirty when no further edits landed while the request was in-flight.
  if (content.value === snapshot) dirty.value = false
  toast('Saved', { type: 'success' })
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
    void alert('Select code to rewrite first', { title: 'Cmd+K' })
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
    void alert(resp.payload?.error || 'Rewrite failed', { title: 'Cmd+K' })
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
const findRegex = ref(false)
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

watch([findQuery, findCase, findWholeWord, findRegex], () => { if (findOpen.value) computeMatches() })
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
  const matches: Array<{ line: number; startCol: number; endCol: number }> = []

  if (findRegex.value) {
    try {
      const flags = 'g' + (findCase.value ? '' : 'i')
      const re = new RegExp(q, flags)
      for (let li = 0; li < lines.length; li++) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(lines[li])) !== null) {
          matches.push({ line: li, startCol: m.index, endCol: m.index + m[0].length })
          if (m[0].length === 0) { re.lastIndex++; break }
        }
      }
    } catch {
      // Invalid regex — show no matches
    }
  } else {
    const needle = findCase.value ? q : q.toLowerCase()
    for (let li = 0; li < lines.length; li++) {
      const haystack = findCase.value ? lines[li] : lines[li].toLowerCase()
      let start = 0
      while (true) {
        const idx = haystack.indexOf(needle, start)
        if (idx === -1) break
        if (!findWholeWord.value || !queryIsAllWord(q) || isWordBoundary(haystack, idx, q.length)) {
          matches.push({ line: li, startCol: idx, endCol: idx + q.length })
        }
        start = idx + needle.length
      }
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
  let replacement = replaceQuery.value
  if (findRegex.value) {
    // Expand backreferences ($1, $& etc.) by applying the regex to the matched slice.
    try {
      const text = editorRef.value?.getValue() ?? content.value
      const lineText = text.split('\n')[m.line] ?? ''
      const flags = findCase.value ? '' : 'i'
      const re = new RegExp(findQuery.value, flags)
      replacement = lineText.slice(m.startCol, m.endCol).replace(re, replaceQuery.value)
    } catch { /* invalid regex — use literal replacement */ }
  }
  editorRef.value?.applyEditExternal(
    { start: { line: m.line, col: m.startCol }, end: { line: m.line, col: m.endCol } },
    replacement,
  )
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: true }))
}
function replaceAll(): void {
  if (!findMatches.value.length) return
  const q = findQuery.value
  const oldText = editorRef.value?.getValue() ?? content.value
  let newText: string
  try {
    if (findRegex.value) {
      // Regex mode: use query as regex; allow backreferences in replacement string
      const flags = findCase.value ? 'g' : 'gi'
      const re = new RegExp(q, flags)
      newText = oldText.replace(re, replaceQuery.value)
    } else {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const needWordBoundary = findWholeWord.value && queryIsAllWord(q)
      const pattern = needWordBoundary ? `\\b${escaped}\\b` : escaped
      const flags = findCase.value ? 'g' : 'gi'
      const re = new RegExp(pattern, flags)
      // Escape $ in replacement so it's treated as a literal string, not a backreference.
      const literalReplace = replaceQuery.value.replace(/\$/g, '$$$$')
      newText = oldText.replace(re, literalReplace)
    }
  } catch {
    return // Invalid regex
  }
  if (newText === oldText) return
  const lines = oldText.split('\n')
  const lastLine = lines.length - 1
  // Route through applyEditExternal so the change is registered in UndoStack.
  editorRef.value?.applyEditExternal(
    { start: { line: 0, col: 0 }, end: { line: lastLine, col: lines[lastLine].length } },
    newText,
  )
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: false }))
}
function selectCurrentFindMatch(): void {
  const idx = findIdx.value >= 0 ? findIdx.value : 0
  const m = findMatches.value[idx]
  if (!m) return
  editorRef.value?.setSelection({ line: m.line, col: m.startCol }, { line: m.line, col: m.endCol })
  closeFind()
  void nextTick(() => editorRef.value?.focus())
}
function onFindKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); selectCurrentFindMatch() }
  else if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch() }
  else if (e.key === 'Tab' && replaceOpen.value) { e.preventDefault(); replaceInputEl.value?.focus() }
  else if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); findCase.value = !findCase.value }
  else if (e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); findWholeWord.value = !findWholeWord.value }
  else if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); findRegex.value = !findRegex.value }
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

// Cursor position saved before goto opens; restored on Escape
let _gotoSavedLine = 1
let _gotoSavedCol = 0

function openGoto(): void {
  _gotoSavedLine = cursorLine.value
  _gotoSavedCol = cursorCol.value - 1
  gotoOpen.value = true
  gotoLineInput.value = String(cursorLine.value)
  void nextTick(() => { gotoInputEl.value?.focus(); gotoInputEl.value?.select() })
}
function closeGoto(): void {
  gotoOpen.value = false
  editorRef.value?.focus()
}
function _applyGotoInput(): void {
  const parts = gotoLineInput.value.split(':')
  const line = parseInt(parts[0], 10)
  const col = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN
  if (!isNaN(line) && line > 0) {
    if (!isNaN(col) && col > 0) editorRef.value?.revealPosition(line - 1, col - 1)
    else editorRef.value?.revealLine(line)
  }
}
function submitGoto(): void {
  _applyGotoInput()
  closeGoto()
}
function onGotoKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    editorRef.value?.revealPosition(_gotoSavedLine - 1, _gotoSavedCol)
    closeGoto()
  } else if (e.key === 'Enter') {
    e.preventDefault(); submitGoto()
  }
}
// Live preview: move editor view as user types line number
watch(gotoLineInput, () => { if (gotoOpen.value) _applyGotoInput() })

// ── Right-click context menu ──────────────────────────────────────────────────
const ctxOpen = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
function showContextMenu(e: MouseEvent): void {
  e.preventDefault()
  ctxOpen.value = true
  const container = (e.currentTarget as HTMLElement).getBoundingClientRect()
  ctxX.value = e.clientX - container.left
  ctxY.value = e.clientY - container.top
}
function closeContextMenu(): void { ctxOpen.value = false }
let _ctxEscHandler: ((e: KeyboardEvent) => void) | null = null
watch(ctxOpen, (open) => {
  if (_ctxEscHandler) { document.removeEventListener('keydown', _ctxEscHandler, true); _ctxEscHandler = null }
  if (!open) return
  _ctxEscHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }
  document.addEventListener('keydown', _ctxEscHandler, true)
})
async function ctxPaste(): Promise<void> {
  closeContextMenu()
  try {
    const text = await navigator.clipboard.readText()
    if (text) editorRef.value?.insertText(text)
  } catch { /* permission denied */ }
  editorRef.value?.focus()
}
function ctxCopy(): void {
  closeContextMenu()
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) void navigator.clipboard.writeText(sel)
  editorRef.value?.focus()
}
function ctxCut(): void {
  closeContextMenu()
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) { void navigator.clipboard.writeText(sel); editorRef.value?.insertText('') }
  editorRef.value?.focus()
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
    toast(resp.payload?.error || 'No completion available', { type: 'info' })
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
function toggleBlockComment(): void { editorRef.value?.toggleBlockComment() }
function jumpToLine(n: number): void { editorRef.value?.revealLine(n); editorRef.value?.focus() }
function deleteLine(): void { editorRef.value?.deleteLine() }
function deleteWordLeft(): void { editorRef.value?.deleteWordLeft() }
function deleteWordRight(): void { editorRef.value?.deleteWordRight() }
function deleteLineLeft(): void { editorRef.value?.deleteLineLeft() }
function deleteLineRight(): void { editorRef.value?.deleteLineRight() }
function insertLineBelow(): void { editorRef.value?.insertLineBelow() }
function insertLineAbove(): void { editorRef.value?.insertLineAbove() }
function moveLineUp(): void { editorRef.value?.moveLineUp() }
function moveLineDown(): void { editorRef.value?.moveLineDown() }
function jumpToBracket(): void { editorRef.value?.jumpToBracket() }
function selectToBracket(): void { editorRef.value?.selectToBracket() }
function duplicateLineDown(): void { editorRef.value?.duplicateLineDown() }
function duplicateLineUp(): void { editorRef.value?.duplicateLineUp() }
function indentLine(): void { editorRef.value?.indentLine() }
function dedentLine(): void { editorRef.value?.dedentLine() }
function cursorTop(): void { editorRef.value?.cursorTop() }
function cursorBottom(): void { editorRef.value?.cursorBottom() }
function cursorTopSelect(): void { editorRef.value?.cursorTopSelect() }
function cursorBottomSelect(): void { editorRef.value?.cursorBottomSelect() }
function cursorWordLeft(): void { editorRef.value?.cursorWordLeft() }
function cursorWordRight(): void { editorRef.value?.cursorWordRight() }
function cursorWordLeftSelect(): void { editorRef.value?.cursorWordLeftSelect() }
function cursorWordRightSelect(): void { editorRef.value?.cursorWordRightSelect() }
function scrollLineUp(): void { editorRef.value?.scrollLineUp() }
function scrollLineDown(): void { editorRef.value?.scrollLineDown() }
function transformToUppercase(): void { editorRef.value?.transformToUppercase() }
function transformToLowercase(): void { editorRef.value?.transformToLowercase() }
function transformToTitleCase(): void { editorRef.value?.transformToTitleCase() }
function transformToSnakeCase(): void { editorRef.value?.transformToSnakeCase() }
function transformToCamelCase(): void { editorRef.value?.transformToCamelCase() }
function transformToKebabCase(): void { editorRef.value?.transformToKebabCase() }
function transformToPascalCase(): void { editorRef.value?.transformToPascalCase() }
function trimTrailingWhitespace(): void { editorRef.value?.trimTrailingWhitespace() }
function formatDocument(): void { editorRef.value?.formatDocument() }
function formatSelection(): void { editorRef.value?.formatSelection() }
function expandSelection(): void { editorRef.value?.expandSelection() }
function shrinkSelection(): void { editorRef.value?.shrinkSelection() }
function joinLines(): void { editorRef.value?.joinLines() }
function sortLinesAscending(): void { editorRef.value?.sortLinesAscending() }
function sortLinesDescending(): void { editorRef.value?.sortLinesDescending() }
function selectLine(): void { editorRef.value?.selectLine() }
function transpose(): void { editorRef.value?.transpose() }
function indentationToSpaces(): void { editorRef.value?.indentationToSpaces() }
function indentationToTabs(): void { editorRef.value?.indentationToTabs() }

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
function toggleLineNumbers(): void { editorRef.value?.toggleLineNumbers() }
function undo(): void { editorRef.value?.undo() }
function redo(): void { editorRef.value?.redo() }
function selectAll(): void { editorRef.value?.selectAll() }

function focusEditor(): void { editorRef.value?.focus() }

defineExpose({
  save, openCmdK, requestGhost, openFind, nextMatch, prevMatch, openGoto,
  focus: focusEditor,
  toggleLineComment, addLineComment, removeLineComment, toggleBlockComment, jumpToLine,
  deleteLine, deleteWordLeft, deleteWordRight, deleteLineLeft, deleteLineRight, insertLineBelow, insertLineAbove,
  moveLineUp, moveLineDown, jumpToBracket, selectToBracket, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine, cursorTop, cursorBottom, cursorTopSelect, cursorBottomSelect,
  cursorWordLeft, cursorWordRight, cursorWordLeftSelect, cursorWordRightSelect,
  scrollLineUp, scrollLineDown,
  transformToUppercase, transformToLowercase, transformToTitleCase,
  transformToSnakeCase, transformToCamelCase, transformToKebabCase, transformToPascalCase,
  trimTrailingWhitespace, formatDocument, formatSelection,
  joinLines, sortLinesAscending, sortLinesDescending,
  selectLine,
  transpose, indentationToSpaces, indentationToTabs,
  expandSelection, shrinkSelection,
  selectNextOccurrence, selectAllOccurrences,
  navigateToLastEdit,
  setLanguage, zoomIn, zoomOut, zoomReset, toggleLineNumbers,
  undo, redo, selectAll,
  openReplace,
  getContent: () => content.value,
  getWordAtCursor: () => editorRef.value?.getWordAtCursor() ?? '',
  getSelection: () => editorRef.value?.getSelectionText() ?? '',
  insertTextAtCursor: (text: string) => editorRef.value?.insertText(text),
  getCursorLineText: (): string => {
    const cur = editorRef.value?.getCursor()
    if (!cur) return ''
    return content.value.split('\n')[cur.line] ?? ''
  },
})
</script>

<template>
  <div class="editor-pane">
    <!-- Tabs -->
    <div class="ep-tabs">
      <div v-if="!embedded" class="ep-tab active">
        <span class="ep-tab-name">{{ name }}</span>
        <span v-if="dirty" class="ep-dirty" title="Unsaved">●</span>
      </div>
      <div class="ep-spacer" />
      <button class="ep-act" :disabled="!dirty" title="Save (⌘S)" @click="save">Save</button>
      <button class="ep-act" title="AI complete (⌘I)" :disabled="ghostBusy || !loaded" @click="requestGhost">
        {{ ghostBusy ? '…' : '✦ Complete' }}
      </button>
      <button class="ep-act" title="AI rewrite selection (⌘K)" :disabled="!loaded" @click="openCmdK">✦ Cmd+K</button>
    </div>

    <!-- Editor -->
    <div class="ep-body" @focusin="onEditorBodyFocusin" @focusout="onEditorBodyFocusout" @contextmenu="showContextMenu">
      <div v-if="loadError" class="ep-error">{{ loadError }}</div>
      <EditorView
        v-else-if="loaded"
        ref="editorRef"
        :model-value="content"
        :language="lang"
        @update:model-value="onChange"
        @cursor-change="onCursorChange"
      />
      <div v-else class="ep-loading">Loading…</div>

      <!-- Context menu -->
      <div v-if="ctxOpen" class="ep-ctx-backdrop" @mousedown.self="closeContextMenu">
        <div class="ep-ctx-menu" :style="{ left: ctxX + 'px', top: ctxY + 'px' }">
          <button class="ep-ctx-item" @click="ctxCut">Cut</button>
          <button class="ep-ctx-item" @click="ctxCopy">Copy</button>
          <button class="ep-ctx-item" @click="ctxPaste">Paste</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); toggleLineComment() }">Toggle Comment</button>
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); openFind() }">Find</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { const sel = editorRef?.getSelection?.() ?? ''; closeContextMenu(); emit('addToChat', sel || editorRef?.getContent?.() ?? '') }">Add to AI Chat</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); editorRef?.selectAll() }">Select All</button>
        </div>
      </div>

      <!-- Go-to-line overlay -->
      <div v-if="gotoOpen" class="ep-goto-overlay">
        <div class="ep-goto-box">
          <span class="ep-goto-label">Go to line</span>
          <input
            ref="gotoInputEl"
            v-model="gotoLineInput"
            type="number"
            class="ep-goto-input"
            placeholder="Line number"
            min="1"
            @keydown="onGotoKeydown"
          />
          <button class="ep-act" @click="submitGoto">Go</button>
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
        placeholder="Describe the changes to make to the selected code…"
        @keydown.enter="submitCmdK"
        @keydown.esc="closeCmdK"
      />
      <button class="ep-act primary" :disabled="cmdk.busy" @click="submitCmdK">{{ cmdk.busy ? 'Thinking…' : 'Rewrite' }}</button>
      <button class="ep-act" @click="closeCmdK">Cancel</button>
    </div>

    <!-- AI diff proposal -->
    <div v-if="proposal" class="ep-proposal">
      <div class="ep-prop-head">
        <span>AI suggested rewrite</span>
        <div class="ep-prop-actions">
          <button class="ep-act success" @click="acceptProposal">✓ Accept</button>
          <button class="ep-act" @click="rejectProposal">✕ Reject</button>
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
          placeholder="Search…"
          @keydown="onFindKeydown"
        />
        <button
          class="ep-find-btn"
          :class="{ active: findCase }"
          title="Match case (⌥C)"
          @click="findCase = !findCase"
        >Aa</button>
        <button
          class="ep-find-btn"
          :class="{ active: findWholeWord }"
          title="Match whole word (⌥W)"
          @click="findWholeWord = !findWholeWord"
        >W|</button>
        <button
          class="ep-find-btn"
          :class="{ active: findRegex }"
          title="Use regular expression (⌥R)"
          @click="findRegex = !findRegex"
        >.*</button>
        <span class="ep-find-count">
          <template v-if="findQuery && findMatches.length === 0">No results</template>
          <template v-else-if="findMatches.length">{{ findIdx + 1 }}/{{ findMatches.length }}</template>
        </span>
        <button class="ep-find-nav" title="Previous match (⇧↵)" :disabled="!findMatches.length" @click="prevMatch">↑</button>
        <button class="ep-find-nav" title="Next match (↵)" :disabled="!findMatches.length" @click="nextMatch">↓</button>
        <button
          class="ep-find-btn"
          :class="{ active: replaceOpen }"
          title="Toggle replace (⌘H)"
          @click="replaceOpen = !replaceOpen"
        >ab</button>
        <button class="ep-find-close" title="Close (Esc)" @click="closeFind">✕</button>
      </div>
      <div v-if="replaceOpen" class="ep-find-row">
        <input
          ref="replaceInputEl"
          v-model="replaceQuery"
          class="ep-find-input"
          placeholder="Replace…"
          @keydown="onReplaceKeydown"
        />
        <button class="ep-find-nav" title="Replace (↵)" :disabled="findIdx < 0" @click="replaceNext">⇥</button>
        <button class="ep-find-nav" title="Replace all (⌥↵)" :disabled="!findMatches.length" @click="replaceAll">⇥⇥</button>
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

.ep-ctx-backdrop {
  position: absolute; inset: 0; z-index: 200;
}
.ep-ctx-menu {
  position: absolute;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,.28);
  padding: 4px 0;
  min-width: 160px;
  z-index: 201;
}
.ep-ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 5px 14px; font-size: 12px;
  background: none; border: none; cursor: pointer;
  color: var(--text-primary);
}
.ep-ctx-item:hover { background: var(--accent-muted); }
.ep-ctx-sep { height: 1px; background: var(--border-default); margin: 3px 0; }

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
