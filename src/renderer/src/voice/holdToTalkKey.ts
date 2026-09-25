import { parseKeySpec } from '@navide/plugin-ui/shared'

/**
 * Why a key cannot be the hold-to-talk key, or null when it can.
 *
 *   'meta'        a ⌘ combination: macOS drops the keyup of a key held with
 *                 ⌘, so the take could never be let go of
 *   'meta-alone'  ⌘ by itself: its own keyup does arrive, but every ⌘ shortcut
 *                 (⌘C, ⌘V...) starts with it, so each would start a take
 *   'typing-key'  a key that types or edits (a letter, digit, space,
 *                 punctuation, Enter, Tab, Backspace, Delete, Esc), with no
 *                 ⌃ or ⌥: holding it would type into the CLI, and Enter / Esc
 *                 already mean send / cancel. ⇧ alone does not help — it still
 *                 types.
 *
 * Accepted: function keys (F1–F24), a single modifier by itself other than ⌘
 * ('rightalt'), other non-printing keys, and combinations with ⌃ or ⌥.
 */
export type HoldToTalkKeyProblem = 'meta' | 'meta-alone' | 'typing-key'

const TYPING_NAMED = new Set(['space', ' ', 'enter', 'tab', 'backspace', 'delete', 'escape'])

export function holdToTalkKeyProblem(spec: string): HoldToTalkKeyProblem | null {
  for (const k of parseKeySpec(spec)) {
    if (k.key === 'leftcmd' || k.key === 'rightcmd') return 'meta-alone'
    if (k.meta) return 'meta'
    if (!k.ctrl && !k.alt && (k.key.length === 1 || TYPING_NAMED.has(k.key))) return 'typing-key'
  }
  return null
}
