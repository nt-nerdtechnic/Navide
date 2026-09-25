import { canonicalizeKeySpec, isLoneModifierKey, MENU_OWNED_SPECS, parseKeySpec, validateKeySpec } from '@navide/plugin-ui/shared'
import type { VoiceRecordingMode } from './voiceSettings'

/**
 * Why a key cannot be the hold-to-talk key in a recording mode, or null when
 * it can.
 *
 *   'meta'           a ⌘ combination outside toggle mode: macOS drops the
 *                    keyup of a key held with ⌘, so a held take could never
 *                    be let go of. Toggle mode needs no keyup — the second
 *                    press (a keydown) stops the take — so there it is fine.
 *   'meta-alone'     ⌘ by itself, in every mode: its own keyup does arrive,
 *                    but every ⌘ shortcut (⌘C, ⌘V...) starts with it, so each
 *                    would start a take
 *   'macos-reserved' a chord macOS itself acts on (⌘Q, ⌘Tab, ⌘Space...);
 *                    reservedChordAction names what it does
 *   'menu'           a chord the application menu takes before the renderer
 *                    sees the key, so the rule would never fire
 *   'typing-key'     a key that types or edits (a letter, digit, space,
 *                    punctuation, Enter, Tab, Backspace, Delete, Esc), with no
 *                    ⌃, ⌥ or ⌘: holding it would type into the CLI, and Enter /
 *                    Esc already mean send / cancel. ⇧ alone does not help — it
 *                    still types.
 *
 * Accepted: function keys (F1–F24), a single modifier by itself other than ⌘
 * ('rightalt'), other non-printing keys, combinations with ⌃ or ⌥, and — in
 * toggle mode — combinations with ⌘.
 *
 * A clash with another Navide binding is not decided here: it needs the live
 * rule table (see VoiceShortcutRow).
 */
export type HoldToTalkKeyProblem = 'meta' | 'meta-alone' | 'macos-reserved' | 'menu' | 'typing-key'

const TYPING_NAMED = new Set(['space', ' ', 'enter', 'tab', 'backspace', 'delete', 'escape'])

// Chords macOS acts on itself, before or instead of the app; the value is the
// i18n id (settings.voice.reserved.*) naming what the chord does.
const MACOS_RESERVED: ReadonlyMap<string, string> = new Map(
  (
    [
      ['cmd+q', 'quit'],
      ['cmd+w', 'close-window'],
      ['cmd+h', 'hide'],
      ['cmd+alt+h', 'hide-others'],
      ['cmd+m', 'minimize'],
      ['cmd+tab', 'app-switcher'],
      ['cmd+shift+tab', 'app-switcher'],
      ['cmd+`', 'window-cycle'],
      ['cmd+shift+`', 'window-cycle'],
      ['cmd+space', 'spotlight'],
      ['cmd+alt+space', 'finder-search'],
      ['cmd+ctrl+space', 'emoji'],
      ['cmd+,', 'settings'],
      ['cmd+shift+q', 'log-out'],
      ['cmd+ctrl+q', 'lock-screen'],
      ['cmd+alt+escape', 'force-quit'],
      ['cmd+ctrl+f', 'full-screen'],
      ['cmd+alt+d', 'dock'],
      ['cmd+shift+3', 'screenshot'],
      ['cmd+shift+4', 'screenshot'],
      ['cmd+shift+5', 'screenshot'],
    ] as const
  ).map(([spec, action]) => [canonicalizeKeySpec(spec), action]),
)

/** What macOS does with `spec` (an i18n id under settings.voice.reserved), or null. */
export function reservedChordAction(spec: string): string | null {
  return MACOS_RESERVED.get(canonicalizeKeySpec(spec)) ?? null
}

export function holdToTalkKeyProblem(spec: string, mode: VoiceRecordingMode): HoldToTalkKeyProblem | null {
  for (const k of parseKeySpec(spec)) {
    if (k.key === 'leftcmd' || k.key === 'rightcmd') return 'meta-alone'
    if (k.meta && mode !== 'toggle') return 'meta'
    if (!k.ctrl && !k.alt && !k.meta && (k.key.length === 1 || TYPING_NAMED.has(k.key))) return 'typing-key'
  }
  if (reservedChordAction(spec)) return 'macos-reserved'
  if (MENU_OWNED_SPECS.has(canonicalizeKeySpec(spec))) return 'menu'
  return null
}

const FALLBACKS = ['f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'rightalt', 'rightctrl']

/**
 * Up to `count` keys to offer instead of a refused `spec`: valid in `mode`,
 * free of every key in `taken` (the live rule table), of macOS and of the
 * application menu. Keys near the refused one come first — its main key under
 * other modifiers (⌘ ones only in toggle mode) — then function keys and a
 * lone right modifier.
 */
export function suggestHoldToTalkKeys(spec: string, mode: VoiceRecordingMode, taken: ReadonlySet<string>, count = 3): string[] {
  const main = parseKeySpec(spec).at(-1)?.key ?? ''
  const near: string[] = []
  if (main && !isLoneModifierKey(main)) {
    const key = main === ' ' ? 'space' : main
    const mods = mode === 'toggle'
      ? ['cmd+ctrl', 'cmd+alt', 'cmd+alt+shift', 'cmd+ctrl+shift', 'ctrl+alt', 'ctrl+alt+shift']
      : ['ctrl+alt', 'ctrl+alt+shift', 'ctrl+shift']
    near.push(...mods.map((m) => `${m}+${key}`))
  }
  const out: string[] = []
  for (const candidate of [...near, ...FALLBACKS]) {
    const canonical = canonicalizeKeySpec(candidate)
    if (canonical === canonicalizeKeySpec(spec) || taken.has(canonical) || out.includes(canonical)) continue
    if (!validateKeySpec(canonical).ok || holdToTalkKeyProblem(canonical, mode)) continue
    out.push(canonical)
    if (out.length >= count) break
  }
  return out
}
