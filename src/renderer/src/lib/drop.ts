/**
 * Extracts native file-system paths from a DragEvent.
 *
 * Uses window.agentTeam.getPathForFile (bridged via Electron preload with
 * webUtils.getPathForFile) because File.path is only available in Electron's
 * main world; the renderer runs in the isolated world with contextIsolation:true.
 *
 * Prefers dt.items over dt.files because folders are reliably surfaced via
 * items.getAsFile() in Electron even when dt.files is empty.
 */
export function extractDropPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const getPath = window.agentTeam?.getPathForFile
  if (!getPath) return []

  const sources: File[] = dt.items?.length
    ? Array.from(dt.items)
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter((f): f is File => f !== null)
    : Array.from(dt.files)

  if (sources.length) return sources.map(f => getPath(f)).filter(Boolean)

  // Fallback: paths set via dataTransfer.setData('text/plain', ...) by in-app drags
  const text = dt.getData('text/plain')
  return text ? text.split('\n').map(p => p.trim()).filter(Boolean) : []
}

/** Shell-escape a path so it can be safely pasted into a PTY command line. */
export function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`
}
