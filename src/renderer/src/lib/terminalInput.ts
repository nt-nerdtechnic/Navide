/** Rules for typing into a plain terminal pane (agentKey "terminal"), whose
 *  shell runs whatever reaches it. */

/** Why a multi-line command cannot be typed into a shell, or null. Without
 *  bracketed paste (mode 2004 off: macOS /bin/bash 3.2, sh, a shell that never
 *  enables it) every embedded newline is an Enter, so the lines would run one
 *  by one as they arrive — and the paste guards would land as literal text. */
export function terminalMultilineRefusal(text: string, bracketedPasteActive: boolean): string | null {
  if (!text.includes('\n') || bracketedPasteActive) return null
  return "not typed: this terminal's shell has no bracketed paste, so a multi-line "
    + 'command would run line by line as it arrives — send one line at a time'
}
