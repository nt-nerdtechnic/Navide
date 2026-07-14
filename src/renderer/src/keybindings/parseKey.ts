import type { ParsedKey } from './types'

const ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  bs: 'backspace',
  pgup: 'pageup',
  pgdown: 'pagedown',
}

export function parseKey(segment: string): ParsedKey {
  const parts = segment.toLowerCase().split('+')
  let meta = false, ctrl = false, shift = false, alt = false
  const keyParts: string[] = []
  for (const p of parts) {
    if (p === 'cmd' || p === 'meta' || p === 'mod') meta = true
    else if (p === 'ctrl' || p === 'control') ctrl = true
    else if (p === 'shift') shift = true
    else if (p === 'alt' || p === 'option') alt = true
    else keyParts.push(p)
  }
  const raw = keyParts.join('+')
  return { meta, ctrl, shift, alt, key: ALIASES[raw] ?? raw }
}

// Supports single key ("cmd+s") and chords ("ctrl+k ctrl+s").
export function parseKeySpec(spec: string): ParsedKey[] {
  return spec.trim().split(/\s+/).map(parseKey)
}

export function eventToParsedKey(e: KeyboardEvent): ParsedKey {
  return {
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  }
}

export function parsedKeyEquals(a: ParsedKey, b: ParsedKey): boolean {
  return a.meta === b.meta && a.ctrl === b.ctrl && a.shift === b.shift &&
    a.alt === b.alt && a.key === b.key
}

function eventKeyMatches(expectedKey: string, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() === expectedKey) return true

  // `KeyboardEvent.key` is layout/IME-dependent. With Chinese input methods
  // the physical slash key may be reported as `Process`, `Unidentified`, or a
  // localized character, which made Cmd+/ silently miss its binding. Use the
  // physical key as a fallback for slash shortcuts while retaining `key` as
  // the primary match for user-facing keybinding semantics.
  if (expectedKey === '/') {
    return e.code === 'Slash' || e.code === 'NumpadDivide'
  }

  return false
}

export function matchesEvent(parsed: ParsedKey, e: KeyboardEvent): boolean {
  if (parsed.meta !== e.metaKey) return false
  if (parsed.ctrl !== e.ctrlKey) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  return eventKeyMatches(parsed.key, e)
}
