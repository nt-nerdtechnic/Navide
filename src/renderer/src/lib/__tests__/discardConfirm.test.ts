import { describe, it, expect, vi } from 'vitest'
import { discardConfirmMessage, guardedDiscard } from '../discardConfirm'

describe('discardConfirmMessage', () => {
  it('lists a single file with the irreversible warning', () => {
    const msg = discardConfirmMessage(['a.png'])
    expect(msg).toContain('Discard 1 change(s)?')
    expect(msg).toContain('This cannot be undone.')
    expect(msg).toContain('a.png')
  })

  it('lists up to 12 files verbatim', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `f${i}.txt`)
    const msg = discardConfirmMessage(paths)
    expect(msg).toContain('Discard 12 change(s)?')
    paths.forEach((p) => expect(msg).toContain(p))
    expect(msg).not.toContain('more')
  })

  it('truncates beyond 12 with a "…and N more" tail', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `f${i}.txt`)
    const msg = discardConfirmMessage(paths)
    expect(msg).toContain('Discard 15 change(s)?')
    expect(msg).toContain('f11.txt')
    expect(msg).not.toContain('f12.txt')
    expect(msg).toContain('…and 3 more')
  })
})

describe('guardedDiscard — the safety contract', () => {
  it('does NOT discard when the user cancels', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const discard = vi.fn()
    const ran = await guardedDiscard(['a.png'], confirm, discard)
    expect(confirm).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
    expect(ran).toBe(false)
  })

  it('discards exactly the given paths only after confirmation', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const discard = vi.fn()
    const ran = await guardedDiscard(['a.png', 'b.png'], confirm, discard)
    expect(discard).toHaveBeenCalledWith(['a.png', 'b.png'])
    expect(ran).toBe(true)
  })

  it('never prompts or discards for an empty selection', async () => {
    const confirm = vi.fn()
    const discard = vi.fn()
    const ran = await guardedDiscard([], confirm, discard)
    expect(confirm).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(ran).toBe(false)
  })

  it('passes the Discard/Cancel labels and title to the dialog', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    await guardedDiscard(['a.png'], confirm, vi.fn())
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('This cannot be undone.'),
      { title: 'Discard changes', confirmText: 'Discard', cancelText: 'Cancel' },
    )
  })

  it('confirms BEFORE discarding (order matters — no early delete)', async () => {
    const calls: string[] = []
    const confirm = vi.fn(async () => { calls.push('confirm'); return true })
    const discard = vi.fn(async () => { calls.push('discard') })
    await guardedDiscard(['a.png'], confirm, discard)
    expect(calls).toEqual(['confirm', 'discard'])
  })
})
