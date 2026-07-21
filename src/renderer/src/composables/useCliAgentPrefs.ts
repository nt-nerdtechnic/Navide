// User preferences for which CLI agents appear in the manual-spawn dropdown and
// in what order. Module-scoped singleton refs so the Settings modal (writer) and
// App.vue (reader) share one reactive source — a plain settingsGet() is not
// reactive, so a shared ref is what makes a settings edit reflect live.
//
// Persistence: backend-owned KV via settings.ts (settingsGet/settingsSet), keyed
// per-user (not per-workspace). Unset → all enabled, order = agentSpecs order
// (backward compatible: a fresh install sees today's behaviour unchanged).

import { ref, watch } from 'vue'

import { settingsGet, settingsSet } from '../lib/settings'

const ORDER_KEY = 'agentTeam.cliAgents.order' // string[] of agentKeys, custom order
const DISABLED_KEY = 'agentTeam.cliAgents.disabled' // string[] of disabled agentKeys

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

watch(order, (v) => settingsSet(ORDER_KEY, JSON.stringify(v)), { deep: true })
watch(disabled, (v) => settingsSet(DISABLED_KEY, JSON.stringify(v)), { deep: true })

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
