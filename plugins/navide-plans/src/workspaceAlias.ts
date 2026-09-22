/** What to call a workspace on screen, for this package alone.
 *
 *  A deliberate, minimal copy of the one rule the renderer's
 *  `src/renderer/src/lib/workspaceAlias.ts` encodes for display: the alias the
 *  user gave the workspace wins, and a blank one is the same as none, because
 *  that is how clearing an alias works. This package cannot import that module
 *  (the shared-ownership boundary test fails any `src/renderer` specifier),
 *  and the Host's key-normalisation and alias-map helpers are of no use here:
 *  the Host resolves the alias and hands this bundle the finished string in
 *  `?workspace_display_name=`.
 *
 *  The PATH stays the identity. This is display only. */
export function workspaceBasename(path: string): string {
  const cleaned = path.replace(/\\/g, '/')
  return cleaned.split('/').filter(Boolean).pop() ?? cleaned
}

/** The alias when there is one, otherwise the workspace's folder name. */
export function workspaceDisplayName(path: string, alias?: string | null): string {
  return alias?.trim() || workspaceBasename(path)
}
