<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { TextModel } from '../model/TextModel'
import { UndoStack } from '../model/UndoStack'
import { tokenizerFor } from '../tokenize/index'
import { useVirtualScroll } from './useVirtualScroll'
import type { Position, Range, Token, Decoration } from '../types'

const props = withDefaults(defineProps<{ modelValue?: string; readonly?: boolean; language?: string }>(), {
  modelValue: '',
  readonly: false,
  language: '',
})
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'cursor-change', pos: Position): void
}>()

const LINE_HEIGHT = 19
const PAD_LEFT = 8
const fontZoom = ref(1.0)
const fontSizePx = computed(() => Math.round(13 * fontZoom.value))
const lineHeightPx = computed(() => Math.round(LINE_HEIGHT * fontZoom.value))

const model = new TextModel(props.modelValue)
const undo = new UndoStack()
const tokenizer = computed(() => tokenizerFor(props.language ?? ''))

// Bumped on every edit to re-derive rendered state.
const version = ref(0)
const cursor = ref<Position>({ line: 0, col: 0 })
const anchor = ref<Position | null>(null) // selection start, null when no selection
const decorations = ref<Decoration[]>([])
const ghost = ref<{ pos: Position; text: string } | null>(null)
// Remembered target column for vertical navigation (arrow up/down).
// -1 = not set; preserved across consecutive vertical moves, cleared on any other action.
let preferredCol = -1
// Incremental max-line-length cache. -1 means invalid (needs full rescan).
// Typing inserts only increase the max → O(1) update.
// Deletions/multi-line edits may shrink the max → mark invalid, rescan lazily.
let _maxLineLenCache = -1
function _scanMaxLineLen(): number {
  let m = 0
  for (let i = 0; i < model.lineCount(); i++) {
    const l = model.getLine(i).length
    if (l > m) m = l
  }
  return (_maxLineLenCache = m)
}

const lineCount = computed(() => {
  version.value // track
  return model.lineCount()
})
// Gutter grows to accommodate the widest line number (e.g. ≥1000 lines needs 4 digits).
const gutterWidth = computed(() => Math.max(48, String(lineCount.value).length * 9 + 12))
// Sizer minimum width ensures long lines are horizontally scrollable.
// Uses cached max-length: O(1) on pure inserts, O(N) only when cache is invalid.
const sizerMinWidth = computed(() => {
  version.value // track edits
  const max = _maxLineLenCache >= 0 ? _maxLineLenCache : _scanMaxLineLen()
  return gutterWidth.value + PAD_LEFT + max * charWidth.value + 40
})

const vs = useVirtualScroll(lineCount, lineHeightPx)
const scrollEl = ref<HTMLElement | null>(null)
const scrollLeftVal = ref(0)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const charWidth = ref(8)
let composing = false

// ── Tokenization (whole-doc; fine for typical source files) ──────────────────
// ── Incremental token cache ───────────────────────────────────────────────────
// Re-tokenizes only from the first edited line forward.
// When a line's text and incoming state are unchanged, propagation stops early.
interface TokEntry { text: string; stateIn: number; tokens: Token[]; stateOut: number }
let _tokCache: TokEntry[] = []
let _tokInvalidFrom = 0

function _ensureTokensUpTo(lastLine: number): void {
  if (_tokInvalidFrom > lastLine) return
  const tok = tokenizer.value
  let stateIn = _tokInvalidFrom === 0
    ? tok.initialState()
    : (_tokCache[_tokInvalidFrom - 1]?.stateOut ?? tok.initialState())
  for (let i = _tokInvalidFrom; i <= lastLine; i++) {
    const text = i < model.lineCount() ? model.getLine(i) : ''
    const cached = _tokCache[i]
    if (cached && cached.text === text && cached.stateIn === stateIn) {
      // Cache hit: propagate state without re-tokenizing this line.
      // Continue to ensure lines between here and lastLine are computed too.
      stateIn = cached.stateOut
    } else {
      const { tokens, endState } = tok.tokenizeLine(text, stateIn)
      _tokCache[i] = { text, stateIn, tokens, stateOut: endState }
      stateIn = endState
    }
  }
  _tokInvalidFrom = lastLine + 1
}

watch(tokenizer, () => { _tokCache = []; _tokInvalidFrom = 0 })

interface RenderLine {
  index: number
  segments: { text: string; cls: string }[]
}

const visibleLines = computed<RenderLine[]>(() => {
  version.value // re-render on every edit
  const res: RenderLine[] = []
  for (let i = vs.startLine.value; i < vs.endLine.value; i++) {
    res.push({ index: i, segments: segmentsFor(i) })
  }
  return res
})

function segmentsFor(line: number): { text: string; cls: string }[] {
  _ensureTokensUpTo(line)
  const text = model.getLine(line)
  const toks = _tokCache[line]?.tokens ?? []
  if (toks.length === 0) return text ? [{ text, cls: 'tok-text' }] : []
  const segs: { text: string; cls: string }[] = []
  let col = 0
  for (const t of toks) {
    if (t.start > col) segs.push({ text: text.slice(col, t.start), cls: 'tok-text' })
    segs.push({ text: text.slice(t.start, t.end), cls: `tok-${t.type}` })
    col = t.end
  }
  if (col < text.length) segs.push({ text: text.slice(col), cls: 'tok-text' })
  return segs
}

// ── Selection helpers ────────────────────────────────────────────────────────
function selectionRange(): Range | null {
  if (!anchor.value) return null
  const a = anchor.value
  const c = cursor.value
  if (a.line === c.line && a.col === c.col) return null
  return comparePos(a, c) <= 0 ? { start: a, end: c } : { start: c, end: a }
}
function comparePos(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line
  return a.col - b.col
}

// ── Editing ──────────────────────────────────────────────────────────────────
function applyEdit(range: Range, text: string): void {
  if (props.readonly) return
  preferredCol = -1
  const isPureInsert = range.start.line === range.end.line && range.start.col === range.end.col
  const op = { range, text }
  const { inverse, caret } = model.applyEdit(op)
  undo.push(op, inverse)
  // Update max-line-length cache incrementally.
  // Pure single-line insert (typing) can only increase the max → O(1) check.
  // Everything else (delete, multi-line edit, newline) → invalidate for lazy rescan.
  if (isPureInsert && text.indexOf('\n') === -1) {
    const newLen = model.getLine(caret.line).length
    // Only update incrementally when cache is valid; if -1 (invalidated), leave it
    // so the next sizerMinWidth read triggers a full rescan via _scanMaxLineLen().
    if (_maxLineLenCache >= 0 && newLen > _maxLineLenCache) _maxLineLenCache = newLen
  } else {
    _maxLineLenCache = -1
  }
  if (range.start.line < _tokInvalidFrom) _tokInvalidFrom = range.start.line
  cursor.value = caret
  anchor.value = null
  ghost.value = null
  afterChange()
}

function insertText(text: string): void {
  const sel = selectionRange()
  const range = sel ?? { start: cursor.value, end: cursor.value }
  applyEdit(range, text)
}

function deleteBackward(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const c = cursor.value
  if (c.col > 0) {
    const lineText = model.getLine(c.line)
    // Delete both brackets when cursor is between an auto-inserted pair.
    // Guard c.col < lineText.length prevents undefined===undefined false-positive at EOL.
    if (c.col < lineText.length && AUTO_PAIRS[lineText[c.col - 1]] === lineText[c.col]) {
      applyEdit({ start: { line: c.line, col: c.col - 1 }, end: { line: c.line, col: c.col + 1 } }, '')
      return
    }
    applyEdit({ start: { line: c.line, col: c.col - 1 }, end: c }, '')
  } else if (c.line > 0) {
    const prevLen = model.getLine(c.line - 1).length
    applyEdit({ start: { line: c.line - 1, col: prevLen }, end: c }, '')
  }
}

function deleteForward(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const c = cursor.value
  const lineLen = model.getLine(c.line).length
  if (c.col < lineLen) {
    applyEdit({ start: c, end: { line: c.line, col: c.col + 1 } }, '')
  } else if (c.line < model.lineCount() - 1) {
    applyEdit({ start: c, end: { line: c.line + 1, col: 0 } }, '')
  }
}

function afterChange(): void {
  _selStack.length = 0 // editing invalidates the expand/shrink history
  version.value++
  emit('update:modelValue', model.getValue())
  void nextTick(scrollCursorIntoView)
}
// Like afterChange() but does NOT emit update:modelValue.
// Used when the content arrives from the parent prop — emitting back would
// cause EditorPane.onChange() to fire and mark the file dirty on load.
function afterExternalChange(): void {
  _selStack.length = 0
  version.value++
  void nextTick(scrollCursorIntoView)
}

// ── Cursor movement ──────────────────────────────────────────────────────────
function clampPos(p: Position): Position {
  const line = Math.max(0, Math.min(p.line, model.lineCount() - 1))
  const col = Math.max(0, Math.min(p.col, model.getLine(line).length))
  return { line, col }
}

// Adjusts a cursor/anchor position after a comment add/remove operation.
// colDeltas[i] > 0: chars added to line (startLine+i) after indent; < 0: chars removed.
// Positions inside the indent zone are not shifted.
function _adjCommentPos(
  p: Position,
  startLine: number,
  indentLens: number[],
  colDeltas: number[],
): Position {
  const li = p.line - startLine
  if (li < 0 || li >= colDeltas.length || colDeltas[li] === 0) return clampPos(p)
  const delta = colDeltas[li]
  const iLen = indentLens[li]
  if (p.col <= iLen) return clampPos(p)
  const newCol = delta > 0 ? p.col + delta : Math.max(iLen, p.col + delta)
  return clampPos({ line: p.line, col: newCol })
}

function moveCursor(dLine: number, dCol: number, extend: boolean): void {
  startOrClearSelection(extend)
  let { line, col } = cursor.value
  if (dCol !== 0) {
    preferredCol = -1
    col += dCol
    if (col < 0) {
      if (line > 0) { line--; col = model.getLine(line).length } else col = 0
    } else if (col > model.getLine(line).length) {
      if (line < model.lineCount() - 1) { line++; col = 0 } else col = model.getLine(line).length
    }
  }
  if (dLine !== 0) {
    if (preferredCol < 0) preferredCol = col
    line = Math.max(0, Math.min(line + dLine, model.lineCount() - 1))
    col = Math.min(preferredCol, model.getLine(line).length)
  }
  cursor.value = { line, col }
  ghost.value = null
  void nextTick(scrollCursorIntoView)
}

function moveTo(pos: Position, extend: boolean): void {
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  cursor.value = clampPos(pos)
  void nextTick(scrollCursorIntoView)
}

function startOrClearSelection(extend: boolean): void {
  if (extend) {
    if (!anchor.value) anchor.value = { ...cursor.value }
  } else {
    anchor.value = null
  }
}

function homeKey(extend: boolean): void {
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  const line = model.getLine(cursor.value.line)
  let indent = 0
  while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) indent++
  cursor.value = { line: cursor.value.line, col: cursor.value.col === indent ? 0 : indent }
}
function endKey(extend: boolean): void {
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  const line = cursor.value.line
  cursor.value = { line, col: model.getLine(line).length }
}

function isWordChar(ch: string): boolean { return /[a-zA-Z0-9_]/.test(ch) }

function _wordLeftPos(pos: Position): Position {
  let { line, col } = pos
  if (col === 0) {
    if (line > 0) { line--; col = model.getLine(line).length }
    return { line, col }
  }
  const text = model.getLine(line)
  col--
  while (col > 0 && (text[col] === ' ' || text[col] === '\t')) col--
  if (isWordChar(text[col])) {
    while (col > 0 && isWordChar(text[col - 1])) col--
  } else {
    while (col > 0 && !isWordChar(text[col - 1]) && text[col - 1] !== ' ' && text[col - 1] !== '\t') col--
  }
  return { line, col }
}

function _wordRightPos(pos: Position): Position {
  let { line, col } = pos
  const text = model.getLine(line)
  if (col >= text.length) {
    if (line < model.lineCount() - 1) { line++; col = 0 }
    return { line, col }
  }
  if (isWordChar(text[col])) {
    while (col < text.length && isWordChar(text[col])) col++
  } else if (text[col] === ' ' || text[col] === '\t') {
    while (col < text.length && (text[col] === ' ' || text[col] === '\t')) col++
  } else {
    while (col < text.length && !isWordChar(text[col]) && text[col] !== ' ' && text[col] !== '\t') col++
  }
  return { line, col }
}

function moveWordLeft(extend: boolean): void {
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  cursor.value = _wordLeftPos(cursor.value)
  void nextTick(scrollCursorIntoView)
}

function moveWordRight(extend: boolean): void {
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  cursor.value = _wordRightPos(cursor.value)
  void nextTick(scrollCursorIntoView)
}

function deleteWordLeft(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const end = { ...cursor.value }
  const start = _wordLeftPos(end)
  if (comparePos(start, end) !== 0) applyEdit({ start, end }, '')
}

function deleteWordRight(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const start = { ...cursor.value }
  const end = _wordRightPos(start)
  if (comparePos(start, end) !== 0) applyEdit({ start, end }, '')
}
function deleteLineLeft(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const c = cursor.value
  if (c.col > 0) applyEdit({ start: { line: c.line, col: 0 }, end: { ...c } }, '')
}
function deleteLineRight(): void {
  const sel = selectionRange()
  if (sel) { applyEdit(sel, ''); return }
  const c = cursor.value
  const lineLen = model.getLine(c.line).length
  if (c.col < lineLen) applyEdit({ start: { ...c }, end: { line: c.line, col: lineLen } }, '')
}

// ── Indent / dedent selected lines ───────────────────────────────────────────
const INDENT = '  '

function indentLines(startLine: number, endLine: number): void {
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const savedCursor = { ...cursor.value }
  const newContent = Array.from({ length: endLine - startLine + 1 }, (_, i) =>
    INDENT + model.getLine(startLine + i),
  ).join('\n')
  applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, newContent)
  // Restore selection shifted by INDENT.length on each affected line.
  // Guard: only shift positions within [startLine, endLine], matching dedentLines' anchorIdx logic.
  anchor.value = savedAnchor && savedAnchor.line >= startLine && savedAnchor.line <= endLine
    ? { line: savedAnchor.line, col: savedAnchor.col + INDENT.length }
    : savedAnchor
  cursor.value = savedCursor.line >= startLine && savedCursor.line <= endLine
    ? { line: savedCursor.line, col: savedCursor.col + INDENT.length }
    : savedCursor
}

function dedentLines(startLine: number, endLine: number): void {
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const savedCursor = { ...cursor.value }
  const removals: number[] = []
  const newContent = Array.from({ length: endLine - startLine + 1 }, (_, i) => {
    const line = model.getLine(startLine + i)
    let removed = 0
    while (removed < INDENT.length && line[removed] === ' ') removed++
    // Tab-indented files: if no spaces found, remove one leading tab
    if (removed === 0 && line[0] === '\t') removed = 1
    removals.push(removed)
    return line.slice(removed)
  }).join('\n')
  applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, newContent)
  const anchorIdx = savedAnchor ? savedAnchor.line - startLine : -1
  anchor.value = savedAnchor && anchorIdx >= 0 && anchorIdx < removals.length
    ? { line: savedAnchor.line, col: Math.max(0, savedAnchor.col - removals[anchorIdx]) }
    : savedAnchor
  const cursorIdx = savedCursor.line - startLine
  cursor.value = cursorIdx >= 0 && cursorIdx < removals.length
    ? { line: savedCursor.line, col: Math.max(0, savedCursor.col - removals[cursorIdx]) }
    : savedCursor
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent): void {
  if (composing) return
  const mod = e.metaKey || e.ctrlKey
  const shift = e.shiftKey

  // Ghost text accept
  if (e.key === 'Tab' && ghost.value) {
    e.preventDefault()
    acceptGhost()
    return
  }
  // Right arrow: accept one char (plain) or one word (cmd/alt) of ghost text
  if (e.key === 'ArrowRight' && ghost.value && !shift) {
    e.preventDefault()
    const text = ghost.value.text
    if (mod || e.altKey) {
      // Accept next word: skip leading whitespace, then advance through word chars
      let i = 0
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
      if (i < text.length && isWordChar(text[i])) {
        while (i < text.length && isWordChar(text[i])) i++
      } else if (i < text.length) {
        i++
      }
      if (i === 0) { ghost.value = null; return }
      const accepted = text.slice(0, i)
      const remaining = text.slice(i)
      ghost.value = null
      insertText(accepted)
      if (remaining) ghost.value = { pos: { ...cursor.value }, text: remaining }
    } else {
      // Accept one character
      const remaining = text.slice(1)
      ghost.value = null
      insertText(text[0])
      if (remaining) ghost.value = { pos: { ...cursor.value }, text: remaining }
    }
    return
  }

  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    if (shift) doRedo()
    else doUndo()
    return
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault(); doRedo(); return
  }
  if (mod && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault(); selectAll(); return
  }
  if (mod && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault()
    const sel = selectionRange()
    const text = sel ? model.getValueInRange(sel) : model.getLine(cursor.value.line) + '\n'
    void navigator.clipboard.writeText(text)
    return
  }
  if (mod && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault()
    const sel = selectionRange()
    if (sel) {
      void navigator.clipboard.writeText(model.getValueInRange(sel))
      applyEdit(sel, '')
    } else {
      void navigator.clipboard.writeText(model.getLine(cursor.value.line) + '\n')
      deleteLine()
    }
    return
  }
  if (mod && e.key === '/') {
    e.preventDefault(); toggleLineComment(); return
  }

  // Arrow + modifier combos (must precede switch to capture modifiers)
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const left = e.key === 'ArrowLeft'
    if (e.altKey) { left ? moveWordLeft(shift) : moveWordRight(shift) }
    else if (mod)  { left ? homeKey(shift)      : endKey(shift)       }
    else           { moveCursor(0, left ? -1 : 1, shift)              }
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    const up = e.key === 'ArrowUp'
    if (e.altKey && !mod) { if (up) moveLineUp(); else moveLineDown() }
    else if (mod) {
      // Shift+Cmd+Up/Down: select to file start/end (Cmd-only is handled by keybindings)
      ghost.value = null
      startOrClearSelection(shift)
      preferredCol = -1
      if (up) cursor.value = { line: 0, col: 0 }
      else { const last = model.lineCount() - 1; cursor.value = { line: last, col: model.getLine(last).length } }
      void nextTick(scrollCursorIntoView)
    }
    else { moveCursor(up ? -1 : 1, 0, shift) }
    return
  }

  switch (e.key) {
    case 'Home': e.preventDefault(); homeKey(shift); break
    case 'PageUp': case 'PageDown': {
      e.preventDefault()
      const pageLines = Math.max(1, Math.floor(vs.viewportHeight.value / lineHeightPx.value) - 1)
      moveCursor(e.key === 'PageUp' ? -pageLines : pageLines, 0, shift)
      break
    }
    case 'End': e.preventDefault(); endKey(shift); break
    case 'Backspace': e.preventDefault(); mod ? deleteLineLeft() : e.altKey ? deleteWordLeft() : deleteBackward(); break
    case 'Delete': e.preventDefault(); mod ? deleteLineRight() : e.altKey ? deleteWordRight() : deleteForward(); break
    case 'Enter': {
      e.preventDefault()
      const c = cursor.value
      const curLine = model.getLine(c.line)
      let indent = ''
      for (const ch of curLine) {
        if (ch === ' ' || ch === '\t') indent += ch
        else break
      }
      // Smart bracket expansion: pressing Enter between {|}, [|], (|) adds indented inner line
      const EXPAND_PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
      if (!selectionRange() && c.col > 0 && c.col < curLine.length && EXPAND_PAIRS[curLine[c.col - 1]] === curLine[c.col]) {
        applyEdit({ start: c, end: c }, '\n' + indent + INDENT + '\n' + indent)
        cursor.value = { line: c.line + 1, col: indent.length + INDENT.length }
        break
      }
      insertText('\n' + indent)
      break
    }
    case 'Tab': {
      e.preventDefault()
      const sel = selectionRange()
      if (shift) {
        const ln = sel ? sel.start.line : cursor.value.line
        const endLn = sel ? (sel.end.col > 0 ? sel.end.line : Math.max(ln, sel.end.line - 1)) : ln
        dedentLines(ln, endLn)
      } else if (sel && sel.start.line !== sel.end.line) {
        const endLn = sel.end.col > 0 ? sel.end.line : Math.max(sel.start.line, sel.end.line - 1)
        indentLines(sel.start.line, endLn)
      } else {
        insertText(INDENT)
      }
      break
    }
    case 'Escape': ghost.value = null; break
    default: break
  }
}

const AUTO_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const CLOSE_CHARS = new Set([')', ']', '}', '"', "'", '`'])

function onInput(): void {
  const ta = textareaEl.value
  if (!ta || composing) return
  const v = ta.value
  if (!v) return
  ta.value = ''

  // Single-char auto-pair logic (skip for paste / multi-char input)
  if (v.length === 1) {
    const closing = AUTO_PAIRS[v]
    if (closing) {
      const sel = selectionRange()
      if (sel && sel.start.line === sel.end.line) {
        // Wrap single-line selection: type `(selection)`
        const inner = model.getValueInRange(sel)
        insertText(v + inner + closing)
        // Reselect inner content
        const end = cursor.value
        anchor.value = { line: end.line, col: end.col - closing.length - inner.length }
        cursor.value = { line: end.line, col: end.col - closing.length }
        return
      } else if (sel) {
        // Multi-line selection: just insert the bracket normally
        insertText(v)
        return
      }
      // Skip if next char is already the same closing bracket
      const c = cursor.value
      const lineText = model.getLine(c.line)
      if (v === '"' || v === "'" || v === '`') {
        if (lineText[c.col] === v) { ghost.value = null; cursor.value = { line: c.line, col: c.col + 1 }; void nextTick(scrollCursorIntoView); return }
      }
      insertText(v + closing)
      cursor.value = { ...cursor.value, col: cursor.value.col - 1 }
      void nextTick(scrollCursorIntoView)
      return
    }
    // Skip over auto-inserted closing char
    if (CLOSE_CHARS.has(v)) {
      const c = cursor.value
      if (model.getLine(c.line)[c.col] === v) {
        ghost.value = null
        cursor.value = { line: c.line, col: c.col + 1 }
        void nextTick(scrollCursorIntoView)
        return
      }
    }
  }

  insertText(v)
}
function onCompositionEnd(): void {
  composing = false
  onInput()
}

function doUndo(): void {
  preferredCol = -1
  ghost.value = null
  const p = undo.undo(model)
  if (p) { _maxLineLenCache = -1; _tokInvalidFrom = 0; cursor.value = p; anchor.value = null; afterChange() }
}
function doRedo(): void {
  preferredCol = -1
  ghost.value = null
  const p = undo.redo(model)
  if (p) { _maxLineLenCache = -1; _tokInvalidFrom = 0; cursor.value = p; anchor.value = null; afterChange() }
}
function selectAll(): void {
  preferredCol = -1
  ghost.value = null
  const last = model.lineCount() - 1
  anchor.value = { line: 0, col: 0 }
  cursor.value = { line: last, col: model.getLine(last).length }
}

// ── Editor commands ───────────────────────────────────────────────────────────
const COMMENT_MAP: Record<string, string> = {
  ts: '//', tsx: '//', js: '//', jsx: '//', vue: '//',
  go: '//', rs: '//', java: '//', kt: '//', swift: '//',
  cpp: '//', c: '//', cs: '//', dart: '//', scala: '//',
  py: '#', rb: '#', sh: '#', bash: '#', yaml: '#', yml: '#', toml: '#', r: '#',
  sql: '--', lua: '--', hs: '--',
}

function toggleLineComment(): void {
  const token = COMMENT_MAP[props.language ?? ''] ?? '//'
  const prefixFull = token + ' '
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line

  const allCommented = Array.from({ length: endLine - startLine + 1 }, (_, i) => {
    const raw = model.getLine(startLine + i).trimStart()
    if (!raw) return true // empty lines don't count against "all commented"
    return raw.startsWith(prefixFull) || raw === token || raw.startsWith(token + '\t')
  }).every(Boolean)

  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null

  const indentLens: number[] = []
  const colDeltas: number[] = []
  const lines: string[] = []
  for (let i = 0; i <= endLine - startLine; i++) {
    const line = model.getLine(startLine + i)
    const indent = line.match(/^(\s*)/)?.[1] ?? ''
    const rest = line.slice(indent.length)
    indentLens.push(indent.length)
    if (allCommented) {
      if (rest.startsWith(prefixFull)) { lines.push(indent + rest.slice(prefixFull.length)); colDeltas.push(-prefixFull.length) }
      else if (rest === token || rest.startsWith(token + '\t')) { lines.push(indent + rest.slice(token.length)); colDeltas.push(-token.length) }
      else { lines.push(line); colDeltas.push(0) }
    } else {
      lines.push(rest ? indent + prefixFull + rest : line)
      colDeltas.push(rest ? prefixFull.length : 0)
    }
  }
  applyEdit(
    { start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } },
    lines.join('\n'),
  )
  cursor.value = _adjCommentPos(savedCursor, startLine, indentLens, colDeltas)
  anchor.value = savedAnchor ? _adjCommentPos(savedAnchor, startLine, indentLens, colDeltas) : null
}

function addLineComment(): void {
  const token = COMMENT_MAP[props.language ?? ''] ?? '//'
  const prefixFull = token + ' '
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1)) : cursor.value.line
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const indentLens: number[] = []
  const colDeltas: number[] = []
  const lines: string[] = []
  for (let i = 0; i <= endLine - startLine; i++) {
    const line = model.getLine(startLine + i)
    const indent = line.match(/^(\s*)/)?.[1] ?? ''
    const rest = line.slice(indent.length)
    const isCommented = rest.startsWith(prefixFull) || rest === token || rest.startsWith(token + '\t')
    indentLens.push(indent.length)
    if (rest && !isCommented) { lines.push(indent + prefixFull + rest); colDeltas.push(prefixFull.length) }
    else { lines.push(line); colDeltas.push(0) }
  }
  applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, lines.join('\n'))
  cursor.value = _adjCommentPos(savedCursor, startLine, indentLens, colDeltas)
  anchor.value = savedAnchor ? _adjCommentPos(savedAnchor, startLine, indentLens, colDeltas) : null
}

function removeLineComment(): void {
  const token = COMMENT_MAP[props.language ?? ''] ?? '//'
  const prefixFull = token + ' '
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1)) : cursor.value.line
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const indentLens: number[] = []
  const colDeltas: number[] = []
  const lines: string[] = []
  for (let i = 0; i <= endLine - startLine; i++) {
    const line = model.getLine(startLine + i)
    const indent = line.match(/^(\s*)/)?.[1] ?? ''
    const rest = line.slice(indent.length)
    indentLens.push(indent.length)
    if (rest.startsWith(prefixFull)) { lines.push(indent + rest.slice(prefixFull.length)); colDeltas.push(-prefixFull.length) }
    else if (rest === token || rest.startsWith(token + '\t')) { lines.push(indent + rest.slice(token.length)); colDeltas.push(-token.length) }
    else { lines.push(line); colDeltas.push(0) }
  }
  applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, lines.join('\n'))
  cursor.value = _adjCommentPos(savedCursor, startLine, indentLens, colDeltas)
  anchor.value = savedAnchor ? _adjCommentPos(savedAnchor, startLine, indentLens, colDeltas) : null
}

function transformToUppercase(): void {
  const sel = selectionRange()
  if (!sel) return
  applyEdit(sel, model.getValueInRange(sel).toUpperCase())
}
function transformToLowercase(): void {
  const sel = selectionRange()
  if (!sel) return
  applyEdit(sel, model.getValueInRange(sel).toLowerCase())
}
function transformToTitleCase(): void {
  const sel = selectionRange()
  if (!sel) return
  const titled = model.getValueInRange(sel).replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  applyEdit(sel, titled)
}
function formatSelection(): void {
  const sel = selectionRange()
  if (!sel) { formatDocument(); return }
  // If selection ends at col 0 (visual end-of-line), exclude that line to match
  // the convention used by toggleLineComment / indentLines.
  const endLine = sel.end.col > 0 ? sel.end.line : Math.max(sel.start.line, sel.end.line - 1)
  const lines: string[] = []
  let changed = false
  for (let i = sel.start.line; i <= endLine; i++) {
    const raw = model.getLine(i)
    const trimmed = raw.trimEnd()
    lines.push(trimmed)
    if (trimmed.length !== raw.length) changed = true
  }
  if (!changed) return
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  applyEdit(
    { start: { line: sel.start.line, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } },
    lines.join('\n'),
  )
  cursor.value = clampPos(savedCursor)
  anchor.value = savedAnchor ? clampPos(savedAnchor) : null
}
function formatDocument(): void {
  const lc = model.lineCount()
  const lines: string[] = []
  for (let i = 0; i < lc; i++) lines.push(model.getLine(i).trimEnd())
  // Ensure single trailing newline, but only for non-empty documents.
  // An empty document stays empty — adding '\n' would corrupt it.
  if (lines.some(l => l !== '')) {
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    lines.push('')
  }
  const newText = lines.join('\n')
  if (newText === model.getValue()) return
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const last = model.lineCount() - 1
  applyEdit(
    { start: { line: 0, col: 0 }, end: { line: last, col: model.getLine(last).length } },
    newText,
  )
  cursor.value = clampPos(savedCursor)
  anchor.value = savedAnchor ? clampPos(savedAnchor) : null
}
function trimTrailingWhitespace(): void {
  const lc = model.lineCount()
  const lines: string[] = []
  let changed = false
  for (let i = 0; i < lc; i++) {
    const line = model.getLine(i)
    const trimmed = line.trimEnd()
    lines.push(trimmed)
    if (trimmed.length < line.length) changed = true
  }
  if (!changed) return
  // Apply as one edit → one undo entry; cursor clamped to trimmed length if it was in trailing whitespace.
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const last = lc - 1
  applyEdit(
    { start: { line: 0, col: 0 }, end: { line: last, col: model.getLine(last).length } },
    lines.join('\n'),
  )
  cursor.value = clampPos(savedCursor)
  anchor.value = savedAnchor ? clampPos(savedAnchor) : null
}
function joinLines(): void {
  const line = cursor.value.line
  if (line >= model.lineCount() - 1) return
  const curText = model.getLine(line)
  const nextText = model.getLine(line + 1)
  if (curText.trim() === '') {
    // Blank line: delete the entire line (col 0 → start of next line col 0)
    applyEdit({ start: { line, col: 0 }, end: { line: line + 1, col: 0 } }, '')
    cursor.value = { line, col: 0 }
    anchor.value = null
    return
  }
  const leadingWs = nextText.length - nextText.trimStart().length
  const separator = nextText.trim() === '' ? '' : ' '
  applyEdit({ start: { line, col: curText.length }, end: { line: line + 1, col: leadingWs } }, separator)
  cursor.value = { line, col: curText.length }
  anchor.value = null
}
function sortLines(dir: 'asc' | 'desc'): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : 0
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : model.lineCount() - 1
  const lines: string[] = []
  for (let i = startLine; i <= endLine; i++) lines.push(model.getLine(i))
  lines.sort((a, b) => dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a))
  applyEdit(
    { start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } },
    lines.join('\n'),
  )
  cursor.value = { line: startLine, col: 0 }
  anchor.value = null
}
function sortLinesAscending(): void { sortLines('asc') }
function sortLinesDescending(): void { sortLines('desc') }
function selectLine(): void {
  ghost.value = null
  preferredCol = -1
  const line = cursor.value.line
  const lastLine = model.lineCount() - 1
  anchor.value = { line, col: 0 }
  cursor.value = line < lastLine ? { line: line + 1, col: 0 } : { line, col: model.getLine(line).length }
}
function transpose(): void {
  const { line, col } = cursor.value
  const text = model.getLine(line)
  if (text.length < 2) return
  const at = col < text.length ? col : col - 1
  if (at < 1) return
  const swapped = text.slice(0, at - 1) + text[at] + text[at - 1] + text.slice(at + 1)
  applyEdit({ start: { line, col: 0 }, end: { line, col: text.length } }, swapped)
  cursor.value = { line, col: Math.min(at + 1, swapped.length) }
  anchor.value = null
}
function indentationToSpaces(): void {
  const totalLines = model.lineCount()
  const lines: string[] = []
  for (let ln = 0; ln < totalLines; ln++) {
    const text = model.getLine(ln)
    let tabs = 0
    while (tabs < text.length && text[tabs] === '\t') tabs++
    lines.push(tabs > 0 ? INDENT.repeat(tabs) + text.slice(tabs) : text)
  }
  applyEdit({ start: { line: 0, col: 0 }, end: { line: totalLines - 1, col: model.getLine(totalLines - 1).length } }, lines.join('\n'))
}
function indentationToTabs(): void {
  const totalLines = model.lineCount()
  const spaceSize = INDENT.length
  const lines: string[] = []
  for (let ln = 0; ln < totalLines; ln++) {
    const text = model.getLine(ln)
    let spaces = 0
    while (spaces < text.length && text[spaces] === ' ') spaces++
    if (spaces < spaceSize) { lines.push(text); continue }
    const tabs = Math.floor(spaces / spaceSize)
    const rem = spaces % spaceSize
    lines.push('\t'.repeat(tabs) + ' '.repeat(rem) + text.slice(spaces))
  }
  applyEdit({ start: { line: 0, col: 0 }, end: { line: totalLines - 1, col: model.getLine(totalLines - 1).length } }, lines.join('\n'))
}
function toggleBlockComment(): void {
  const sel = selectionRange()
  if (!sel) return
  const text = model.getValueInRange(sel)
  const stripped = text.startsWith('/* ') && text.endsWith(' */') ? text.slice(3, -3)
    : text.startsWith('/*') && text.endsWith('*/') ? text.slice(2, -2).trim()
    : null
  if (stripped !== null) {
    applyEdit(sel, stripped)
  } else {
    applyEdit(sel, `/* ${text} */`)
    cursor.value = { line: sel.start.line, col: sel.start.col }
    anchor.value = null
  }
}
function deleteLine(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  const total = model.lineCount()

  if (total === 1) {
    applyEdit({ start: { line: 0, col: 0 }, end: { line: 0, col: model.getLine(0).length } }, '')
    cursor.value = { line: 0, col: 0 }
    anchor.value = null
    return
  }

  if (endLine < total - 1) {
    applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine + 1, col: 0 } }, '')
    cursor.value = clampPos({ line: startLine, col: 0 })
  } else if (startLine > 0) {
    const prevLen = model.getLine(startLine - 1).length
    applyEdit(
      { start: { line: startLine - 1, col: prevLen }, end: { line: endLine, col: model.getLine(endLine).length } },
      '',
    )
    cursor.value = { line: startLine - 1, col: prevLen }
  } else {
    // Deleting all lines from line 0 to end: clear content, leave one empty line.
    applyEdit({ start: { line: 0, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, '')
    cursor.value = { line: 0, col: 0 }
  }
  anchor.value = null
}

function insertLineBelow(): void {
  const line = cursor.value.line
  const lineText = model.getLine(line)
  let indent = ''
  for (const ch of lineText) {
    if (ch === ' ' || ch === '\t') indent += ch
    else break
  }
  applyEdit({ start: { line, col: lineText.length }, end: { line, col: lineText.length } }, '\n' + indent)
}

function insertLineAbove(): void {
  const line = cursor.value.line
  const lineText = model.getLine(line)
  let indent = ''
  for (const ch of lineText) {
    if (ch === ' ' || ch === '\t') indent += ch
    else break
  }
  applyEdit({ start: { line, col: 0 }, end: { line, col: 0 } }, indent + '\n')
  cursor.value = { line, col: indent.length }
}

function moveLineUp(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  if (startLine === 0) return

  const aboveLine = model.getLine(startLine - 1)
  const blockLines = Array.from({ length: endLine - startLine + 1 }, (_, i) => model.getLine(startLine + i))
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null

  applyEdit(
    { start: { line: startLine - 1, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } },
    [...blockLines, aboveLine].join('\n'),
  )
  cursor.value = clampPos({ line: savedCursor.line - 1, col: savedCursor.col })
  anchor.value = savedAnchor ? clampPos({ line: savedAnchor.line - 1, col: savedAnchor.col }) : null
}

function moveLineDown(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  if (endLine >= model.lineCount() - 1) return

  const belowLine = model.getLine(endLine + 1)
  const blockLines = Array.from({ length: endLine - startLine + 1 }, (_, i) => model.getLine(startLine + i))
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null

  applyEdit(
    { start: { line: startLine, col: 0 }, end: { line: endLine + 1, col: model.getLine(endLine + 1).length } },
    [belowLine, ...blockLines].join('\n'),
  )
  cursor.value = clampPos({ line: savedCursor.line + 1, col: savedCursor.col })
  anchor.value = savedAnchor ? clampPos({ line: savedAnchor.line + 1, col: savedAnchor.col }) : null
}

function getWordAtCursor(): string {
  const { line, col } = cursor.value
  const text = model.getLine(line)
  let start = col
  let end = col
  while (start > 0 && isWordChar(text[start - 1])) start--
  while (end < text.length && isWordChar(text[end])) end++
  return text.slice(start, end)
}

function indentLine(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  indentLines(startLine, endLine)
}

function dedentLine(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  dedentLines(startLine, endLine)
}

function cursorTop(): void {
  anchor.value = null
  ghost.value = null
  cursor.value = { line: 0, col: 0 }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

function cursorBottom(): void {
  anchor.value = null
  ghost.value = null
  const lastLine = model.lineCount() - 1
  cursor.value = { line: lastLine, col: model.getLine(lastLine).length }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

const BRACKET_OPEN = new Set(['(', '[', '{'])
const BRACKET_CLOSE = new Set([')', ']', '}'])
const BRACKET_MATCH: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' }

function jumpToBracket(): void {
  ghost.value = null
  const { line, col } = cursor.value
  const lineText = model.getLine(line)

  // Find a bracket at or after cursor on the same line
  let bCol = -1
  let bChar = ''
  for (let c = col; c < lineText.length; c++) {
    const ch = lineText[c]
    if (BRACKET_OPEN.has(ch) || BRACKET_CLOSE.has(ch)) { bCol = c; bChar = ch; break }
  }
  if (bCol === -1) return

  const isOpen = BRACKET_OPEN.has(bChar)
  const matchChar = BRACKET_MATCH[bChar]
  let depth = 0

  if (isOpen) {
    for (let l = line; l < model.lineCount(); l++) {
      const text = model.getLine(l)
      const startC = l === line ? bCol : 0
      for (let c = startC; c < text.length; c++) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { cursor.value = { line: l, col: c }; anchor.value = null; void nextTick(scrollCursorIntoView); return } }
      }
    }
  } else {
    for (let l = line; l >= 0; l--) {
      const text = model.getLine(l)
      const endC = l === line ? bCol : text.length - 1
      for (let c = endC; c >= 0; c--) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { cursor.value = { line: l, col: c }; anchor.value = null; void nextTick(scrollCursorIntoView); return } }
      }
    }
  }
}

function selectToBracket(): void {
  ghost.value = null
  const { line, col } = cursor.value
  const lineText = model.getLine(line)
  let bCol = -1; let bChar = ''
  for (let c = col; c < lineText.length; c++) {
    const ch = lineText[c]
    if (BRACKET_OPEN.has(ch) || BRACKET_CLOSE.has(ch)) { bCol = c; bChar = ch; break }
  }
  if (bCol === -1) return
  const isOpen = BRACKET_OPEN.has(bChar)
  const matchChar = BRACKET_MATCH[bChar]
  let depth = 0
  if (isOpen) {
    for (let l = line; l < model.lineCount(); l++) {
      const text = model.getLine(l)
      const startC = l === line ? bCol : 0
      for (let c = startC; c < text.length; c++) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { anchor.value = { line, col: bCol }; cursor.value = { line: l, col: c + 1 }; void nextTick(scrollCursorIntoView); return } }
      }
    }
  } else {
    for (let l = line; l >= 0; l--) {
      const text = model.getLine(l)
      const endC = l === line ? bCol : text.length - 1
      for (let c = endC; c >= 0; c--) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { anchor.value = { line: l, col: c }; cursor.value = { line, col: bCol + 1 }; void nextTick(scrollCursorIntoView); return } }
      }
    }
  }
}
function duplicateLineDown(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  const blockLen = endLine - startLine + 1
  const lines = Array.from({ length: blockLen }, (_, i) => model.getLine(startLine + i))
  const insertCol = model.getLine(endLine).length
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null

  applyEdit({ start: { line: endLine, col: insertCol }, end: { line: endLine, col: insertCol } }, '\n' + lines.join('\n'))
  cursor.value = clampPos({ line: savedCursor.line + blockLen, col: savedCursor.col })
  anchor.value = savedAnchor ? clampPos({ line: savedAnchor.line + blockLen, col: savedAnchor.col }) : null
}

function duplicateLineUp(): void {
  const sel = selectionRange()
  const startLine = sel ? sel.start.line : cursor.value.line
  const endLine = sel
    ? (sel.end.col > 0 ? sel.end.line : Math.max(startLine, sel.end.line - 1))
    : cursor.value.line
  const blockLen = endLine - startLine + 1
  const lines = Array.from({ length: blockLen }, (_, i) => model.getLine(startLine + i))
  const savedCursor = { ...cursor.value }
  const savedAnchor = anchor.value ? { ...anchor.value } : null

  applyEdit({ start: { line: startLine, col: 0 }, end: { line: startLine, col: 0 } }, lines.join('\n') + '\n')
  // cursor stays on the copy (same line numbers as before)
  cursor.value = savedCursor
  anchor.value = savedAnchor
}

// ── Mouse ────────────────────────────────────────────────────────────────────
function posFromMouse(e: MouseEvent): Position {
  const el = scrollEl.value
  if (!el) return cursor.value
  const rect = el.getBoundingClientRect()
  const y = e.clientY - rect.top + el.scrollTop
  const x = e.clientX - rect.left + el.scrollLeft - gutterWidth.value - PAD_LEFT
  const line = Math.max(0, Math.min(Math.floor(y / lineHeightPx.value), model.lineCount() - 1))
  const col = Math.max(0, Math.min(Math.round(x / charWidth.value), model.getLine(line).length))
  return { line, col }
}

// ── Smart expand / shrink selection (⇧⌥→ / ⇧⌥←) ──────────────────────────
const _selStack: Array<{ anchor: Position | null; cursor: Position }> = []
function expandSelection(): void {
  ghost.value = null
  const cur = cursor.value
  const anc = anchor.value
  const noSel = !anc || (anc.line === cur.line && anc.col === cur.col)
  // Save current state for shrink (only if it differs from the previous saved state)
  const _top = _selStack.length > 0 ? _selStack[_selStack.length - 1] : null
  const _sameAnchor = anc === null ? _top?.anchor === null : (_top?.anchor?.line === anc.line && _top?.anchor?.col === anc.col)
  const _sameCursor = _top?.cursor.line === cur.line && _top?.cursor.col === cur.col
  if (!_top || !_sameAnchor || !_sameCursor) {
    _selStack.push({ anchor: anc ? { ...anc } : null, cursor: { ...cur } })
  }
  if (noSel && getWordAtCursor()) {
    // Step 1: select word under cursor.
    // selectWordAt() only extends FORWARD from col — it misses the cursor-at-word-end
    // case where col is one past the last char. Instead, extend both directions here.
    const text = model.getLine(cur.line)
    let wStart = Math.min(cur.col, text.length)
    let wEnd = wStart
    while (wStart > 0 && isWordChar(text[wStart - 1])) wStart--
    while (wEnd < text.length && isWordChar(text[wEnd])) wEnd++
    anchor.value = { line: cur.line, col: wStart }
    cursor.value = { line: cur.line, col: wEnd }
    return
  }
  // Step 2: expand to whole line (using effective range — cursor pos when no selection)
  const sel = selectionRange()
  const sLine = sel ? sel.start.line : cur.line
  const sCol  = sel ? sel.start.col  : cur.col
  const eLine = sel ? sel.end.line   : cur.line
  const eCol  = sel ? sel.end.col    : cur.col
  const lineText = model.getLine(sLine)
  if (sLine === eLine && (sCol > 0 || eCol < lineText.length)) {
    anchor.value = { line: sLine, col: 0 }
    cursor.value = { line: sLine, col: lineText.length }
    return
  }
  // Step 3: expand to whole document
  anchor.value = { line: 0, col: 0 }
  const last = model.lineCount() - 1
  cursor.value = { line: last, col: model.getLine(last).length }
}
function shrinkSelection(): void {
  ghost.value = null
  if (_selStack.length > 0) {
    const prev = _selStack.pop()!
    anchor.value = prev.anchor ? clampPos(prev.anchor) : null
    cursor.value = clampPos(prev.cursor)
  }
}
function selectWordAt(pos: Position): void {
  preferredCol = -1
  ghost.value = null
  const text = model.getLine(pos.line)
  let start = Math.min(pos.col, text.length)
  let end = start
  if (start < text.length && isWordChar(text[start])) {
    while (start > 0 && isWordChar(text[start - 1])) start--
    while (end < text.length && isWordChar(text[end])) end++
  }
  anchor.value = { line: pos.line, col: start }
  cursor.value = { line: pos.line, col: end }
}

function selectLineAt(lineNum: number): void {
  preferredCol = -1
  ghost.value = null
  anchor.value = { line: lineNum, col: 0 }
  cursor.value = { line: lineNum, col: model.getLine(lineNum).length }
}

let dragging = false
function onMousedown(e: MouseEvent): void {
  if (e.button !== 0) return
  const pos = posFromMouse(e)
  if (e.detail === 3) {
    e.preventDefault(); selectLineAt(pos.line); focus(); return
  }
  if (e.detail === 2) {
    e.preventDefault(); selectWordAt(pos); focus(); return
  }
  moveTo(pos, e.shiftKey)
  dragging = true
  focus()
}
function onMousemove(e: MouseEvent): void {
  if (!dragging) return
  moveTo(posFromMouse(e), true)
}
function onMouseup(): void { dragging = false }

// ── Scroll caret into view ───────────────────────────────────────────────────
function scrollCursorIntoView(): void {
  const el = scrollEl.value
  if (!el) return
  // Vertical
  const top = cursor.value.line * lineHeightPx.value
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + lineHeightPx.value > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + lineHeightPx.value - el.clientHeight
  }
  // Keep vs.scrollTop in sync so the virtual-scroll window updates immediately
  // (scrollLine{Up,Down} do the same explicit assignment; relying solely on the
  // async 'scroll' event risks a one-frame paint with stale virtual rows).
  vs.scrollTop.value = el.scrollTop
  // Horizontal: keep caret within the visible content area
  const caretX = xFor(cursor.value.col)
  const MARGIN = 40
  if (caretX < el.scrollLeft + gutterWidth.value + MARGIN) {
    el.scrollLeft = Math.max(0, caretX - gutterWidth.value - MARGIN)
  } else if (caretX + MARGIN > el.scrollLeft + el.clientWidth) {
    el.scrollLeft = caretX + MARGIN - el.clientWidth
  }
  // Keep scrollLeftVal in sync so the textarea overlay stays aligned with the caret
  // (same reason vs.scrollTop is synced above; the async scroll event is too late).
  scrollLeftVal.value = el.scrollLeft
}

// ── Geometry for caret / selection overlays ──────────────────────────────────
function xFor(col: number): number {
  return gutterWidth.value + PAD_LEFT + col * charWidth.value
}
const caretStyle = computed(() => ({
  left: xFor(cursor.value.col) + 'px',
  height: lineHeightPx.value + 'px',
}))

interface SelRect { left: number; top: number; width: number }
const selectionRects = computed<SelRect[]>(() => {
  const sel = selectionRange()
  if (!sel) return []
  const vStart = vs.startLine.value
  const vEnd = vs.endLine.value
  const rects: SelRect[] = []
  // When selection ends at col 0 of a line, that line has no highlighted content.
  // Use sel.end.line - 1 as the last highlighted line to avoid a misleading 2px sliver.
  const lastHighlightLine = sel.end.col === 0 ? sel.end.line - 1 : sel.end.line
  for (let line = Math.max(sel.start.line, vStart); line <= Math.min(lastHighlightLine, vEnd - 1); line++) {
    const lineLen = model.getLine(line).length
    const startCol = line === sel.start.line ? sel.start.col : 0
    // endCol: when sel.end.col===0, lastHighlightLine < sel.end.line so this always yields lineLen ✓
    const endCol = line === sel.end.line ? sel.end.col : lineLen
    const left = xFor(startCol)
    const width = Math.max(2, (endCol - startCol) * charWidth.value + (line < lastHighlightLine ? charWidth.value : 0))
    rects.push({ left, top: line * lineHeightPx.value, width })
  }
  return rects
})

interface DecRect { id: string; left: number; top: number; width: number; className?: string }
const decorationRects = computed<DecRect[]>(() => {
  version.value // track
  const rects: DecRect[] = []
  for (const d of decorations.value) {
    if (d.type !== 'highlight') continue
    const vStart = vs.startLine.value
    const vEnd = vs.endLine.value
    // Same fix as selectionRects: a range ending at col=0 has no content on that last line.
    const lastHL = d.range.end.col === 0 ? d.range.end.line - 1 : d.range.end.line
    for (let line = Math.max(d.range.start.line, vStart); line <= Math.min(lastHL, vEnd - 1); line++) {
      const startCol = line === d.range.start.line ? d.range.start.col : 0
      const endCol = line === d.range.end.line ? d.range.end.col : model.getLine(line).length
      rects.push({
        id: `${d.id}:${line}`,
        left: xFor(startCol),
        top: line * lineHeightPx.value,
        width: Math.max(4, (endCol - startCol) * charWidth.value),
        className: d.className,
      })
    }
  }
  return rects
})

const ghostStyle = computed(() => {
  if (!ghost.value) return null
  return { left: xFor(ghost.value.pos.col) + 'px' }
})

// ── Lifecycle ────────────────────────────────────────────────────────────────
function measureChar(): void {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;font-size:${fontSizePx.value}px;font-family:ui-monospace,Menlo,monospace;white-space:pre`
  probe.textContent = '0'.repeat(50)
  document.body.appendChild(probe)
  charWidth.value = probe.getBoundingClientRect().width / 50
  probe.remove()
}

watch(fontZoom, () => void nextTick(measureChar))

function onScroll(e: Event): void {
  vs.onScroll(e)
  scrollLeftVal.value = (e.target as HTMLElement).scrollLeft
}

function syncViewport(): void {
  // Keep a sane fallback height when the element is momentarily collapsed
  // (e.g. an inactive tab rendered with display:none) so lines still render
  // until a ResizeObserver delivers the real height.
  const h = scrollEl.value?.clientHeight ?? 0
  if (h > 0) vs.viewportHeight.value = h
}

let ro: ResizeObserver | null = null

onMounted(() => {
  measureChar()
  syncViewport()
  // ResizeObserver fires when the scroll surface gains/changes size — including
  // when an inactive (display:none) tab is first shown — so the viewport height
  // stays correct without relying on window 'resize' events.
  if (typeof ResizeObserver !== 'undefined' && scrollEl.value) {
    ro = new ResizeObserver(syncViewport)
    ro.observe(scrollEl.value)
  }
  window.addEventListener('resize', syncViewport)
  window.addEventListener('mouseup', onMouseup)
})

onUnmounted(() => {
  ro?.disconnect()
  window.removeEventListener('resize', syncViewport)
  window.removeEventListener('mouseup', onMouseup)
})

watch(() => props.modelValue, (v) => {
  if (v !== model.getValue()) {
    model.setValue(v)
    _maxLineLenCache = -1
    _tokCache = []
    _tokInvalidFrom = 0
    cursor.value = clampPos(cursor.value)
    anchor.value = null
    ghost.value = null
    afterExternalChange()
  }
})

watch(cursor, (pos) => emit('cursor-change', { ...pos }))

// ── Imperative API for AI features / host (Phase E/F/G) ───────────────────────
function focus(): void { textareaEl.value?.focus() }
function getValue(): string { return model.getValue() }
function setValue(v: string): void { model.setValue(v); _maxLineLenCache = -1; _tokCache = []; _tokInvalidFrom = 0; cursor.value = { line: 0, col: 0 }; anchor.value = null; ghost.value = null; afterExternalChange() }
function getSelectionRange(): Range | null { return selectionRange() }
function getSelectionText(): string {
  const sel = selectionRange()
  return sel ? model.getValueInRange(sel) : ''
}
function getCursor(): Position { return cursor.value }
function revealLine(line: number): void {
  // `line` is 1-based (search results / external callers); cursor is 0-based.
  ghost.value = null
  cursor.value = clampPos({ line: Math.max(0, line - 1), col: 0 })
  void Promise.resolve().then(() => { scrollCursorIntoView(); focus() })
}
function revealPosition(line: number, col: number): void {
  // 0-based; used internally by find navigation.
  ghost.value = null
  cursor.value = clampPos({ line, col })
  void Promise.resolve().then(() => { scrollCursorIntoView(); focus() })
}
function scrollLineUp(): void {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = Math.max(0, el.scrollTop - lineHeightPx.value)
  vs.scrollTop.value = el.scrollTop
}
function scrollLineDown(): void {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + lineHeightPx.value)
  vs.scrollTop.value = el.scrollTop
}
function setSelection(start: Position, end: Position): void {
  ghost.value = null
  anchor.value = clampPos(start)
  cursor.value = clampPos(end)
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}
function applyEditExternal(range: Range, text: string): void { applyEdit(range, text) }
function setDecorations(d: Decoration[]): void { decorations.value = d }
function setGhost(text: string | null): void {
  ghost.value = text ? { pos: cursor.value, text } : null
}
function acceptGhost(): void {
  if (!ghost.value) return
  const text = ghost.value.text
  ghost.value = null
  insertText(text)
}

function zoomIn(): void { fontZoom.value = Math.min(2.0, Math.round((fontZoom.value + 0.1) * 10) / 10) }
function zoomOut(): void { fontZoom.value = Math.max(0.5, Math.round((fontZoom.value - 0.1) * 10) / 10) }
function zoomReset(): void { fontZoom.value = 1.0 }

defineExpose({
  focus, getValue, setValue, getSelectionRange, getSelectionText, getCursor,
  revealLine, revealPosition, applyEditExternal, setDecorations, setGhost, acceptGhost,
  toggleLineComment, addLineComment, removeLineComment, toggleBlockComment,
  deleteLine, insertLineBelow, insertLineAbove,
  deleteWordLeft, deleteWordRight, deleteLineLeft, deleteLineRight,
  moveLineUp, moveLineDown, getWordAtCursor,
  jumpToBracket, selectToBracket, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine, cursorTop, cursorBottom,
  scrollLineUp, scrollLineDown,
  transformToUppercase, transformToLowercase, transformToTitleCase, trimTrailingWhitespace, formatDocument, formatSelection,
  joinLines,
  sortLinesAscending, sortLinesDescending,
  selectLine,
  transpose, indentationToSpaces, indentationToTabs,
  expandSelection, shrinkSelection,
  setSelection, zoomIn, zoomOut, zoomReset,
  undo: doUndo, redo: doRedo, selectAll,
  insertText,
})
</script>

<template>
  <div class="editor-view" :style="{ '--ev-fs': fontSizePx + 'px', '--ev-lh': lineHeightPx + 'px' }" @mousedown="onMousedown" @mousemove="onMousemove">
    <textarea
      ref="textareaEl"
      class="ev-input"
      :style="{ left: (xFor(cursor.col) - scrollLeftVal) + 'px', top: cursor.line * lineHeightPx - vs.scrollTop.value + 'px' }"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      @keydown="onKeydown"
      @input="onInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
    />
    <div ref="scrollEl" class="ev-scroll" @scroll="onScroll">
      <div class="ev-sizer" :style="{ height: vs.totalHeight.value + 'px', minWidth: sizerMinWidth + 'px' }">
        <div class="ev-slab" :style="{ transform: `translateY(${vs.offsetY.value}px)` }">
          <!-- selection -->
          <div
            v-for="(r, i) in selectionRects"
            :key="'sel' + i"
            class="ev-sel"
            :style="{ left: r.left + 'px', top: (r.top - vs.offsetY.value) + 'px', width: r.width + 'px', height: lineHeightPx + 'px' }"
          />
          <!-- find / decoration highlights -->
          <div
            v-for="r in decorationRects"
            :key="r.id"
            class="ev-dec-highlight"
            :class="r.className"
            :style="{ left: r.left + 'px', top: (r.top - vs.offsetY.value) + 'px', width: r.width + 'px', height: lineHeightPx + 'px' }"
          />
          <!-- lines -->
          <div
            v-for="rl in visibleLines"
            :key="rl.index"
            class="ev-line"
            :style="{ top: (rl.index * lineHeightPx - vs.offsetY.value) + 'px', height: lineHeightPx + 'px' }"
          >
            <span class="ev-gutter" :style="{ width: gutterWidth + 'px' }">{{ rl.index + 1 }}</span>
            <span class="ev-content" :style="{ paddingLeft: PAD_LEFT + 'px' }"><span
              v-for="(s, si) in rl.segments"
              :key="si"
              :class="s.cls"
            >{{ s.text }}</span></span>
          </div>
          <!-- caret -->
          <div class="ev-caret" :style="{ left: caretStyle.left, top: (cursor.line * lineHeightPx - vs.offsetY.value) + 'px', height: caretStyle.height }" />
          <!-- ghost text -->
          <div
            v-if="ghost && ghostStyle"
            class="ev-ghost"
            :style="{ left: ghostStyle.left, top: (ghost.pos.line * lineHeightPx - vs.offsetY.value) + 'px' }"
          >{{ ghost.text }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-view {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: var(--ev-fs, 13px);
  line-height: var(--ev-lh, 19px);
}
.ev-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
}
.ev-sizer { position: relative; width: 100%; }
.ev-slab { position: absolute; top: 0; left: 0; will-change: transform; }
.ev-line {
  position: absolute;
  left: 0;
  display: flex;
  white-space: pre;
}
.ev-gutter {
  flex-shrink: 0;
  position: sticky;
  left: 0;
  z-index: 1;
  text-align: right;
  padding-right: 10px;
  color: var(--text-muted);
  background: var(--bg-base);
  user-select: none;
}
.ev-content { flex: 1; white-space: pre; }
.ev-caret {
  position: absolute;
  width: 2px;
  background: var(--accent-fg);
  animation: ev-blink 1s steps(1) infinite;
}
@keyframes ev-blink { 50% { opacity: 0; } }
.ev-sel {
  position: absolute;
  background: var(--bg-selected);
  pointer-events: none;
}
.ev-dec-highlight {
  position: absolute;
  background: rgba(255, 200, 0, 0.18);
  border: 1px solid rgba(255, 200, 0, 0.4);
  border-radius: 2px;
  pointer-events: none;
  box-sizing: border-box;
}
.ev-dec-current {
  background: rgba(255, 140, 0, 0.38);
  border-color: rgba(255, 140, 0, 0.7);
}
.ev-ghost {
  position: absolute;
  color: var(--text-muted);
  opacity: 0.7;
  white-space: pre;
  pointer-events: none;
  font-style: italic;
}
.ev-input {
  position: absolute;
  width: 1px;
  height: 19px;
  opacity: 0;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  padding: 0;
  z-index: 5;
  font: inherit;
}

/* Syntax token colors → theme --syntax-* vars */
.tok-keyword { color: var(--syntax-keyword); }
.tok-string { color: var(--syntax-string); }
.tok-comment { color: var(--syntax-comment); font-style: italic; }
.tok-number { color: var(--syntax-number); }
.tok-function { color: var(--syntax-function); }
.tok-operator { color: var(--syntax-operator); }
.tok-type { color: var(--syntax-type); }
.tok-variable { color: var(--syntax-variable); }
.tok-invalid { color: var(--syntax-invalid); text-decoration: wavy underline; }
.tok-text { color: var(--text-primary); }
</style>
