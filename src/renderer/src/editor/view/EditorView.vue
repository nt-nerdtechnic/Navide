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

const lineCount = computed(() => {
  version.value // track
  return model.lineCount()
})
// Gutter grows to accommodate the widest line number (e.g. ≥1000 lines needs 4 digits).
const gutterWidth = computed(() => Math.max(48, String(lineCount.value).length * 9 + 12))
// Sizer minimum width ensures long lines are horizontally scrollable.
const sizerMinWidth = computed(() => {
  version.value // track edits
  let max = 0
  for (let i = 0; i < model.lineCount(); i++) {
    const len = model.getLine(i).length
    if (len > max) max = len
  }
  return gutterWidth.value + PAD_LEFT + max * charWidth.value + 40
})

const vs = useVirtualScroll(lineCount, LINE_HEIGHT)
const scrollEl = ref<HTMLElement | null>(null)
const scrollLeftVal = ref(0)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const charWidth = ref(8)
let composing = false

// ── Tokenization (whole-doc; fine for typical source files) ──────────────────
const lineTokens = computed<Token[][]>(() => {
  version.value // track
  const tok = tokenizer.value
  const out: Token[][] = []
  let state = tok.initialState()
  for (let i = 0; i < model.lineCount(); i++) {
    const { tokens, endState } = tok.tokenizeLine(model.getLine(i), state)
    out.push(tokens)
    state = endState
  }
  return out
})

interface RenderLine {
  index: number
  segments: { text: string; cls: string }[]
}

const visibleLines = computed<RenderLine[]>(() => {
  const res: RenderLine[] = []
  for (let i = vs.startLine.value; i < vs.endLine.value; i++) {
    res.push({ index: i, segments: segmentsFor(i) })
  }
  return res
})

function segmentsFor(line: number): { text: string; cls: string }[] {
  const text = model.getLine(line)
  const toks = lineTokens.value[line] ?? []
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
  const op = { range, text }
  const { inverse, caret } = model.applyEdit(op)
  undo.push(op, inverse)
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
    // Delete both brackets when cursor is between an auto-inserted pair
    if (AUTO_PAIRS[lineText[c.col - 1]] === lineText[c.col]) {
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
  version.value++
  emit('update:modelValue', model.getValue())
  void nextTick(scrollCursorIntoView)
}

// ── Cursor movement ──────────────────────────────────────────────────────────
function clampPos(p: Position): Position {
  const line = Math.max(0, Math.min(p.line, model.lineCount() - 1))
  const col = Math.max(0, Math.min(p.col, model.getLine(line).length))
  return { line, col }
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
  startOrClearSelection(extend)
  const line = model.getLine(cursor.value.line)
  let indent = 0
  while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) indent++
  cursor.value = { line: cursor.value.line, col: cursor.value.col === indent ? 0 : indent }
}
function endKey(extend: boolean): void {
  preferredCol = -1
  startOrClearSelection(extend)
  const line = cursor.value.line
  cursor.value = { line, col: model.getLine(line).length }
}

function isWordChar(ch: string): boolean { return /[a-zA-Z0-9_]/.test(ch) }

function moveWordLeft(extend: boolean): void {
  preferredCol = -1
  startOrClearSelection(extend)
  let { line, col } = cursor.value
  if (col === 0) {
    if (line > 0) { line--; col = model.getLine(line).length }
  } else {
    const text = model.getLine(line)
    col--
    while (col > 0 && (text[col] === ' ' || text[col] === '\t')) col--
    if (isWordChar(text[col])) {
      while (col > 0 && isWordChar(text[col - 1])) col--
    } else {
      while (col > 0 && !isWordChar(text[col - 1]) && text[col - 1] !== ' ' && text[col - 1] !== '\t') col--
    }
  }
  cursor.value = { line, col }
  void nextTick(scrollCursorIntoView)
}

function moveWordRight(extend: boolean): void {
  preferredCol = -1
  startOrClearSelection(extend)
  let { line, col } = cursor.value
  const text = model.getLine(line)
  if (col >= text.length) {
    if (line < model.lineCount() - 1) { line++; col = 0 }
  } else {
    if (isWordChar(text[col])) {
      while (col < text.length && isWordChar(text[col])) col++
    } else if (text[col] === ' ' || text[col] === '\t') {
      while (col < text.length && (text[col] === ' ' || text[col] === '\t')) col++
    } else {
      while (col < text.length && !isWordChar(text[col]) && text[col] !== ' ' && text[col] !== '\t') col++
    }
  }
  cursor.value = { line, col }
  void nextTick(scrollCursorIntoView)
}

function moveLineUpDown(dir: -1 | 1): void {
  preferredCol = -1
  const lineNum = cursor.value.line
  const savedCol = cursor.value.col
  const targetLine = lineNum + dir
  if (targetLine < 0 || targetLine >= model.lineCount()) return
  const curContent = model.getLine(lineNum)
  const targetContent = model.getLine(targetLine)
  const minLine = Math.min(lineNum, targetLine)
  const swapped = dir === -1
    ? curContent + '\n' + targetContent
    : targetContent + '\n' + curContent
  applyEdit(
    { start: { line: minLine, col: 0 }, end: { line: minLine + 1, col: model.getLine(minLine + 1).length } },
    swapped,
  )
  cursor.value = { line: targetLine, col: Math.min(savedCol, model.getLine(targetLine).length) }
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
  // Restore selection shifted by INDENT.length on each affected line
  anchor.value = savedAnchor && savedAnchor.line <= endLine
    ? { line: savedAnchor.line, col: savedAnchor.col + INDENT.length }
    : savedAnchor
  cursor.value = savedCursor.line <= endLine
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
    if (e.altKey && !mod) { moveLineUpDown(up ? -1 : 1) }
    else if (mod) {
      // Shift+Cmd+Up/Down: select to file start/end (Cmd-only is handled by keybindings)
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
      const pageLines = Math.max(1, Math.floor(vs.viewportHeight.value / LINE_HEIGHT) - 1)
      moveCursor(e.key === 'PageUp' ? -pageLines : pageLines, 0, shift)
      break
    }
    case 'End': e.preventDefault(); endKey(shift); break
    case 'Backspace': e.preventDefault(); deleteBackward(); break
    case 'Delete': e.preventDefault(); deleteForward(); break
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
      if (!selectionRange() && c.col > 0 && EXPAND_PAIRS[curLine[c.col - 1]] === curLine[c.col]) {
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
        if (lineText[c.col] === v) { cursor.value = { line: c.line, col: c.col + 1 }; void nextTick(scrollCursorIntoView); return }
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
  const p = undo.undo(model)
  if (p) { cursor.value = p; anchor.value = null; afterChange() }
}
function doRedo(): void {
  preferredCol = -1
  const p = undo.redo(model)
  if (p) { cursor.value = p; anchor.value = null; afterChange() }
}
function selectAll(): void {
  preferredCol = -1
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

  const lines: string[] = []
  for (let i = 0; i <= endLine - startLine; i++) {
    const line = model.getLine(startLine + i)
    const indent = line.match(/^(\s*)/)?.[1] ?? ''
    const rest = line.slice(indent.length)
    if (allCommented) {
      if (rest.startsWith(prefixFull)) lines.push(indent + rest.slice(prefixFull.length))
      else if (rest === token || rest.startsWith(token + '\t')) lines.push(indent + rest.slice(token.length))
      else lines.push(line)
    } else {
      lines.push(rest ? indent + prefixFull + rest : line)
    }
  }
  applyEdit(
    { start: { line: startLine, col: 0 }, end: { line: endLine, col: model.getLine(endLine).length } },
    lines.join('\n'),
  )
  cursor.value = clampPos(savedCursor)
  anchor.value = savedAnchor ? clampPos(savedAnchor) : null
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
  } else {
    const prevLen = model.getLine(startLine - 1).length
    applyEdit(
      { start: { line: startLine - 1, col: prevLen }, end: { line: endLine, col: model.getLine(endLine).length } },
      '',
    )
    cursor.value = { line: startLine - 1, col: prevLen }
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
  cursor.value = { line: 0, col: 0 }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

function cursorBottom(): void {
  anchor.value = null
  const lastLine = model.lineCount() - 1
  cursor.value = { line: lastLine, col: model.getLine(lastLine).length }
  preferredCol = -1
  void nextTick(scrollCursorIntoView)
}

const BRACKET_OPEN = new Set(['(', '[', '{'])
const BRACKET_CLOSE = new Set([')', ']', '}'])
const BRACKET_MATCH: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' }

function jumpToBracket(): void {
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
  const line = Math.max(0, Math.min(Math.floor(y / LINE_HEIGHT), model.lineCount() - 1))
  const col = Math.max(0, Math.min(Math.round(x / charWidth.value), model.getLine(line).length))
  return { line, col }
}

function selectWordAt(pos: Position): void {
  preferredCol = -1
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
  const top = cursor.value.line * LINE_HEIGHT
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + LINE_HEIGHT > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + LINE_HEIGHT - el.clientHeight
  }
  // Horizontal: keep caret within the visible content area
  const caretX = xFor(cursor.value.col)
  const MARGIN = 40
  if (caretX < el.scrollLeft + gutterWidth.value + MARGIN) {
    el.scrollLeft = Math.max(0, caretX - gutterWidth.value - MARGIN)
  } else if (caretX + MARGIN > el.scrollLeft + el.clientWidth) {
    el.scrollLeft = caretX + MARGIN - el.clientWidth
  }
}

// ── Geometry for caret / selection overlays ──────────────────────────────────
function xFor(col: number): number {
  return gutterWidth.value + PAD_LEFT + col * charWidth.value
}
const caretStyle = computed(() => ({
  left: xFor(cursor.value.col) + 'px',
  height: LINE_HEIGHT + 'px',
}))

interface SelRect { left: number; top: number; width: number }
const selectionRects = computed<SelRect[]>(() => {
  const sel = selectionRange()
  if (!sel) return []
  const vStart = vs.startLine.value
  const vEnd = vs.endLine.value
  const rects: SelRect[] = []
  for (let line = Math.max(sel.start.line, vStart); line <= Math.min(sel.end.line, vEnd - 1); line++) {
    const lineLen = model.getLine(line).length
    const startCol = line === sel.start.line ? sel.start.col : 0
    const endCol = line === sel.end.line ? sel.end.col : lineLen
    const left = xFor(startCol)
    const width = Math.max(2, (endCol - startCol) * charWidth.value + (line < sel.end.line ? charWidth.value : 0))
    rects.push({ left, top: line * LINE_HEIGHT, width })
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
    for (let line = Math.max(d.range.start.line, vStart); line <= Math.min(d.range.end.line, vEnd - 1); line++) {
      const startCol = line === d.range.start.line ? d.range.start.col : 0
      const endCol = line === d.range.end.line ? d.range.end.col : model.getLine(line).length
      rects.push({
        id: `${d.id}:${line}`,
        left: xFor(startCol),
        top: line * LINE_HEIGHT,
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
  probe.style.cssText = 'position:absolute;visibility:hidden;font:13px/19px ui-monospace,Menlo,monospace;white-space:pre'
  probe.textContent = '0'.repeat(50)
  document.body.appendChild(probe)
  charWidth.value = probe.getBoundingClientRect().width / 50
  probe.remove()
}

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
    cursor.value = clampPos(cursor.value)
    anchor.value = null
    afterChange()
  }
})

watch(cursor, (pos) => emit('cursor-change', { ...pos }))

// ── Imperative API for AI features / host (Phase E/F/G) ───────────────────────
function focus(): void { textareaEl.value?.focus() }
function getValue(): string { return model.getValue() }
function setValue(v: string): void { model.setValue(v); cursor.value = { line: 0, col: 0 }; anchor.value = null; afterChange() }
function getSelectionRange(): Range | null { return selectionRange() }
function getSelectionText(): string {
  const sel = selectionRange()
  return sel ? model.getValueInRange(sel) : ''
}
function getCursor(): Position { return cursor.value }
function revealLine(line: number): void {
  // `line` is 1-based (search results / external callers); cursor is 0-based.
  cursor.value = clampPos({ line: Math.max(0, line - 1), col: 0 })
  void Promise.resolve().then(() => { scrollCursorIntoView(); focus() })
}
function revealPosition(line: number, col: number): void {
  // 0-based; used internally by find navigation.
  cursor.value = clampPos({ line, col })
  void Promise.resolve().then(() => { scrollCursorIntoView(); focus() })
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

defineExpose({
  focus, getValue, setValue, getSelectionRange, getSelectionText, getCursor,
  revealLine, revealPosition, applyEditExternal, setDecorations, setGhost, acceptGhost,
  toggleLineComment, deleteLine, insertLineBelow, insertLineAbove,
  moveLineUp, moveLineDown, getWordAtCursor,
  jumpToBracket, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine, cursorTop, cursorBottom,
})
</script>

<template>
  <div class="editor-view" @mousedown="onMousedown" @mousemove="onMousemove">
    <textarea
      ref="textareaEl"
      class="ev-input"
      :style="{ left: (xFor(cursor.col) - scrollLeftVal) + 'px', top: cursor.line * LINE_HEIGHT - vs.scrollTop.value + 'px' }"
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
            :style="{ left: r.left + 'px', top: (r.top - vs.offsetY.value) + 'px', width: r.width + 'px', height: LINE_HEIGHT + 'px' }"
          />
          <!-- find / decoration highlights -->
          <div
            v-for="r in decorationRects"
            :key="r.id"
            class="ev-dec-highlight"
            :class="r.className"
            :style="{ left: r.left + 'px', top: (r.top - vs.offsetY.value) + 'px', width: r.width + 'px', height: LINE_HEIGHT + 'px' }"
          />
          <!-- lines -->
          <div
            v-for="rl in visibleLines"
            :key="rl.index"
            class="ev-line"
            :style="{ top: (rl.index * LINE_HEIGHT - vs.offsetY.value) + 'px', height: LINE_HEIGHT + 'px' }"
          >
            <span class="ev-gutter" :style="{ width: gutterWidth + 'px' }">{{ rl.index + 1 }}</span>
            <span class="ev-content" :style="{ paddingLeft: PAD_LEFT + 'px' }"><span
              v-for="(s, si) in rl.segments"
              :key="si"
              :class="s.cls"
            >{{ s.text }}</span></span>
          </div>
          <!-- caret -->
          <div class="ev-caret" :style="{ left: caretStyle.left, top: (cursor.line * LINE_HEIGHT - vs.offsetY.value) + 'px', height: caretStyle.height }" />
          <!-- ghost text -->
          <div
            v-if="ghost && ghostStyle"
            class="ev-ghost"
            :style="{ left: ghostStyle.left, top: (ghost.pos.line * LINE_HEIGHT - vs.offsetY.value) + 'px' }"
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
  font: 13px/19px ui-monospace, Menlo, Consolas, monospace;
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
