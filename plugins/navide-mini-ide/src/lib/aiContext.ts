/** Presentation helpers only; the Host owns the actual AI CLI session ID. */
export function aiTerminalPaneId(surface: string, workspacePath: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < workspacePath.length; index++) {
    hash ^= workspacePath.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${surface}-ai-terminal`
}

export function bracketedPaste(text: string): string {
  return `\u001b[200~${text}\u001b[201~`
}

export function truncateText(text: string, at: number): string {
  return text.length <= at ? text : text.slice(0, at) + '…[truncated]'
}
