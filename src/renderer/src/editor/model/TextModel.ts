import type { Position, Range, EditOperation, AppliedEdit } from '../types'

/**
 * In-memory text buffer for the AI Native Editor.
 *
 * The document is stored as an array of lines split on "\n". An empty document
 * is `['']` (one empty line), and a trailing "\n" produces a trailing empty
 * line — i.e. `getValue()` is an exact round-trip of `setValue()`.
 *
 * All positions are zero-based; `col` is a UTF-16 code-unit offset. Ranges are
 * half-open at the end.
 */
export class TextModel {
  private lines: string[]

  constructor(initialText: string = '') {
    this.lines = initialText.replace(/\r\n/g, '\n').split('\n')
  }

  lineCount(): number {
    return this.lines.length
  }

  getLine(line: number): string {
    return this.lines[this.clampLine(line)]
  }

  getValue(): string {
    return this.lines.join('\n')
  }

  setValue(text: string): void {
    this.lines = text.replace(/\r\n/g, '\n').split('\n')
  }

  getValueInRange(range: Range): string {
    const { start, end } = this.normalizeRange(range)

    if (start.line === end.line) {
      return this.lines[start.line].slice(start.col, end.col)
    }

    const parts: string[] = [this.lines[start.line].slice(start.col)]
    for (let line = start.line + 1; line < end.line; line++) {
      parts.push(this.lines[line])
    }
    parts.push(this.lines[end.line].slice(0, end.col))
    return parts.join('\n')
  }

  applyEdit(op: EditOperation): AppliedEdit {
    const { start, end } = this.normalizeRange(op.range)

    // Capture the old text so we can build the inverse edit.
    const removed = this.getValueInRange({ start, end })

    const prefix = this.lines[start.line].slice(0, start.col)
    const suffix = this.lines[end.line].slice(end.col)

    const inserted = op.text.split('\n')

    // The first inserted segment joins the surviving prefix; the last joins the
    // surviving suffix. Everything in between becomes its own line.
    const newLines: string[] = []
    if (inserted.length === 1) {
      newLines.push(prefix + inserted[0] + suffix)
    } else {
      newLines.push(prefix + inserted[0])
      for (let i = 1; i < inserted.length - 1; i++) {
        newLines.push(inserted[i])
      }
      newLines.push(inserted[inserted.length - 1] + suffix)
    }

    this.lines.splice(start.line, end.line - start.line + 1, ...newLines)

    // Caret sits at the end of the inserted text.
    const lastSegment = inserted[inserted.length - 1]
    const caret: Position =
      inserted.length === 1
        ? { line: start.line, col: start.col + lastSegment.length }
        : { line: start.line + inserted.length - 1, col: lastSegment.length }

    // The inverse replaces the freshly inserted text with the removed text.
    const inverse: EditOperation = {
      range: { start: { ...start }, end: { ...caret } },
      text: removed,
    }

    return { inverse, caret }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private clampLine(line: number): number {
    if (line < 0) return 0
    if (line >= this.lines.length) return this.lines.length - 1
    return line
  }

  private clampPosition(pos: Position): Position {
    const line = this.clampLine(pos.line)
    const maxCol = this.lines[line].length
    let col = pos.col
    if (col < 0) col = 0
    if (col > maxCol) col = maxCol
    return { line, col }
  }

  /** Clamp both ends into the document and ensure start <= end. */
  private normalizeRange(range: Range): Range {
    const a = this.clampPosition(range.start)
    const b = this.clampPosition(range.end)
    const swapped =
      a.line > b.line || (a.line === b.line && a.col > b.col)
    return swapped ? { start: b, end: a } : { start: a, end: b }
  }
}
