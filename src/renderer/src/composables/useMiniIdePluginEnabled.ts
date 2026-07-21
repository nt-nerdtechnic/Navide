// Whether the mini-IDE plugin layer is opted in (AGENT_TEAM_MINI_IDE_PLUGIN=1),
// as reported by the main process. The Extensions entry in Settings gates on
// this so the whole plugin surface is absent when the flag is off.
//
// The flag is a main-process env read; the renderer learns it via the
// `plugins.isEnabled` IPC. This resolves asynchronously, so the ref starts
// `false` (fail-closed: hide until confirmed enabled) and flips true only when
// the main process confirms.

import { ref, type Ref } from 'vue'

/**
 * Returns a reactive boolean that becomes true once the main process confirms
 * the plugin flag is on. Starts false and stays false when the plugins API is
 * unavailable (e.g. older preload, or the flag off). Never throws.
 */
export function useMiniIdePluginEnabled(): Ref<boolean> {
  const enabled = ref(false)
  const api = window.agentTeam?.plugins
  if (api?.isEnabled) {
    void api
      .isEnabled()
      .then((on) => {
        enabled.value = on === true
      })
      .catch(() => {
        // IPC failed → keep the surface hidden.
        enabled.value = false
      })
  }
  return enabled
}
