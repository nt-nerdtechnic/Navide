// User preferences for which CLI agents appear in the manual-spawn dropdown and
// in what order. Module-scoped singleton refs so the Settings modal (writer) and
// App.vue (reader) share one reactive source — a plain settingsGet() is not
// reactive, so a shared ref is what makes a settings edit reflect live.
//
// Persistence: primarily per-workspace, in project.json (App.vue watches
// `order`/`disabled` and calls project.set_ui_state, mirroring how run-group
// tabs are persisted); App.vue calls loadCliAgentPrefsFromProject() on every
// workspace switch to load that workspace's saved value. The global per-user
// KV (settings.ts) records every deliberate edit as a backstop — it's the only
// persistence when no workspace is open yet or the window is detached
// (App.vue's workspace-scoped save silently no-ops in both cases) — and
// doubles as the fallback default for a workspace that never persisted its own
// value, so existing users don't lose their current customization. Adopting a
// value (a workspace load, a peer window's edit) deliberately does NOT write
// it, or one workspace's list would overwrite that global default.

import { nextTick, ref, watch } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

const ORDER_KEY = 'agentTeam.cliAgents.order' // legacy global fallback default
const DISABLED_KEY = 'agentTeam.cliAgents.disabled' // legacy global fallback default

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(settingsGet(key, ''))
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // no/blank/corrupt setting → empty (caller treats as "no custom preference")
  }
  return []
}

const order = ref<string[]>(readStringArray(ORDER_KEY))
const disabled = ref<string[]>(readStringArray(DISABLED_KEY))

/** The serialized value this window last wrote to, or read out of, the global
 *  KV. Comparing the string — rather than raising a boolean — is what stops the
 *  broadcast our own write causes from re-entering as a remote change; the same
 *  guard useStatusBadgePrefs uses. */
let lastSyncedOrder = JSON.stringify(order.value)
let lastSyncedDisabled = JSON.stringify(disabled.value)

/** True while a *peer window's* edit is being adopted. App.vue watches these
 *  same two refs to persist them per workspace; without this it would write the
 *  peer's value straight back out and the two windows would trade writes.
 *
 *  A workspace load is deliberately NOT covered by this flag: seeding a
 *  workspace that never persisted its own list is exactly what that write is
 *  for. It is still kept out of the global KV below, so a workspace's own list
 *  can no longer overwrite the global fallback default — which is also what
 *  stops a peer window from adopting some other workspace's order. */
export const applyingRemoteCliAgentPrefs = ref(false)

/** Marking a value as already-synced BEFORE assigning it is what keeps the
 *  watches from writing it out again. A "suppress for now" flag cleared on
 *  nextTick does not work here: with no flush pending, that callback runs
 *  before the watcher jobs the assignment is about to queue. */
function adopt(nextOrder: string[] | null, nextDisabled: string[] | null): void {
  if (nextOrder) {
    lastSyncedOrder = JSON.stringify(nextOrder)
    order.value = nextOrder
  }
  if (nextDisabled) {
    lastSyncedDisabled = JSON.stringify(nextDisabled)
    disabled.value = nextDisabled
  }
}

function persist(key: string, value: string[], lastSynced: string): string {
  const serialized = JSON.stringify(value)
  if (serialized === lastSynced) return serialized
  settingsSet(key, serialized)
  return serialized
}

watch(order, (v) => { lastSyncedOrder = persist(ORDER_KEY, v, lastSyncedOrder) }, { deep: true })
watch(disabled, (v) => { lastSyncedDisabled = persist(DISABLED_KEY, v, lastSyncedDisabled) }, { deep: true })

// Another window editing this list has to reach this one's spawn dropdown: it
// is the same user, and the list is a per-user preference before it is a
// per-workspace one. (Windows sharing an open workspace also hear about it
// through project.ui_state_changed; this covers the rest — no workspace open
// yet, a detached window, or two windows on different projects.)
onSettingsChanged((keys) => {
  const orderBroadcast = keys.includes(ORDER_KEY)
  const disabledBroadcast = keys.includes(DISABLED_KEY)
  if (!orderBroadcast && !disabledBroadcast) return
  const incomingOrder = JSON.stringify(readStringArray(ORDER_KEY))
  const incomingDisabled = JSON.stringify(readStringArray(DISABLED_KEY))
  const orderChanged = orderBroadcast && incomingOrder !== lastSyncedOrder
  const disabledChanged = disabledBroadcast && incomingDisabled !== lastSyncedDisabled
  if (!orderChanged && !disabledChanged) return
  applyingRemoteCliAgentPrefs.value = true
  adopt(
    orderChanged ? (JSON.parse(incomingOrder) as string[]) : null,
    disabledChanged ? (JSON.parse(incomingDisabled) as string[]) : null
  )
  // After the assignments, so this chains onto the flush they just queued and
  // runs once App.vue's per-workspace watcher has seen the flag raised.
  void nextTick(() => { applyingRemoteCliAgentPrefs.value = false })
})

/**
 * Apply the workspace's persisted CLI agent order/disabled list (from
 * project.cli_agent_order / project.cli_agent_disabled). null/undefined
 * (never persisted for this workspace) falls back to the legacy global
 * default; [] is a valid "explicitly cleared to default" value.
 */
export function loadCliAgentPrefsFromProject(
  cliAgentOrder: string[] | null | undefined,
  cliAgentDisabled: string[] | null | undefined
): void {
  adopt(
    Array.isArray(cliAgentOrder) ? cliAgentOrder : readStringArray(ORDER_KEY),
    Array.isArray(cliAgentDisabled) ? cliAgentDisabled : readStringArray(DISABLED_KEY)
  )
}

/**
 * Order `agentKeys` by the user's custom order; keys not in the order keep their
 * original relative position, appended after the ordered ones (stable).
 */
export function orderedAgentKeys(agentKeys: string[]): string[] {
  const rank = (k: string) => {
    const i = order.value.indexOf(k)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...agentKeys].sort((a, b) => rank(a) - rank(b))
}

export function isAgentEnabled(agentKey: string): boolean {
  return !disabled.value.includes(agentKey)
}

export function useCliAgentPrefs() {
  return { order, disabled }
}
