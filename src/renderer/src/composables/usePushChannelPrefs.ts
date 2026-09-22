// Which CLIs may be handed a message without it being typed into the pane.
//
// A negative list: every declared channel is on until the user says otherwise,
// so a vendor that gains one later needs no migration. The backend reads the
// same key (push_delivery.DISABLED_SETTING_KEY) and is the only place the
// switch is applied.
//
// Module-scoped ref, like useCliAgentPrefs: the Settings page is not the only
// window that can show it, and a second window editing the same switch has to
// repaint this one rather than sit on a stale copy until reload.

import { ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

/** The key both sides agree on — see push_delivery.DISABLED_SETTING_KEY. */
export const PUSH_DISABLED_KEY = 'pushChannelsDisabled'

function load(): string[] {
  const raw = settingsGet<string[]>(PUSH_DISABLED_KEY, [])
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

const pushDisabled = ref<string[]>(load())

/** Last list this window wrote or read back. Comparing the serialized value —
 *  rather than raising a boolean flag — is what stops a broadcast we caused
 *  from re-entering as a remote change; the same guard useStatusBadgePrefs uses. */
let lastSynced = JSON.stringify(pushDisabled.value)

onSettingsChanged((keys) => {
  if (!keys.includes(PUSH_DISABLED_KEY)) return
  const incoming = load()
  const serialized = JSON.stringify(incoming)
  if (serialized === lastSynced) return
  lastSynced = serialized
  pushDisabled.value = incoming
})

export function pushChannelEnabled(agentKey: string): boolean {
  return !pushDisabled.value.includes(agentKey)
}

/** Flip one vendor's channel. There is deliberately no "keep at least one"
 *  rule, unlike the CLI-agents list: turning every channel off is a valid
 *  choice — messages are simply typed in, which is what every pane did before
 *  channels existed. */
export function togglePushChannel(agentKey: string): void {
  const set = new Set(pushDisabled.value)
  if (set.has(agentKey)) set.delete(agentKey)
  else set.add(agentKey)
  const next = [...set]
  const serialized = JSON.stringify(next)
  pushDisabled.value = next
  if (serialized === lastSynced) return
  lastSynced = serialized
  settingsSet(PUSH_DISABLED_KEY, next)
}

export function usePushChannelPrefs() {
  return { pushDisabled }
}
