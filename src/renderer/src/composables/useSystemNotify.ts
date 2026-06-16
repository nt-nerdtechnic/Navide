import { readonly, ref } from 'vue'

/**
 * Native OS notifications for CLI pane state changes (turn done / needs input).
 *
 * Singleton module-level state so the App-root agent.activity handler can fire
 * notifications without prop drilling. The actual OS notification is shown by
 * the Electron main process via `window.agentTeam.notify` (see preload); this
 * composable only decides WHEN to fire:
 *   • background-only — never notify while a main window is focused, or the user
 *     would be interrupted during active use, and
 *   • deduped per pane — the same (paneId, kind) won't fire twice in a row; a new
 *     turn (agent_active → markActive) re-arms it.
 *
 * The gating decision is factored into the pure `shouldNotify` so it can be
 * unit-tested without DOM focus events or the IPC bridge.
 */

export type NotifyKind = 'done' | 'attention'

/** Pure gate: notify only when the app is backgrounded AND this is not a repeat
 *  of the last kind already notified for the pane. */
export function shouldNotify(args: {
  appFocused: boolean
  lastKind: NotifyKind | undefined
  kind: NotifyKind
}): boolean {
  if (args.appFocused) return false
  return args.lastKind !== args.kind
}

// ── Module-level singleton state ──────────────────────────────────────────
// Start focused: the app is in the foreground when it launches, so we don't
// notify for activity the user is actively watching before the first blur.
const appFocused = ref(true)
// Last kind notified per pane, for dedup. Cleared on markActive (new turn) and
// forgetPane (pane removed).
const lastKindByPane = new Map<string, NotifyKind>()
let listenersBound = false

function bindFocusListeners(): void {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true
  // Electron renders each main window in its own renderer; window focus/blur
  // reflects whether THIS window has the OS focus, which is exactly the
  // "is the user looking at me" signal we want for background-only notifies.
  appFocused.value = document.hasFocus()
  window.addEventListener('focus', () => { appFocused.value = true })
  window.addEventListener('blur', () => { appFocused.value = false })
}

/** Fire a native notification for a pane state change, subject to the gate.
 *  `title`/`body` are already localized by the caller (main stays i18n-agnostic). */
function notifyPaneState(
  paneId: string,
  kind: NotifyKind,
  title: string,
  body: string
): void {
  bindFocusListeners()
  if (!shouldNotify({ appFocused: appFocused.value, lastKind: lastKindByPane.get(paneId), kind })) {
    return
  }
  lastKindByPane.set(paneId, kind)
  void window.agentTeam?.notify({ paneId, title, body })
}

/** A pane produced new activity (new turn): re-arm notifications for it so the
 *  next done/attention fires even if it matches the previous notification. */
function markActive(paneId: string): void {
  lastKindByPane.delete(paneId)
}

/** A pane was removed: drop its dedup state. */
function forgetPane(paneId: string): void {
  lastKindByPane.delete(paneId)
}

export function useSystemNotify() {
  bindFocusListeners()
  return {
    appFocused: readonly(appFocused),
    notifyPaneState,
    markActive,
    forgetPane,
  }
}
