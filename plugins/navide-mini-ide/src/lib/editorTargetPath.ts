/** Split a receiver-supplied editor target into the (filepath, wsPath) pair a
 *  tab is keyed by. An absolute path inside one of `roots` (the window's
 *  workspace and its canonical spelling) becomes workspace-relative, so it
 *  lands on the tab the explorer already opened; anything else is addressed by
 *  its own directory, like ⌘O does. */
export function splitEditorTarget(path: string, roots: string[]): { filepath: string; wsPath?: string } {
  if (!path.startsWith('/')) return { filepath: path }
  for (const root of roots) {
    if (!root) continue
    const prefix = root.replace(/\/+$/, '') + '/'
    if (path.startsWith(prefix) && path.length > prefix.length) return { filepath: path.slice(prefix.length) }
  }
  const cut = path.lastIndexOf('/')
  return { filepath: path.slice(cut + 1), wsPath: path.slice(0, cut) || '/' }
}
