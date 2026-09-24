import { AGENT_SPECS, cliPermissionKey, parseCliPermissionMode, skipPermissionFlagFor } from '@navide/plugin-shell'
import { settingsGet } from '@navide/plugin-ui/shared'

/**
 * Whether a fresh spawn of `agentKey` would carry its permission-bypass flag,
 * resolved the same way App.vue's skipFlagFor() does (global YOLO toggle +
 * per-vendor override). Read from settings, so a pane spawned before the
 * toggle last changed may differ — good enough for a warning line.
 */
export function vendorRunsYolo(agentKey: string): boolean {
  const spec = AGENT_SPECS.find((s) => s.agentKey === agentKey)
  const stored = settingsGet<string | null>('agentTeam.yolo', null)
  return (
    skipPermissionFlagFor({
      spec,
      globalYolo: stored === null ? true : stored === '1',
      mode: parseCliPermissionMode(settingsGet<string | null>(cliPermissionKey(agentKey), null)),
    }) !== ''
  )
}
