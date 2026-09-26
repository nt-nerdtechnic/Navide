/** Host-owned terminal presentation state. Process and storage identities are
 * derived from the authenticated contribution, never supplied by consumers. */
export interface AiTerminalViewState {
  fontSize: number
  lastSize: { cols: number; rows: number } | null
  snapshot: string | null
}

export interface AiTerminalParams {
  'aiCli.readTerminalView': Record<string, never>
  'aiCli.saveTerminalView': { sessionId: string; snapshots: string[] }
  'aiCli.setTerminalFontSize': { fontSize: number }
  'aiCli.listMentionTargets': { sessionId: string }
  'aiCli.saveClipboardImage': { sessionId: string; bytes: number[]; mediaType: string }
  'aiCli.showTerminalContextMenu': { sessionId?: string; selection: string }
  'aiCli.reportTerminalSelection': { sessionId?: string; selection: string }
}

export interface AiTerminalResults {
  'aiCli.readTerminalView': AiTerminalViewState
  'aiCli.saveTerminalView': Record<string, never>
  'aiCli.setTerminalFontSize': Record<string, never>
  'aiCli.listMentionTargets': { targets: Array<{ address: string; group?: string }> }
  'aiCli.saveClipboardImage': { path: string | null }
  'aiCli.showTerminalContextMenu': Record<string, never>
  'aiCli.reportTerminalSelection': Record<string, never>
}
