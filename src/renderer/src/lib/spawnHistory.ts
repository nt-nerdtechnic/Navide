export interface HistoryTitleEntry {
  paneId: string
  agentLabel: string
  customName?: string
}

export function historyEntryLabel(entry: HistoryTitleEntry): string {
  return entry.customName || entry.agentLabel
}

export function updateHistoryCustomName(
  entries: HistoryTitleEntry[],
  paneId: string,
  customName?: string
): boolean {
  const entry = entries.find((candidate) => candidate.paneId === paneId)
  if (!entry) return false
  entry.customName = customName?.trim() || undefined
  return true
}
