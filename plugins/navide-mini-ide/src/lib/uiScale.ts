import { native } from '../composables/native'
// Interface scale remains Host-owned. The shared cache reflects the local
// change immediately; the public native capability persists and applies it.

import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  clampUiScale,
  DEFAULT_UI_SCALE,
  stepUiScale,
  UI_SCALE_SETTING_KEY
} from '@navide/plugin-ui/shared'

export {
  clampUiScale,
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_SETTING_KEY,
  UI_SCALE_STEPS,
  formatUiScale
} from '@navide/plugin-ui/shared'

/** Current interface scale, read live from the settings cache. */
export function getUiScale(): number {
  return clampUiScale(settingsGet(UI_SCALE_SETTING_KEY, DEFAULT_UI_SCALE))
}

/**
 * Persist a new scale and ask the main process to apply it to every window.
 * Returns the clamped value that was stored, so callers can reflect back the
 * value that actually took effect rather than the raw input.
 */
export function setUiScale(next: unknown): number {
  const scale = clampUiScale(next)
  settingsSet(UI_SCALE_SETTING_KEY, scale)
  void native.setUiScale(scale)
  return scale
}

/** Move one notch up (+1) or down (-1) the scale ladder and apply it. */
export function stepUiScaleBy(direction: 1 | -1): number {
  return setUiScale(stepUiScale(getUiScale(), direction))
}

/** Restore 100%. */
export function resetUiScale(): number {
  return setUiScale(DEFAULT_UI_SCALE)
}
