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

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(
  message: string,
  opts: { type?: ToastType; duration?: number } = {}
): void {
  const id = ++seq
  toasts.value.push({ id, message, type: opts.type ?? 'info' })
  const duration = opts.duration ?? 4000
  if (duration > 0) setTimeout(() => dismissToast(id), duration)
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

// ── Alert (blocking, single button) ────────────────────────────────────────
function alert(
  message: string,
  opts: { title?: string; confirmText?: string } = {}
): Promise<void> {
  return new Promise<void>((resolve) => {
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
