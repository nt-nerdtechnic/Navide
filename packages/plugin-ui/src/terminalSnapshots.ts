/** Preserve the existing serialized terminal history semantics: serialize
 * fewer lines on quota pressure, never truncate an escape sequence. */
export function terminalSnapshotCandidates(
  serialize: (options: { scrollback: number; excludeAltBuffer: boolean }) => string,
  fullScreenTui: boolean,
): string[] {
  const render = (lines: number): string => {
    const payload = serialize({ scrollback: lines, excludeAltBuffer: !fullScreenTui })
    if (!fullScreenTui) return payload
    const found = /\x1b\[\?(?:1049|1047|47)h(?:\x1b\[H)?/.exec(payload)
    if (!found) return payload
    const rest = payload.slice(found.index + found[0].length)
    return found.index === 0 ? rest : `${payload.slice(0, found.index)}\r\n${rest}`
  }
  let lines = 2000
  let payload = render(lines)
  while (payload.length > 64 * 1024 && lines > 100) {
    lines = Math.floor(lines / 2)
    payload = render(lines)
  }
  if (!payload.trim()) return []
  const candidates = [payload]
  while (lines > 100) {
    lines = Math.floor(lines / 2)
    candidates.push(render(lines))
  }
  return candidates
}
/** Reset stale mouse/focus reporting without desynchronizing a live CLI's paste mode. */
export const TERMINAL_MOUSE_MODE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l'
export const TERMINAL_NEW_PROCESS_RESET = `${TERMINAL_MOUSE_MODE_RESET}\x1b[?2004l`
export const TERMINAL_RECONNECTED_DIVIDER = '\r\n\x1b[2m\x1b[38;5;240m─── reconnected ───\x1b[0m\r\n'
