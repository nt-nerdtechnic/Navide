<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { TextModel } from '../model/TextModel'
import { UndoStack } from '../model/UndoStack'
import { JsTokenizer } from '../tokenize/jsTokenizer'
import { useVirtualScroll } from './useVirtualScroll'
import type { Position, Range, Token, Decoration } from '../types'

const props = withDefaults(defineProps<{ modelValue?: string; readonly?: boolean }>(), {
  modelValue: '',
  readonly: false,
})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const LINE_HEIGHT = 19
const PAD_LEFT = 8
const GUTTER_W = 48

const model = new TextModel(props.modelValue)
const undo = new UndoStack()
const tokenizer = JsTokenizer

// Bumped on every edit to re-derive rendered state.
const version = ref(0)
const cursor = ref<Position>({ line: 0, col: 0 })
const anchor = ref<Position | null>(null) // selection start, null when no selection
const decorations = ref<Decoration[]>([])
const ghost = ref<{ pos: Position; text: string } | null>(null)

const lineCount = computed(() => {
  version.value // track
  return model.lineCount()
})

const vs = useVirtualScroll(lineCount, LINE_HEIGHT)
const scrollEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const charWidth = ref(8)
let composing = false

// ── Tokenization (whole-doc; fine for typical source files) ──────────────────
const lineTokens = computed<Token[][]>(() => {
  version.value // track
  const out: Token[][] = []
  let state = tokenizer.initialState()
  for (let i = 0; i < model.lineCount(); i++) {
    const { tokens, endState } = tokenizer.tokenizeLine(model.getLine(i), state)
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
    col += dCol
    if (col < 0) {
      if (line > 0) { line--; col = model.getLine(line).length } else col = 0
    } else if (col > model.getLine(line).length) {
      if (line < model.lineCount() - 1) { line++; col = 0 } else col = model.getLine(line).length
    }
  }
  if (dLine !== 0) {
    line = Math.max(0, Math.min(line + dLine, model.lineCount() - 1))
    col = Math.min(col, model.getLine(line).length)
  }
  cursor.value = { line, col }
  ghost.value = null
  void nextTick(scrollCursorIntoView)
}

function moveTo(pos: Position, extend: boolean): void {
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
  startOrClearSelection(extend)
  cursor.value = { line: cursor.value.line, col: 0 }
}
function endKey(extend: boolean): void {
  startOrClearSelection(extend)
  const line = cursor.value.line
  cursor.value = { line, col: model.getLine(line).length }
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

  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); moveCursor(0, -1, shift); break
    case 'ArrowRight': e.preventDefault(); moveCursor(0, 1, shift); break
    case 'ArrowUp': e.preventDefault(); moveCursor(-1, 0, shift); break
    case 'ArrowDown': e.preventDefault(); moveCursor(1, 0, shift); break
    case 'Home': e.preventDefault(); homeKey(shift); break
    case 'End': e.preventDefault(); endKey(shift); break
    case 'Backspace': e.preventDefault(); deleteBackward(); break
    case 'Delete': e.preventDefault(); deleteForward(); break
    case 'Enter': e.preventDefault(); insertText('\n'); break
    case 'Tab': e.preventDefault(); insertText('  '); break
    case 'Escape': ghost.value = null; break
    default: break
  }
}

function onInput(): void {
  const ta = textareaEl.value
  if (!ta || composing) return
  const v = ta.value
  if (v) { insertText(v); ta.value = '' }
}
function onCompositionEnd(): void {
  composing = false
  onInput()
}

function doUndo(): void {
  const p = undo.undo(model)
  if (p) { cursor.value = p; anchor.value = null; afterChange() }
}
function doRedo(): void {
  const p = undo.redo(model)
  if (p) { cursor.value = p; anchor.value = null; afterChange() }
}
function selectAll(): void {
  const last = model.lineCount() - 1
  anchor.value = { line: 0, col: 0 }
  cursor.value = { line: last, col: model.getLine(last).length }
}

// ── Mouse ────────────────────────────────────────────────────────────────────
function posFromMouse(e: MouseEvent): Position {
  const el = scrollEl.value
  if (!el) return cursor.value
  const rect = el.getBoundingClientRect()
  const y = e.clientY - rect.top + el.scrollTop
  const x = e.clientX - rect.left + el.scrollLeft - GUTTER_W - PAD_LEFT
  const line = Math.max(0, Math.min(Math.floor(y / LINE_HEIGHT), model.lineCount() - 1))
  const col = Math.max(0, Math.min(Math.round(x / charWidth.value), model.getLine(line).length))
  return { line, col }
}
let dragging = false
function onMousedown(e: MouseEvent): void {
  if (e.button !== 0) return
  moveTo(posFromMouse(e), e.shiftKey)
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
  const top = cursor.value.line * LINE_HEIGHT
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + LINE_HEIGHT > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + LINE_HEIGHT - el.clientHeight
  }
}

// ── Geometry for caret / selection overlays ──────────────────────────────────
function xFor(col: number): number {
  return GUTTER_W + PAD_LEFT + col * charWidth.value
}
const caretStyle = computed(() => ({
  left: xFor(cursor.value.col) + 'px',
  top: cursor.value.line * LINE_HEIGHT + 'px',
  height: LINE_HEIGHT + 'px',
}))

interface SelRect { left: number; top: number; width: number }
const selectionRects = computed<SelRect[]>(() => {
  const sel = selectionRange()
  if (!sel) return []
  const rects: SelRect[] = []
  for (let line = sel.start.line; line <= sel.end.line; line++) {
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
  return { left: xFor(ghost.value.pos.col) + 'px', top: ghost.value.pos.line * LINE_HEIGHT + 'px' }
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
    afterChange()
  }
})

// ── Imperative API for AI features / host (Phase E/F/G) ───────────────────────
function focus(): void { textareaEl.value?.focus() }
function getValue(): string { return model.getValue() }
function setValue(v: string): void { model.setValue(v); cursor.value = { line: 0, col: 0 }; afterChange() }
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
})
</script>

<template>
  <div class="editor-view" @mousedown="onMousedown" @mousemove="onMousemove">
    <textarea
      ref="textareaEl"
      class="ev-input"
      :style="{ left: xFor(cursor.col) + 'px', top: cursor.line * LINE_HEIGHT - vs.scrollTop.value + 'px' }"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      @keydown="onKeydown"
      @input="onInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
    />
    <div ref="scrollEl" class="ev-scroll" @scroll="vs.onScroll">
      <div class="ev-sizer" :style="{ height: vs.totalHeight.value + 'px' }">
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
            <span class="ev-gutter" :style="{ width: GUTTER_W + 'px' }">{{ rl.index + 1 }}</span>
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
.ev-slab { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.ev-line {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  white-space: pre;
}
.ev-gutter {
  flex-shrink: 0;
  text-align: right;
  padding-right: 10px;
  color: var(--text-muted);
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
