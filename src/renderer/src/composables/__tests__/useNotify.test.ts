import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotify } from '../useNotify'

const n = useNotify()

describe('useNotify', () => {
  beforeEach(() => {
    // Singleton module state — reset queue + any open dialog between tests.
    n.toasts.value.slice().forEach((t) => n.dismissToast(t.id))
    if (n.dialog.value) n.resolveDialog(false)
  })

  // ── Toast ─────────────────────────────────────────────────────────────────
  it('toast pushes onto the queue with default info type', () => {
    n.toast('hello')
    expect(n.toasts.value).toHaveLength(1)
    expect(n.toasts.value[0].message).toBe('hello')
    expect(n.toasts.value[0].type).toBe('info')
  })

  it('toast honors an explicit type', () => {
    n.toast('done', { type: 'success' })
    expect(n.toasts.value[0].type).toBe('success')
  })

  it('toasts stack with unique ids', () => {
    n.toast('a')
    n.toast('b')
    const ids = n.toasts.value.map((t) => t.id)
    expect(n.toasts.value).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('toast auto-dismisses after its duration', () => {
    vi.useFakeTimers()
    try {
      n.toast('bye', { duration: 1000 })
      expect(n.toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(999)
      expect(n.toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(n.toasts.value).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('toast with duration 0 never auto-dismisses', () => {
    vi.useFakeTimers()
    try {
      n.toast('sticky', { duration: 0 })
      vi.advanceTimersByTime(100000)
      expect(n.toasts.value).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismissToast removes the matching toast only', () => {
    n.toast('a')
    n.toast('b')
    const firstId = n.toasts.value[0].id
    n.dismissToast(firstId)
    expect(n.toasts.value).toHaveLength(1)
    expect(n.toasts.value[0].message).toBe('b')
  })

  // ── Alert ───────────────────────────────────────────────────────────────────
  it('alert opens a blocking dialog and resolves when acknowledged', async () => {
    const p = n.alert('something failed', { title: 'Error' })
    expect(n.dialog.value?.kind).toBe('alert')
    expect(n.dialog.value?.title).toBe('Error')
    expect(n.dialog.value?.message).toBe('something failed')
    n.resolveDialog(true)
    await expect(p).resolves.toBeUndefined()
    expect(n.dialog.value).toBeNull()
  })

  // ── Confirm ─────────────────────────────────────────────────────────────────
  it('confirm resolves true when confirmed', async () => {
    const p = n.confirm('delete it?')
    expect(n.dialog.value?.kind).toBe('confirm')
    n.resolveDialog(true)
    await expect(p).resolves.toBe(true)
    expect(n.dialog.value).toBeNull()
  })

  it('confirm resolves false when cancelled', async () => {
    const p = n.confirm('delete it?', { confirmText: '刪除', cancelText: '取消' })
    expect(n.dialog.value?.confirmText).toBe('刪除')
    expect(n.dialog.value?.cancelText).toBe('取消')
    n.resolveDialog(false)
    await expect(p).resolves.toBe(false)
  })
})
