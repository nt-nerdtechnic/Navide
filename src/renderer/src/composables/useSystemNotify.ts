import { computed, readonly, ref } from 'vue'

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
 *
 * Separately, `pendingCount` drives the macOS Dock badge (Terminal.app-style:
 * a number for how many panes have unseen done/attention activity). Unlike the
 * OS notification above, it is NOT gated by appFocused/dedup — it tracks true
 * pending state, and only clears when the user actually switches to that pane
 * (`markSeen`) or the pane starts a new turn (`markActive`).
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
// Panes with unseen done/attention activity, for the Dock badge count. Cleared
// on markSeen (user switched to the pane), markActive (new turn superseded the
// pending state), and forgetPane.
const pendingPanes = ref(new Set<string>())
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
  pendingPanes.value.add(paneId)
  if (!shouldNotify({ appFocused: appFocused.value, lastKind: lastKindByPane.get(paneId), kind })) {
    return
  }
  lastKindByPane.set(paneId, kind)
  void window.agentTeam?.notify({ paneId, title, body })
}

/** A pane produced new activity (new turn): re-arm notifications for it so the
 *  next done/attention fires even if it matches the previous notification, and
 *  drop it from the Dock badge count since the pending state is superseded. */
function markActive(paneId: string): void {
  lastKindByPane.delete(paneId)
  pendingPanes.value.delete(paneId)
}

/** The user switched to this pane: clear its Dock badge pending state. */
function markSeen(paneId: string): void {
  pendingPanes.value.delete(paneId)
}

/** A pane was removed: drop its dedup and pending state. */
function forgetPane(paneId: string): void {
  lastKindByPane.delete(paneId)
  pendingPanes.value.delete(paneId)
}

const pendingCount = computed(() => pendingPanes.value.size)

export function useSystemNotify() {
  bindFocusListeners()
  return {
    appFocused: readonly(appFocused),
    pendingCount,
    notifyPaneState,
    markActive,
    markSeen,
    forgetPane,
  }
}
