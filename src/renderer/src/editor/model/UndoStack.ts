import type { Position, EditOperation } from '../types'
import type { TextModel } from './TextModel'

/** A single undoable unit: forward edit(s) and the matching inverse(s). */
interface UndoEntry {
  forward: EditOperation
  inverse: EditOperation
  /** Timestamp of the last edit folded into this entry (for merge windows). */
  time: number
}

/** Max gap (ms) between consecutive typed chars that still merge into one undo. */
const MERGE_WINDOW_MS = 300

/**
 * Undo/redo history for a {@link TextModel}.
 *
 * Consecutive single-character insertions that arrive within
 * {@link MERGE_WINDOW_MS} of each other and are adjacent (each typed right where
 * the previous one ended) collapse into one undo unit, so undo removes the whole
 * typed word rather than one keystroke at a time.
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
    if (!this.breakNext && prev && this.canMerge(prev, forward, time)) {
      // Extend the existing unit. The forward stays a pure insert (range.start ===
      // range.end) so that redo inserts at the correct position in the pre-insert
      // document. Only grow the inverse's end to cover all inserted chars.
      prev.forward = {
        range: { start: { ...prev.forward.range.start }, end: { ...prev.forward.range.start } },
        text: prev.forward.text + forward.text,
      }
      prev.inverse = {
        range: { start: { ...prev.inverse.range.start }, end: { ...inverse.range.end } },
        text: prev.inverse.text,
      }
      prev.time = time
      return
    }

    this.undoStack.push({ forward, inverse, time })
    this.breakNext = false
  }

  /** Force the next {@link push} to begin a new undo unit. */
  beginGroup(): void {
    this.breakNext = true
  }

  undo(model: TextModel): Position | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    const { caret } = model.applyEdit(entry.inverse)
    this.redoStack.push(entry)
    // After an undo, further typing must not merge into a popped entry.
    this.breakNext = true
    return caret
  }

  redo(model: TextModel): Position | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    const { caret } = model.applyEdit(entry.forward)
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

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.breakNext = false
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * A pure single-character insertion (empty range, one char, no newline) is
   * eligible to merge when it lands right where the previous insertion ended
   * and within the time window.
   */
  private canMerge(prev: UndoEntry, forward: EditOperation, time: number): boolean {
    if (time - prev.time > MERGE_WINDOW_MS) return false

    const isSingleCharInsert =
      forward.text.length === 1 &&
      forward.text !== '\n' &&
      samePosition(forward.range.start, forward.range.end)
    if (!isSingleCharInsert) return false

    // The previous unit must also have been a pure typed insertion (empty
    // inverse text). Its inverse range spans the already-inserted text, so its
    // end is the caret the previous keystroke left behind; the new char must
    // start exactly there to count as a continuation.
    if (prev.inverse.text !== '') return false
    return samePosition(forward.range.start, prev.inverse.range.end)
  }
}

function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.col === b.col
}
