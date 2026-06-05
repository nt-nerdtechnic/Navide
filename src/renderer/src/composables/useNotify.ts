import { readonly, ref } from 'vue'

/**
 * Modular notification system — Toast / Alert / Confirm.
 *
 * Singleton module-level state so any component can `useNotify()` and fire
 * notifications without prop drilling. Rendering lives in NotificationHost.vue
 * (mounted once at the App root).
 */

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

export interface DialogState {
  kind: 'alert' | 'confirm'
  title: string
  message: string
  confirmText: string
  cancelText: string
  /** Resolves the alert()/confirm() promise. alert ignores the boolean. */
  resolve: (value: boolean) => void
}

// ── Module-level singleton state ──────────────────────────────────────────
const toasts = ref<Toast[]>([])
const dialog = ref<DialogState | null>(null)
let seq = 0
const _toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
const MAX_TOASTS = 6

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(
  message: string,
  opts: { type?: ToastType; duration?: number } = {}
): void {
  const id = ++seq
  // Evict oldest toasts when the list is full to prevent unbounded growth.
  if (toasts.value.length >= MAX_TOASTS) {
    const evicted = toasts.value.splice(0, toasts.value.length - MAX_TOASTS + 1)
    for (const t of evicted) {
      const h = _toastTimers.get(t.id)
      if (h != null) { clearTimeout(h); _toastTimers.delete(t.id) }
    }
  }
  toasts.value.push({ id, message, type: opts.type ?? 'info' })
  const duration = opts.duration ?? 4000
  if (duration > 0) {
    const h = setTimeout(() => { dismissToast(id) }, duration)
    _toastTimers.set(id, h)
  }
}

function dismissToast(id: number): void {
  const h = _toastTimers.get(id)
  if (h != null) { clearTimeout(h); _toastTimers.delete(id) }
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

// ── Alert (blocking, single button) ────────────────────────────────────────
function alert(
  message: string,
  opts: { title?: string; confirmText?: string } = {}
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Resolve any existing dialog with false (cancel) so its promise doesn't hang.
    if (dialog.value) dialog.value.resolve(false)
    dialog.value = {
      kind: 'alert',
      title: opts.title ?? 'Alert',
      message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: '',
      resolve: () => resolve()
    }
  })
}

// ── Confirm (blocking, yes/no → Promise<boolean>) ──────────────────────────
function confirm(
  message: string,
  opts: { title?: string; confirmText?: string; cancelText?: string } = {}
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Resolve any existing dialog with false (cancel) so its promise doesn't hang.
    if (dialog.value) dialog.value.resolve(false)
    dialog.value = {
      kind: 'confirm',
      title: opts.title ?? 'Confirm',
      message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      resolve
    }
  })
}

/** Called by the host when a dialog button is pressed (or dismissed). */
function resolveDialog(value: boolean): void {
  const d = dialog.value
  dialog.value = null
  d?.resolve(value)
}

export function useNotify() {
  return {
    toasts: readonly(toasts),
    dialog: readonly(dialog),
    toast,
    dismissToast,
    alert,
    confirm,
    resolveDialog
  }
}
