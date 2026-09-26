// Lets a shortcut recorder take fn (🌐) as a key. Browsers never deliver fn,
// so while a hold-to-talk recorder listens it subscribes to the native helper
// (macOS; see src/main/fn-key-helper.ts) and reports a lone fn press — down,
// then up with nothing pressed in between — through `onFn`. fn used as a
// modifier (fn+arrow, fn+Delete) is a CHORD: fn is not recorded, and the key
// it produced reaches the recorder as an ordinary keydown.
//
// The helper's state is kept in `status`, so a recorder can say why fn is not
// being seen (no Input Monitoring access, helper missing or crashed) instead
// of staying silent when it is pressed.
import { onScopeDispose, ref } from 'vue'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import type { FnKeyApi, FnKeyEventType, FnKeyStatus } from '../../../shared/fnKey'

export function useFnKeyRecorder(onFn: () => void, api: FnKeyApi | undefined = isMacPlatform() ? window.agentTeam?.fnKey : undefined) {
  const listening = ref(false)
  const status = ref<FnKeyStatus | null>(null)
  let offEvent: (() => void) | null = null
  let offStatus: (() => void) | null = null
  let down = false

  function onEvent(type: FnKeyEventType): void {
    if (type === 'down') {
      // The helper sees fn system-wide; a press in another app is not ours.
      down = document.hasFocus()
      return
    }
    const lone = type === 'up' && down
    down = false
    if (lone) onFn()
  }

  function start(): void {
    if (listening.value) return
    listening.value = true
    down = false
    if (!api) return
    offStatus = api.onStatus((s) => {
      status.value = s
    })
    offEvent = api.onEvent((e) => onEvent(e.type))
    api.subscribe().then(
      (s) => {
        if (listening.value) status.value = s
      },
      () => {
        if (listening.value) status.value = { phase: 'failed', fnUsage: null }
      },
    )
  }

  function stop(): void {
    if (!listening.value) return
    listening.value = false
    offEvent?.()
    offStatus?.()
    offEvent = offStatus = null
    status.value = null
    if (api) void api.unsubscribe().catch(() => {})
  }

  /** Asks macOS for Input Monitoring (its prompt shows the first time only). */
  async function requestPermission(): Promise<void> {
    if (!api) return
    const s = await api.requestPermission()
    if (listening.value) status.value = s
  }

  /** Starts a helper that crashed or was missing over. */
  async function retry(): Promise<void> {
    if (!api || !listening.value) return
    await api.unsubscribe()
    const s = await api.subscribe()
    if (listening.value) status.value = s
  }

  function openSettings(which: 'input-monitoring' | 'keyboard'): void {
    void api?.openSettings(which)
  }

  onScopeDispose(stop)

  return {
    /** Whether fn can be watched here at all (macOS with the relay). */
    available: !!api,
    listening,
    status,
    start,
    stop,
    requestPermission,
    retry,
    openSettings,
  }
}

export type FnKeyRecorder = ReturnType<typeof useFnKeyRecorder>
