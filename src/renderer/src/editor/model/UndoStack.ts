import type { Position, EditOperation } from '../types'
import type { TextModel } from './TextModel'

type OpPair = { forward: EditOperation; inverse: EditOperation }

/** A single undoable unit: one or more op pairs (multi-cursor = multiple pairs). */
interface UndoEntry {
  ops: OpPair[]
  /** Timestamp of the last edit folded into this entry (for merge windows). */
  time: number
}

/** Max gap (ms) between consecutive typed chars that still merge into one undo. */
const MERGE_WINDOW_MS = 300
/** Hard cap on undo history depth to bound memory use. */
const MAX_ENTRIES = 500

/**
 * Undo/redo history for a {@link TextModel}.
 *
 * Consecutive single-character insertions that arrive within
 * {@link MERGE_WINDOW_MS} of each other and are adjacent (each typed right where
 * the previous one ended) collapse into one undo unit, so undo removes the whole
 * typed word rather than one keystroke at a time.
 *
 * Multi-cursor edits pushed via {@link pushBatch} are stored as a single undo
 * entry whose ops are applied/reversed together.
 *
 * `now` is injectable so tests can drive the merge window deterministically.
 */
export class UndoStack {
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private readonly now: () => number
  /** When true, the next push always starts a fresh unit (no merge). */
  private breakNext = false

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  /**
   * Record a forward edit and its inverse. Clears the redo stack. Merges into
   * the previous entry when it is a continuation of fast adjacent typing.
   */
  push(forward: EditOperation, inverse: EditOperation): void {
    this.redoStack = []
    const time = this.now()

    const prev = this.undoStack[this.undoStack.length - 1]
    if (!this.breakNext && prev && prev.ops.length === 1 && this.canMerge(prev, forward, time)) {
      const p = prev.ops[0]
      p.forward = {
        range: { start: { ...p.forward.range.start }, end: { ...p.forward.range.start } },
        text: p.forward.text + forward.text,
      }
      p.inverse = {
        range: { start: { ...p.inverse.range.start }, end: { ...inverse.range.end } },
        text: p.inverse.text,
      }
      prev.time = time
      return
    }

    this.undoStack.push({ ops: [{ forward, inverse }], time })
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift()
    this.breakNext = false
  }

  /**
   * Push multiple op pairs as a single atomic undo entry (for multi-cursor edits).
   * Ops should be ordered bottom-to-top (descending line/col) as they were applied,
   * so undo can reverse them top-to-bottom.
   */
  pushBatch(pairs: OpPair[]): void {
    if (!pairs.length) return
    this.redoStack = []
    this.undoStack.push({ ops: pairs, time: this.now() })
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift()
    this.breakNext = false
  }

  /** Force the next {@link push} to begin a new undo unit. */
  beginGroup(): void {
    this.breakNext = true
  }

  undo(model: TextModel): Position | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    // Apply inverses top-to-bottom (reverse of the bottom-to-top application order).
    let caret: Position | null = null
    for (let i = entry.ops.length - 1; i >= 0; i--) {
      caret = model.applyEdit(entry.ops[i].inverse).caret
    }
    this.redoStack.push(entry)
    this.breakNext = true
    return caret
  }

  redo(model: TextModel): Position | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    // Apply forwards bottom-to-top (the original application order).
    let caret: Position | null = null
    for (const op of entry.ops) {
      caret = model.applyEdit(op.forward).caret
    }
    this.undoStack.push(entry)
    this.breakNext = true
    return caret
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  peekUndo(): OpPair[] | null {
    return this.undoStack[this.undoStack.length - 1]?.ops ?? null
  }

  peekRedo(): OpPair[] | null {
    return this.redoStack[this.redoStack.length - 1]?.ops ?? null
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.breakNext = false
  }

  // ── internals ────────────────────────────────────────────────────────────

  private canMerge(prev: UndoEntry, forward: EditOperation, time: number): boolean {
    if (time - prev.time > MERGE_WINDOW_MS) return false

    const isSingleCharInsert =
      forward.text.length === 1 &&
      forward.text !== '\n' &&
      samePosition(forward.range.start, forward.range.end)
    if (!isSingleCharInsert) return false

    const p = prev.ops[0]
    if (p.inverse.text !== '') return false
    return samePosition(forward.range.start, p.inverse.range.end)
  }
}

function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.col === b.col
}
