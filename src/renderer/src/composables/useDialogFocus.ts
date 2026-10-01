import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus handling for an in-app modal dialog, open while `root` is rendered:
 * on open, focus moves into the dialog (to `initial` when given, else its
 * first control); Tab and Shift+Tab cycle inside it; on close, focus returns
 * to whatever had it before. Escape is left to each dialog, whose Escape
 * semantics differ. Returns `refocus`, for a dialog that swaps its controls
 * while staying open.
 */
export function useDialogFocus(
  root: Ref<HTMLElement | null>,
  initial?: () => HTMLElement | null | undefined
): { refocus: () => void } {
  let previous: HTMLElement | null = null

  function focusables(): HTMLElement[] {
    return root.value ? [...root.value.querySelectorAll<HTMLElement>(FOCUSABLE)] : []
  }

  function refocus(): void {
    void nextTick(() => {
      if (!root.value) return
      const target = initial?.() ?? focusables()[0] ?? root.value
      target.focus()
    })
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !root.value) return
    const items = focusables()
    if (items.length === 0) {
      event.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    const inside = active instanceof Node && root.value.contains(active)
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      first.focus()
    }
  }

  function restore(): void {
    if (previous?.isConnected) previous.focus()
    previous = null
  }

  watch(
    () => root.value !== null,
    (open, wasOpen) => {
      if (open && !wasOpen) {
        previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
        refocus()
      } else if (!open && wasOpen) {
        restore()
      }
    },
    { flush: 'post' }
  )

  // The template ref filling in on mount is itself the watcher's open edge.
  onMounted(() => document.addEventListener('keydown', onKeydown, true))

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
    if (root.value) restore()
  })

  return { refocus }
}
