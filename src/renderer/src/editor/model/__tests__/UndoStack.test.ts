import { describe, it, expect } from 'vitest'
import { TextModel } from '../TextModel'
import { UndoStack } from '../UndoStack'
import type { EditOperation } from '../../types'

/** Type a single char at the given position into the model and push to stack. */
function typeChar(model: TextModel, stack: UndoStack, pos: { line: number; col: number }, ch: string) {
  const op: EditOperation = { range: { start: pos, end: { ...pos } }, text: ch }
  const { inverse } = model.applyEdit(op)
  stack.push(op, inverse)
}

describe('UndoStack basic undo/redo', () => {
  it('undoes a single edit', () => {
    const m = new TextModel('ac')
    const s = new UndoStack()
    typeChar(m, s, { line: 0, col: 1 }, 'b')
    expect(m.getValue()).toBe('abc')

    const caret = s.undo(m)
    expect(m.getValue()).toBe('ac')
    expect(caret).toEqual({ line: 0, col: 1 })
  })

  it('redoes after undo', () => {
    const m = new TextModel('ac')
    const s = new UndoStack()
    typeChar(m, s, { line: 0, col: 1 }, 'b')
    s.undo(m)

    const caret = s.redo(m)
    expect(m.getValue()).toBe('abc')
    expect(caret).toEqual({ line: 0, col: 2 })
  })

  it('returns null when nothing to undo/redo', () => {
    const m = new TextModel('x')
    const s = new UndoStack()
    expect(s.undo(m)).toBeNull()
    expect(s.redo(m)).toBeNull()
  })

  it('handles multiple distinct (non-merged) edits in LIFO order', () => {
    const m = new TextModel('')
    // Inject a clock that advances past the merge window between edits.
    let t = 0
    const s = new UndoStack(() => (t += 1000))

    let op: EditOperation = { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, text: 'a' }
    s.push(op, m.applyEdit(op).inverse) // 'a'
    op = { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'b' }
    s.push(op, m.applyEdit(op).inverse) // 'ab'
    expect(m.getValue()).toBe('ab')

    s.undo(m)
    expect(m.getValue()).toBe('a')
    s.undo(m)
    expect(m.getValue()).toBe('')
    expect(s.undo(m)).toBeNull()
  })
})

describe('UndoStack group merging', () => {
  it('merges fast adjacent single-char typing into one undo unit', () => {
    const m = new TextModel('')
    let t = 0
    // Each edit advances the clock by 50ms — within the 300ms window.
    const s = new UndoStack(() => (t += 50))

    typeChar(m, s, { line: 0, col: 0 }, 'h')
    typeChar(m, s, { line: 0, col: 1 }, 'i')
    expect(m.getValue()).toBe('hi')

    const caret = s.undo(m)
    expect(m.getValue()).toBe('') // both chars removed in one undo
    expect(caret).toEqual({ line: 0, col: 0 })
    expect(s.canUndo()).toBe(false)

    // And redo restores the whole word at once.
    s.redo(m)
    expect(m.getValue()).toBe('hi')
  })

  it('does NOT merge when typing is slow (outside window)', () => {
    const m = new TextModel('')
    let t = 0
    const s = new UndoStack(() => (t += 1000)) // 1s gaps

    typeChar(m, s, { line: 0, col: 0 }, 'h')
    typeChar(m, s, { line: 0, col: 1 }, 'i')

    s.undo(m)
    expect(m.getValue()).toBe('h') // only last char removed
  })

  it('does NOT merge non-adjacent insertions', () => {
    const m = new TextModel('XYZ')
    let t = 0
    const s = new UndoStack(() => (t += 10))

    typeChar(m, s, { line: 0, col: 0 }, 'a') // 'aXYZ'
    typeChar(m, s, { line: 0, col: 3 }, 'b') // insert elsewhere -> 'aXYbZ'

    s.undo(m)
    expect(m.getValue()).toBe('aXYZ') // only the second insert undone
  })

  it('does NOT merge across a newline insertion', () => {
    const m = new TextModel('')
    let t = 0
    const s = new UndoStack(() => (t += 10))

    typeChar(m, s, { line: 0, col: 0 }, 'a')
    typeChar(m, s, { line: 0, col: 1 }, '\n') // newline breaks the run

    s.undo(m)
    expect(m.getValue()).toBe('a') // newline undone alone
    s.undo(m)
    expect(m.getValue()).toBe('')
  })

  it('redo restores text correctly when typing in the middle of existing content', () => {
    // Regression: merged forward.range.end was set to the second insert position
    // in the *post-insert* model, causing redo to delete surrounding chars.
    const m = new TextModel('hello world')
    let t = 0
    const s = new UndoStack(() => (t += 50)) // within merge window

    typeChar(m, s, { line: 0, col: 5 }, 'a') // 'helloa world'
    typeChar(m, s, { line: 0, col: 6 }, 'b') // 'helloab world'
    expect(m.getValue()).toBe('helloab world')

    s.undo(m)
    expect(m.getValue()).toBe('hello world')

    s.redo(m)
    expect(m.getValue()).toBe('helloab world') // must not delete the space
  })

  it('beginGroup forces a new undo unit', () => {
    const m = new TextModel('')
    let t = 0
    const s = new UndoStack(() => (t += 10)) // would otherwise merge

    typeChar(m, s, { line: 0, col: 0 }, 'a')
    s.beginGroup()
    typeChar(m, s, { line: 0, col: 1 }, 'b')

    s.undo(m)
    expect(m.getValue()).toBe('a') // only 'b' undone despite fast timing
  })
})

describe('UndoStack redo invalidation', () => {
  it('clears redo stack on a new push', () => {
    const m = new TextModel('')
    let t = 0
    const s = new UndoStack(() => (t += 1000))

    let op: EditOperation = { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, text: 'a' }
    s.push(op, m.applyEdit(op).inverse)
    s.undo(m) // redo now available
    expect(s.canRedo()).toBe(true)

    op = { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, text: 'z' }
    s.push(op, m.applyEdit(op).inverse) // new edit invalidates redo

    expect(s.canRedo()).toBe(false)
    expect(s.redo(m)).toBeNull()
  })
})
