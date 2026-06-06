<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { TextModel } from '../model/TextModel'
import { UndoStack } from '../model/UndoStack'
import { tokenizerFor } from '../tokenize/index'
import { useVirtualScroll } from './useVirtualScroll'
import type { Position, Range, Token, Decoration, EditOperation } from '../types'
import { toSnakeCase, toCamelCase, toKebabCase, toPascalCase } from '../textTransforms'

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
const extraCursors = ref<Position[]>([])
const extraAnchors = ref<(Position | null)[]>([])
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
const showLineNumbers = ref(true)
function toggleLineNumbers(): void { showLineNumbers.value = !showLineNumbers.value }
const gutterWidth = computed(() => Math.max(48, String(lineCount.value).length * 9 + 12))
// Sizer minimum width ensures long lines are horizontally scrollable.
// Uses cached max-length: O(1) on pure inserts, O(N) only when cache is invalid.
const sizerMinWidth = computed(() => {
  version.value // track edits
  const max = _maxLineLenCache >= 0 ? _maxLineLenCache : _scanMaxLineLen()
  return gutterWidth.value + PAD_LEFT + max * charWidth.value + 40
})

// ── Fold state (must be before vs so visibleLineCount is available) ──────────
const foldedLines = ref<Set<number>>(new Set())

function _getIndent(line: string): number {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return line.trim() === '' ? -1 : i
}
function _foldRangeEnd(startLine: number): number {
  const startIndent = _getIndent(model.getLine(startLine))
  if (startIndent < 0) return startLine
  let end = startLine
  let foundContent = false
  for (let l = startLine + 1; l < model.lineCount(); l++) {
    const ind = _getIndent(model.getLine(l))
    if (ind < 0) { end = l; continue }
    if (ind > startIndent) { foundContent = true; end = l }
    else break
  }
  return foundContent ? end : startLine
}
function _isFoldable(line: number): boolean {
  return _foldRangeEnd(line) > line
}

// visibleModelLines[displayIndex] = modelLine
const visibleModelLines = computed<number[]>(() => {
  version.value // re-run on edits
  const hidden = new Set<number>()
  for (const startLine of foldedLines.value) {
    const end = _foldRangeEnd(startLine)
    for (let l = startLine + 1; l <= end; l++) hidden.add(l)
  }
  const result: number[] = []
  for (let i = 0; i < model.lineCount(); i++) {
    if (!hidden.has(i)) result.push(i)
  }
  return result
})

const modelToDisplayMap = computed<Map<number, number>>(() => {
  const m = new Map<number, number>()
  visibleModelLines.value.forEach((ml, di) => m.set(ml, di))
  return m
})
function m2d(modelLine: number): number {
  return modelToDisplayMap.value.get(modelLine) ?? modelLine
}

const visibleLineCount = computed(() => {
  version.value
  return visibleModelLines.value.length
})
const vs = useVirtualScroll(visibleLineCount, lineHeightPx)
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
  index: number       // model line index (for line number, gutter icons)
  displayIdx: number  // display index (for top positioning)
  segments: { text: string; cls: string }[]
  foldable: boolean
  folded: boolean
}

const visibleLines = computed<RenderLine[]>(() => {
  version.value // re-render on every edit
  const res: RenderLine[] = []
  for (let di = vs.startLine.value; di < vs.endLine.value; di++) {
    const mi = visibleModelLines.value[di]
    if (mi === undefined) break
    res.push({
      index: mi,
      displayIdx: di,
      segments: segmentsFor(mi),
      foldable: _isFoldable(mi),
      folded: foldedLines.value.has(mi),
    })
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

// ── Multi-cursor edit ────────────────────────────────────────────────────────
// Returns true when multi-cursor was active and all edits were applied.
// getRange is called on the ORIGINAL document state for each cursor (pre-sort).
// Edits are applied bottom-to-top so upper positions stay valid.
// All ops are pushed as a single batch so Cmd+Z undoes them all at once.
function applyMultiCursorEdit(
  getRange: (pos: Position, anch: Position | null) => Range | null,
  text: string,
): boolean {
  if (extraCursors.value.length === 0) return false
  if (props.readonly) return true // multi-cursor active but readonly → consume event
  preferredCol = -1

  type Entry = { range: Range; isPrimary: boolean; extraIdx: number }
  const entries: Entry[] = []
  const pRange = getRange(cursor.value, anchor.value)
  if (pRange) entries.push({ range: pRange, isPrimary: true, extraIdx: -1 })
  for (let i = 0; i < extraCursors.value.length; i++) {
    const r = getRange(extraCursors.value[i], extraAnchors.value[i] ?? null)
    if (r) entries.push({ range: r, isPrimary: false, extraIdx: i })
  }

  entries.sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line
    return b.range.start.col - a.range.start.col
  })

  const newPrimary = { ...cursor.value }
  const newExtras = extraCursors.value.map(p => ({ ...p }))
  const pairs: Array<{ forward: EditOperation; inverse: EditOperation }> = []

  for (const e of entries) {
    const op: EditOperation = { range: e.range, text }
    const { inverse, caret } = model.applyEdit(op)
    pairs.push({ forward: op, inverse })
    if (e.range.start.line < _tokInvalidFrom) _tokInvalidFrom = e.range.start.line
    if (e.isPrimary) { newPrimary.line = caret.line; newPrimary.col = caret.col }
    else { newExtras[e.extraIdx] = caret }
  }
  undo.pushBatch(pairs)

  _maxLineLenCache = -1
  cursor.value = newPrimary
  anchor.value = null
  extraCursors.value = newExtras
  extraAnchors.value = newExtras.map(() => null)
  ghost.value = null
  afterChange()
  return true
}

function insertText(text: string): void {
  if (applyMultiCursorEdit((pos, anch) => {
    const r = anch ? (comparePos(anch, pos) <= 0 ? { start: anch, end: pos } : { start: pos, end: anch }) : null
    return r ?? { start: pos, end: pos }
  }, text)) return
  const sel = selectionRange()
  const range = sel ?? { start: cursor.value, end: cursor.value }
  applyEdit(range, text)
}

function deleteBackward(): void {
  if (applyMultiCursorEdit((pos, anch) => {
    if (anch) return comparePos(anch, pos) <= 0 ? { start: anch, end: pos } : { start: pos, end: anch }
    if (pos.col > 0) return { start: { line: pos.line, col: pos.col - 1 }, end: pos }
    if (pos.line > 0) { const prevLen = model.getLine(pos.line - 1).length; return { start: { line: pos.line - 1, col: prevLen }, end: pos } }
    return null
  }, '')) return
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
  if (applyMultiCursorEdit((pos, anch) => {
    if (anch) return comparePos(anch, pos) <= 0 ? { start: anch, end: pos } : { start: pos, end: anch }
    const lineLen = model.getLine(pos.line).length
    if (pos.col < lineLen) return { start: pos, end: { line: pos.line, col: pos.col + 1 } }
    if (pos.line < model.lineCount() - 1) return { start: pos, end: { line: pos.line + 1, col: 0 } }
    return null
  }, '')) return
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
  _triggerSuggest()
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
  _clearExtraCursors()
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
    if (preferredCol < 0) preferredCol = visColFromOffset(model.getLine(line), col, tabSize.value)
    line = Math.max(0, Math.min(line + dLine, model.lineCount() - 1))
    col = offsetFromVisCol(model.getLine(line), preferredCol, tabSize.value)
  }
  cursor.value = { line, col }
  // Auto-unfold if cursor lands on a hidden line
  if (modelToDisplayMap.value.get(cursor.value.line) === undefined) {
    for (const fl of foldedLines.value) {
      const end = _foldRangeEnd(fl)
      if (cursor.value.line > fl && cursor.value.line <= end) {
        unfoldAt(fl)
        break
      }
    }
  }
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
  _clearExtraCursors()
  preferredCol = -1
  ghost.value = null
  startOrClearSelection(extend)
  const line = model.getLine(cursor.value.line)
  let indent = 0
  while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) indent++
  cursor.value = { line: cursor.value.line, col: cursor.value.col === indent ? 0 : indent }
}
function endKey(extend: boolean): void {
  _clearExtraCursors()
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
const tabSize = ref(2)
const useSpaces = ref(true)
const INDENT = computed(() => useSpaces.value ? ' '.repeat(tabSize.value) : '\t')

function visColFromOffset(lineText: string, col: number, ts: number): number {
  let vis = 0
  const end = Math.min(col, lineText.length)
  for (let i = 0; i < end; i++) {
    vis += lineText[i] === '\t' ? ts - (vis % ts) : 1
  }
  return vis
}
function offsetFromVisCol(lineText: string, targetVis: number, ts: number): number {
  let vis = 0
  for (let i = 0; i < lineText.length; i++) {
    if (vis >= targetVis) return i
    vis += lineText[i] === '\t' ? ts - (vis % ts) : 1
  }
  return lineText.length
}

function indentLines(startLine: number, endLine: number): void {
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const savedCursor = { ...cursor.value }
  const indent = INDENT.value
  const newContent = Array.from({ length: endLine - startLine + 1 }, (_, i) =>
    indent + model.getLine(startLine + i),
  ).join('\n')
  applyEdit({ start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } }, newContent)
  // Restore selection shifted by indent.length on each affected line.
  // Guard: only shift positions within [startLine, endLine], matching dedentLines' anchorIdx logic.
  anchor.value = savedAnchor && savedAnchor.line >= startLine && savedAnchor.line <= endLine
    ? { line: savedAnchor.line, col: savedAnchor.col + indent.length }
    : savedAnchor
  cursor.value = savedCursor.line >= startLine && savedCursor.line <= endLine
    ? { line: savedCursor.line, col: savedCursor.col + indent.length }
    : savedCursor
}

function dedentLines(startLine: number, endLine: number): void {
  const savedAnchor = anchor.value ? { ...anchor.value } : null
  const savedCursor = { ...cursor.value }
  const removals: number[] = []
  const newContent = Array.from({ length: endLine - startLine + 1 }, (_, i) => {
    const line = model.getLine(startLine + i)
    let removed = 0
    while (removed < INDENT.value.length && line[removed] === ' ') removed++
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
  // Suggest dropdown intercepts
  if (suggestOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); suggestIdx.value = (suggestIdx.value + 1) % suggestItems.value.length; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); suggestIdx.value = (suggestIdx.value - 1 + suggestItems.value.length) % suggestItems.value.length; return }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); _acceptSuggest(); return }
    if (e.key === 'Escape') { e.preventDefault(); _closeSuggest(); return }
  }
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
        applyEdit({ start: c, end: c }, '\n' + indent + INDENT.value + '\n' + indent)
        cursor.value = { line: c.line + 1, col: indent.length + INDENT.value.length }
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
        insertText(INDENT.value)
      }
      break
    }
    case 'Escape': ghost.value = null; _closeSuggest(); break
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
  _clearExtraCursors()
  const p = undo.undo(model)
  if (p) { _maxLineLenCache = -1; _tokInvalidFrom = 0; cursor.value = p; anchor.value = null; afterChange() }
}
function doRedo(): void {
  preferredCol = -1
  ghost.value = null
  _clearExtraCursors()
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
function transformToSnakeCase(): void {
  const sel = selectionRange(); if (!sel) return
  applyEdit(sel, toSnakeCase(model.getValueInRange(sel)))
}
function transformToCamelCase(): void {
  const sel = selectionRange(); if (!sel) return
  applyEdit(sel, toCamelCase(model.getValueInRange(sel)))
}
function transformToKebabCase(): void {
  const sel = selectionRange(); if (!sel) return
  applyEdit(sel, toKebabCase(model.getValueInRange(sel)))
}
function transformToPascalCase(): void {
  const sel = selectionRange(); if (!sel) return
  applyEdit(sel, toPascalCase(model.getValueInRange(sel)))
}
function transformToBase64(): void {
  const sel = selectionRange(); if (!sel) return
  const bytes = new TextEncoder().encode(model.getValueInRange(sel))
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  applyEdit(sel, btoa(binary))
}
function transformFromBase64(): boolean {
  const sel = selectionRange(); if (!sel) return true
  try {
    const binary = atob(model.getValueInRange(sel).trim())
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    applyEdit(sel, new TextDecoder().decode(bytes)); return true
  } catch { return false }
}
function transformToUrlEncoded(): void {
  const sel = selectionRange(); if (!sel) return
  applyEdit(sel, encodeURIComponent(model.getValueInRange(sel)))
}
function transformFromUrlEncoded(): boolean {
  const sel = selectionRange(); if (!sel) return true
  try { applyEdit(sel, decodeURIComponent(model.getValueInRange(sel))); return true }
  catch { return false }
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
function reverseLines(): void {
  const range = selectionRange()
  const startL = range ? range.start.line : 0
  const endL = range ? (range.end.col > 0 ? range.end.line : Math.max(range.start.line, range.end.line - 1)) : model.lineCount() - 1
  const lines: string[] = []
  for (let i = startL; i <= endL; i++) lines.push(model.getLine(i))
  lines.reverse()
  applyEdit({ start: { line: startL, col: 0 }, end: { line: endL, col: model.getLine(endL).length } }, lines.join('\n'))
  cursor.value = { line: startL, col: 0 }; anchor.value = null
}
function removeDuplicateLines(): void {
  const range = selectionRange()
  const startL = range ? range.start.line : 0
  const endL = range ? (range.end.col > 0 ? range.end.line : Math.max(range.start.line, range.end.line - 1)) : model.lineCount() - 1
  const seen = new Set<string>(); const unique: string[] = []
  for (let i = startL; i <= endL; i++) { const l = model.getLine(i); if (!seen.has(l)) { seen.add(l); unique.push(l) } }
  applyEdit({ start: { line: startL, col: 0 }, end: { line: endL, col: model.getLine(endL).length } }, unique.join('\n'))
  cursor.value = { line: startL, col: 0 }; anchor.value = null
}
function openLinkAtCursor(): boolean {
  const line = model.getLine(cursor.value.line); const col = cursor.value.col
  const urlRe = /https?:\/\/[^\s"'<>)\]]+/g; let m: RegExpExecArray | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  while ((m = urlRe.exec(line)) !== null) {
    if (col >= m.index && col <= m.index + m[0].length) {
      if (w.agentTeam?.openExternal) void w.agentTeam.openExternal(m[0])
      else window.open(m[0], '_blank', 'noopener,noreferrer')
      return true
    }
  }
  return false
}
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
    lines.push(tabs > 0 ? INDENT.value.repeat(tabs) + text.slice(tabs) : text)
  }
  applyEdit({ start: { line: 0, col: 0 }, end: { line: totalLines - 1, col: model.getLine(totalLines - 1).length } }, lines.join('\n'))
}
function indentationToTabs(): void {
  const totalLines = model.lineCount()
  const spaceSize = INDENT.value.length
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
  _clearExtraCursors()
  anchor.value = null
  ghost.value = null
  cursor.value = { line: 0, col: 0 }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

function cursorBottom(): void {
  _clearExtraCursors()
  anchor.value = null
  ghost.value = null
  const lastLine = model.lineCount() - 1
  cursor.value = { line: lastLine, col: model.getLine(lastLine).length }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

function cursorTopSelect(): void {
  ghost.value = null; startOrClearSelection(true)
  cursor.value = { line: 0, col: 0 }; preferredCol = -1
  void nextTick(scrollCursorIntoView)
}
function cursorBottomSelect(): void {
  ghost.value = null; startOrClearSelection(true)
  const lastLine = model.lineCount() - 1
  cursor.value = { line: lastLine, col: model.getLine(lastLine).length }; preferredCol = -1
  void nextTick(scrollCursorIntoView)
}
function cursorWordLeft(): void { moveWordLeft(false) }
function cursorWordRight(): void { moveWordRight(false) }
function cursorWordLeftSelect(): void { moveWordLeft(true) }
function cursorWordRightSelect(): void { moveWordRight(true) }
function cursorLineStart(): void { homeKey(false) }
function cursorLineEnd(): void { endKey(false) }
function cursorLineStartSelect(): void { homeKey(true) }
function cursorLineEndSelect(): void { endKey(true) }
function selectCurrentWord(): void { ghost.value = null; selectWordAt(cursor.value) }
function setTabSize(size: number): void { tabSize.value = Math.max(1, Math.min(8, size)) }
function setUseSpaces(spaces: boolean): void { useSpaces.value = spaces }
function getTabSize(): number { return tabSize.value }
function getUseSpaces(): boolean { return useSpaces.value }

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
  const di = Math.max(0, Math.min(Math.floor(y / lineHeightPx.value), visibleModelLines.value.length - 1))
  const line = visibleModelLines.value[di] ?? model.lineCount() - 1
  const lineText = model.getLine(line)
  if (!lineText.includes('\t')) {
    const col = Math.max(0, Math.min(Math.round(x / charWidth.value), lineText.length))
    return { line, col }
  }
  // Tab-aware: convert pixel x to visual column, then to model offset
  const targetVis = x / charWidth.value
  const col = offsetFromVisCol(lineText, targetVis, tabSize.value)
  return { line, col }
}

// ── Smart expand / shrink selection (⇧⌥→ / ⇧⌥←) ──────────────────────────
const _selStack: Array<{ anchor: Position | null; cursor: Position }> = []
function expandSelection(): void {
  ghost.value = null
  const cur = cursor.value
  const anc = anchor.value
  const noSel = !anc || (anc.line === cur.line && anc.col === cur.col)
  // Save current state for shrink
  _selStack.push({ anchor: anc ? { ...anc } : null, cursor: { ...cur } })
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
  // Alt+Click: add/remove an extra cursor (VS Code behavior).
  if (e.altKey) {
    e.preventDefault()
    const idx = extraCursors.value.findIndex(c => c.line === pos.line && c.col === pos.col)
    if (idx !== -1) {
      const next = [...extraCursors.value]; next.splice(idx, 1)
      const nextA = [...extraAnchors.value]; nextA.splice(idx, 1)
      extraCursors.value = next; extraAnchors.value = nextA
    } else {
      extraCursors.value = [...extraCursors.value, clampPos(pos)]
      extraAnchors.value = [...extraAnchors.value, null]
    }
    focus(); return
  }
  // Plain click clears extra cursors (VS Code clears multi-cursor on single click).
  if (!e.shiftKey) _clearExtraCursors()
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
  // Vertical: use display index so folded lines don't push caret off-screen
  const displayLine = m2d(cursor.value.line)
  const top = displayLine * lineHeightPx.value
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + lineHeightPx.value > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + lineHeightPx.value - el.clientHeight
  }
  // Keep vs.scrollTop in sync so the virtual-scroll window updates immediately
  // (scrollLine{Up,Down} do the same explicit assignment; relying solely on the
  // async 'scroll' event risks a one-frame paint with stale virtual rows).
  vs.scrollTop.value = el.scrollTop
  // Horizontal: keep caret within the visible content area
  const caretX = xForLine(cursor.value.line, cursor.value.col)
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
// xFor: fast path for space-only lines (col == visual col).
function xFor(col: number): number {
  return gutterWidth.value + PAD_LEFT + col * charWidth.value
}
// xForLine: tab-aware pixel position for a given (model line, col).
function xForLine(line: number, col: number): number {
  const text = model.getLine(line)
  if (!text.includes('\t')) return xFor(col)
  return gutterWidth.value + PAD_LEFT + visColFromOffset(text, col, tabSize.value) * charWidth.value
}
const caretStyle = computed(() => ({
  left: xForLine(cursor.value.line, cursor.value.col) + 'px',
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
  const lastHighlightModel = sel.end.col === 0 ? sel.end.line - 1 : sel.end.line
  for (let di = vStart; di < vEnd; di++) {
    const line = visibleModelLines.value[di]
    if (line === undefined) break
    if (line < sel.start.line || line > lastHighlightModel) continue
    const lineLen = model.getLine(line).length
    const startCol = line === sel.start.line ? sel.start.col : 0
    const endCol = line === sel.end.line ? sel.end.col : lineLen
    const left = xForLine(line, startCol)
    const rightEdge = xForLine(line, endCol) + (line < lastHighlightModel ? charWidth.value : 0)
    const width = Math.max(2, rightEdge - left)
    rects.push({ left, top: di * lineHeightPx.value, width })
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
    for (let di = vStart; di < vEnd; di++) {
      const line = visibleModelLines.value[di]
      if (line === undefined) break
      if (line < d.range.start.line || line > lastHL) continue
      const startCol = line === d.range.start.line ? d.range.start.col : 0
      const endCol = line === d.range.end.line ? d.range.end.col : model.getLine(line).length
      rects.push({
        id: `${d.id}:${line}`,
        left: xForLine(line, startCol),
        top: di * lineHeightPx.value,
        width: Math.max(4, xForLine(line, endCol) - xForLine(line, startCol)),
        className: d.className,
      })
    }
  }
  return rects
})

const ghostStyle = computed(() => {
  if (!ghost.value) return null
  return { left: xForLine(ghost.value.pos.line, ghost.value.pos.col) + 'px' }
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
  if (suggestOpen.value) _closeSuggest()
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
  if (_suggestTimer !== null) { clearTimeout(_suggestTimer); _suggestTimer = null }
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

// ── Bracket pair highlight ────────────────────────────────────────────────────
const _BRACKET_DEC_IDS = ['bracket-left', 'bracket-right']
watch([cursor, version], () => {
  const { line, col } = cursor.value
  // Try cursor position then one before
  let bLine = line, bCol = -1, bChar = ''
  for (const c of [col, col - 1]) {
    if (c < 0) continue
    const ch = (model.getLine(line) ?? '')[c]
    if (ch && (BRACKET_OPEN.has(ch) || BRACKET_CLOSE.has(ch))) {
      // Skip if inside string/comment token
      _ensureTokensUpTo(line)
      const toks = _tokCache[line]?.tokens ?? []
      let inStrCmt = false
      for (const tok of toks) {
        if (tok.start <= c && c < tok.end && (tok.type === 'string' || tok.type === 'comment')) {
          inStrCmt = true; break
        }
      }
      if (!inStrCmt) { bCol = c; bChar = ch; break }
    }
  }
  if (bCol === -1) {
    const cur = decorations.value.filter(d => !_BRACKET_DEC_IDS.includes(d.id))
    if (cur.length !== decorations.value.length) decorations.value = cur
    return
  }
  const isOpen = BRACKET_OPEN.has(bChar)
  const matchChar = BRACKET_MATCH[bChar]
  let depth = 0
  let mLine = -1, mCol = -1
  if (isOpen) {
    outer: for (let l = bLine; l < model.lineCount(); l++) {
      const text = model.getLine(l)
      const startC = l === bLine ? bCol : 0
      for (let c = startC; c < text.length; c++) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { mLine = l; mCol = c; break outer } }
      }
    }
  } else {
    outer: for (let l = bLine; l >= 0; l--) {
      const text = model.getLine(l)
      const endC = l === bLine ? bCol : text.length - 1
      for (let c = endC; c >= 0; c--) {
        const ch = text[c]
        if (ch === bChar) depth++
        else if (ch === matchChar) { depth--; if (depth === 0) { mLine = l; mCol = c; break outer } }
      }
    }
  }
  const nonBracket = decorations.value.filter(d => !_BRACKET_DEC_IDS.includes(d.id))
  if (mLine === -1) {
    if (nonBracket.length !== decorations.value.length) decorations.value = nonBracket
    return
  }
  decorations.value = [
    ...nonBracket,
    { id: 'bracket-left',  type: 'highlight' as const, range: { start: { line: bLine, col: bCol }, end: { line: bLine, col: bCol + 1 } }, className: 'bracket-match' },
    { id: 'bracket-right', type: 'highlight' as const, range: { start: { line: mLine, col: mCol }, end: { line: mLine, col: mCol + 1 } }, className: 'bracket-match' },
  ]
}, { flush: 'post' })

// ── Suggest (completions) dropdown ────────────────────────────────────────────
const suggestOpen = ref(false)
const suggestItems = ref<string[]>([])
const suggestIdx = ref(0)
let _suggestTimer: number | null = null

const suggestStyle = computed(() => {
  // Inside ev-slab (scrollable), so no scrollLeftVal subtraction needed
  const x = xForLine(cursor.value.line, cursor.value.col)
  // Same coordinate system as ghost text: (model line → display line) * lh - offsetY
  const lineY = m2d(cursor.value.line) * lineHeightPx.value - vs.offsetY.value
  // viewport-relative cursor top (used to decide whether to flip above)
  const viewportCursorY = lineY + vs.offsetY.value - vs.scrollTop.value
  const dropdownHeight = 152
  const shouldFlip = vs.viewportHeight.value - viewportCursorY - lineHeightPx.value < dropdownHeight && viewportCursorY > dropdownHeight
  const y = shouldFlip ? lineY - dropdownHeight : lineY + lineHeightPx.value
  return { left: Math.max(0, x) + 'px', top: Math.max(0, y) + 'px' }
})

function _closeSuggest(): void {
  suggestOpen.value = false
  suggestItems.value = []
}

function _acceptSuggest(): void {
  const item = suggestItems.value[suggestIdx.value]
  if (!item) { _closeSuggest(); return }
  const { line, col } = cursor.value
  const lineText = model.getLine(line)
  let wordStart = col
  while (wordStart > 0 && isWordChar(lineText[wordStart - 1])) wordStart--
  _closeSuggest()
  applyEdit({ start: { line, col: wordStart }, end: { line, col } }, item)
}

function _triggerSuggest(): void {
  if (_suggestTimer !== null) { clearTimeout(_suggestTimer); _suggestTimer = null }
  _suggestTimer = window.setTimeout(() => {
    _suggestTimer = null
    if (composing || props.readonly) { _closeSuggest(); return }
    const word = getWordAtCursor()
    if (!word || word.length < 2) { _closeSuggest(); return }
    // Skip inside string/comment
    const { line, col } = cursor.value
    _ensureTokensUpTo(line)
    for (const tok of (_tokCache[line]?.tokens ?? [])) {
      if (tok.start < col && col <= tok.end) {
        if (tok.type === 'string' || tok.type === 'comment') { _closeSuggest(); return }
      }
    }
    const lower = word.toLowerCase()
    const seen = new Set<string>()
    const items: string[] = []
    for (let i = 0; i < model.lineCount() && items.length < 20; i++) {
      for (const m of model.getLine(i).matchAll(/[a-zA-Z_]\w{2,}/g)) {
        const w = m[0]
        if (w !== word && !seen.has(w) && w.toLowerCase().startsWith(lower)) {
          seen.add(w); items.push(w)
        }
      }
    }
    if (!items.length) { _closeSuggest(); return }
    suggestItems.value = items.sort((a, b) => a.length - b.length || a.localeCompare(b))
    suggestIdx.value = 0
    suggestOpen.value = true
  }, 150)
}

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

// ── Fold operations ───────────────────────────────────────────────────────────
function foldAt(line: number): void {
  if (!_isFoldable(line)) return
  foldedLines.value = new Set([...foldedLines.value, line])
}
function unfoldAt(line: number): void {
  const s = new Set(foldedLines.value)
  s.delete(line)
  foldedLines.value = s
}
function toggleFoldAt(line: number): void {
  if (foldedLines.value.has(line)) unfoldAt(line)
  else foldAt(line)
}
function foldAll(): void {
  const s = new Set<number>()
  for (let l = 0; l < model.lineCount(); l++) {
    if (_isFoldable(l)) s.add(l)
  }
  foldedLines.value = s
}
function unfoldAll(): void { foldedLines.value = new Set() }
function foldToLevel(n: number): void {
  const ts = tabSize.value || 2
  const s = new Set<number>()
  for (let l = 0; l < model.lineCount(); l++) {
    const ind = _getIndent(model.getLine(l))
    if (ind >= 0 && Math.floor(ind / ts) < n && _isFoldable(l)) s.add(l)
  }
  foldedLines.value = s
}
function foldRecursively(line: number): void {
  const end = _foldRangeEnd(line)
  const s = new Set(foldedLines.value)
  for (let l = line; l <= end; l++) {
    if (_isFoldable(l)) s.add(l)
  }
  foldedLines.value = s
}
function unfoldRecursively(line: number): void {
  const end = _foldRangeEnd(line)
  const s = new Set(foldedLines.value)
  for (let l = line; l <= end; l++) s.delete(l)
  foldedLines.value = s
}

// ── Multi-cursor ─────────────────────────────────────────────────────────────
function _clearExtraCursors(): void {
  extraCursors.value = []
  extraAnchors.value = []
}

function insertCursorAbove(): void {
  const c = cursor.value
  if (c.line <= 0) return
  const newLine = c.line - 1
  const newPos: Position = { line: newLine, col: Math.min(c.col, model.getLine(newLine).length) }
  if (extraCursors.value.some(e => e.line === newPos.line && e.col === newPos.col)) return
  extraCursors.value = [...extraCursors.value, newPos]
  extraAnchors.value = [...extraAnchors.value, null]
}

function insertCursorBelow(): void {
  const c = cursor.value
  if (c.line >= model.lineCount() - 1) return
  const newLine = c.line + 1
  const newPos: Position = { line: newLine, col: Math.min(c.col, model.getLine(newLine).length) }
  if (extraCursors.value.some(e => e.line === newPos.line && e.col === newPos.col)) return
  extraCursors.value = [...extraCursors.value, newPos]
  extraAnchors.value = [...extraAnchors.value, null]
}

// Ctrl+D: select next occurrence of the current word / selected text (VS Code: Add Selection to Next Find Match).
function selectNextOccurrence(): void {
  const sel = selectionRange()
  let searchWord: string
  let searchStart: Position

  if (sel && comparePos(sel.start, sel.end) !== 0) {
    // There is a selection. If it's multi-line, bail out.
    if (sel.start.line !== sel.end.line) return
    searchWord = model.getLine(sel.start.line).slice(sel.start.col, sel.end.col)
    searchStart = sel.end
  } else {
    // No selection — select the word at cursor first.
    const word = getWordAtCursor()
    if (!word) return
    const { line, col } = cursor.value
    const text = model.getLine(line)
    let wStart = col
    while (wStart > 0 && isWordChar(text[wStart - 1])) wStart--
    anchor.value = { line, col: wStart }
    cursor.value = { line, col: wStart + word.length }
    return
  }

  // Find next occurrence after searchStart (wraps around).
  const lc = model.lineCount()
  for (let pass = 0; pass < 2; pass++) {
    const startL = pass === 0 ? searchStart.line : 0
    for (let l = startL; l < lc; l++) {
      const text = model.getLine(l)
      const startC = l === searchStart.line && pass === 0 ? searchStart.col : 0
      const idx = text.indexOf(searchWord, startC)
      if (idx === -1) continue
      // Skip if this range is already selected by an extra cursor.
      const alreadyCovered = extraCursors.value.some(
        (ec, ei) => ec.line === l && ec.col === idx + searchWord.length &&
          extraAnchors.value[ei]?.line === l && extraAnchors.value[ei]?.col === idx
      )
      if (alreadyCovered) continue
      // Also skip the primary selection.
      if (l === sel.start.line && idx === sel.start.col) continue
      // Add as extra selection.
      extraCursors.value = [...extraCursors.value, { line: l, col: idx + searchWord.length }]
      extraAnchors.value = [...extraAnchors.value, { line: l, col: idx }]
      void nextTick(() => revealPosition({ line: l, col: idx + searchWord.length }))
      return
    }
  }
}

function addCursorsToLineEnds(): void {
  const sel = selectionRange()
  if (!sel || sel.start.line === sel.end.line) return
  const newCursors: Position[] = []
  for (let l = sel.start.line; l <= sel.end.line; l++) {
    newCursors.push({ line: l, col: model.getLine(l).length })
  }
  cursor.value = newCursors[0]
  anchor.value = null
  extraCursors.value = newCursors.slice(1)
  extraAnchors.value = newCursors.slice(1).map(() => null)
}

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
  transformToUppercase, transformToLowercase, transformToTitleCase,
  transformToSnakeCase, transformToCamelCase, transformToKebabCase, transformToPascalCase,
  transformToBase64, transformFromBase64, transformToUrlEncoded, transformFromUrlEncoded,
  trimTrailingWhitespace, formatDocument, formatSelection,
  joinLines,
  sortLinesAscending, sortLinesDescending,
  reverseLines, removeDuplicateLines, openLinkAtCursor,
  selectLine,
  transpose, indentationToSpaces, indentationToTabs,
  expandSelection, shrinkSelection,
  setSelection, zoomIn, zoomOut, zoomReset, toggleLineNumbers,
  undo: doUndo, redo: doRedo, selectAll,
  insertText,
  cursorWordLeft, cursorWordRight, cursorWordLeftSelect, cursorWordRightSelect,
  cursorTopSelect, cursorBottomSelect,
  cursorLineStart, cursorLineEnd, cursorLineStartSelect, cursorLineEndSelect,
  selectCurrentWord,
  setTabSize, setUseSpaces, getTabSize, getUseSpaces,
  foldAt, unfoldAt, toggleFoldAt, foldAll, unfoldAll, foldToLevel, foldRecursively, unfoldRecursively,
  insertCursorAbove, insertCursorBelow, addCursorsToLineEnds, selectNextOccurrence,
  getCursorLine: () => cursor.value.line,
})
</script>

<template>
  <div class="editor-view" :style="{ '--ev-fs': fontSizePx + 'px', '--ev-lh': lineHeightPx + 'px' }" @mousedown="onMousedown" @mousemove="onMousemove">
    <textarea
      ref="textareaEl"
      class="ev-input"
      :style="{ left: (xForLine(cursor.line, cursor.col) - scrollLeftVal) + 'px', top: m2d(cursor.line) * lineHeightPx - vs.scrollTop.value + 'px' }"
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
            :class="{ 'ev-line--active': rl.index === cursor.line }"
            :style="{ top: (rl.displayIdx * lineHeightPx - vs.offsetY.value) + 'px', height: lineHeightPx + 'px' }"
          >
            <span class="ev-gutter" :style="{ width: gutterWidth + 'px' }">
              <span v-if="rl.foldable || rl.folded" class="ev-fold-icon" @click.stop="toggleFoldAt(rl.index)">{{ rl.folded ? '▶' : '▼' }}</span><template v-if="showLineNumbers">{{ rl.index + 1 }}</template></span>
            <span class="ev-content" :style="{ paddingLeft: PAD_LEFT + 'px', tabSize: tabSize }"><span
              v-for="(s, si) in rl.segments"
              :key="si"
              :class="s.cls"
            >{{ s.text }}</span><span v-if="rl.folded" class="ev-fold-ellipsis">…</span></span>
          </div>
          <!-- caret -->
          <div class="ev-caret" :style="{ left: caretStyle.left, top: (m2d(cursor.line) * lineHeightPx - vs.offsetY.value) + 'px', height: caretStyle.height }" />
          <!-- extra carets (multi-cursor) -->
          <div
            v-for="(ec, ei) in extraCursors"
            :key="'ec' + ei"
            class="ev-caret"
            :style="{ left: xForLine(ec.line, ec.col) + 'px', top: (m2d(ec.line) * lineHeightPx - vs.offsetY.value) + 'px', height: caretStyle.height }"
          />
          <!-- ghost text -->
          <div
            v-if="ghost && ghostStyle"
            class="ev-ghost"
            :style="{ left: ghostStyle.left, top: (m2d(ghost.pos.line) * lineHeightPx - vs.offsetY.value) + 'px' }"
          >{{ ghost.text }}</div>
          <!-- suggest dropdown -->
          <div
            v-if="suggestOpen && suggestItems.length"
            class="ev-suggest"
            :style="suggestStyle"
          >
            <div
              v-for="(item, i) in suggestItems"
              :key="item"
              class="ev-suggest-item"
              :class="{ active: i === suggestIdx }"
              @mousedown.prevent="suggestIdx = i; _acceptSuggest()"
            >{{ item }}</div>
          </div>
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
.ev-fold-icon {
  cursor: pointer;
  padding: 0 3px;
  opacity: 0.5;
  font-size: 0.7em;
  user-select: none;
}
.ev-fold-icon:hover { opacity: 1; }
.ev-fold-ellipsis {
  color: var(--text-muted);
  opacity: 0.6;
  font-style: italic;
  margin-left: 4px;
}
.bracket-match {
  background: rgba(100, 160, 255, 0.22);
  border: 1px solid rgba(100, 160, 255, 0.6);
  border-radius: 2px;
}
.ev-suggest {
  position: absolute;
  z-index: 20;
  background: var(--bg-panel, #1e1e2e);
  border: 1px solid var(--border-color, #3a3a5c);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.45);
  min-width: 160px;
  max-width: 320px;
  max-height: 152px;
  overflow-y: auto;
  font-size: var(--ev-fs);
}
.ev-suggest-item {
  padding: 2px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  color: var(--text-primary);
}
.ev-suggest-item.active, .ev-suggest-item:hover {
  background: var(--accent, #5a9eff);
  color: #fff;
}
</style>
