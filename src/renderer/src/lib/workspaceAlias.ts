/** A workspace's display name: the alias the user gave it, else its folder name.
 *
 *  The PATH stays the identity everywhere — comparisons, map keys, addressing.
 *  An alias is display only and is deliberately allowed to repeat: two projects
 *  may both be called "api", and the path under the name is what tells them
 *  apart. Nothing here validates or de-duplicates.
 */

/** The map key for a workspace path: trailing slashes trimmed, nothing else.
 *  Case is kept — the backend's project records are case-sensitive too, and
 *  folding it here would merge two real folders on a case-sensitive volume.
 *
 *  KNOWN LIMITATION — `~` is NOT expanded here. The backend's
 *  `RecentWorkspacesStore._normalize` does `abspath(expanduser(path))`, so the
 *  mirrored name for `~/Desktop/foo` is filed under the expanded absolute
 *  path. A window whose workspace path is still the tilde form would therefore
 *  look the alias up under a key that nothing writes to, and the row would
 *  fall back to the folder name after a restart (the local override set by the
 *  rename itself masks it until then).
 *
 *  Left as-is deliberately: nothing in the UI produces a tilde path — the
 *  picker returns an absolute path, the recent list stores the backend's
 *  normalised one — so this is only reachable through an external caller
 *  (a CLI argument, a deep link, MCP `workspace_open`). Expanding it here
 *  would need a home directory that this module has no business knowing, and
 *  would make this key normalise DIFFERENTLY from `normWs` in App.vue and
 *  `norm` in workspaceGroups.ts, which do not expand either — one comparison
 *  out of step with the rest is worse than a gap that is the same everywhere. */
export function workspaceAliasKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** The alias itself, or `''` when the workspace has none.
 *
 *  Distinct from `workspaceDisplayName` on purpose: that one answers "what does
 *  this row say", which is never empty, while this answers "has the user named
 *  this workspace", which the rename editor needs in order to tell "left the
 *  box untouched" apart from "typed the folder name in".
 *
 *  Only as true as the map it reads. `useWorkspaceAliases` builds it without
 *  the recent store's basename fallback for an unaliased workspace — and, as a
 *  deliberate side effect, without an alias that happens to equal the folder
 *  name, which on screen is the same row. So `''` here means "no alias, or one
 *  the folder name already says". */
export function workspaceAliasOf(
  path: string,
  aliases?: Readonly<Record<string, string>>,
): string {
  if (!path) return ''
  return aliases?.[workspaceAliasKey(path)]?.trim() ?? ''
}

/** The last path segment — the name a workspace has when it has no alias. */
export function workspaceBasename(path: string): string {
  const cleaned = path.replace(/\\/g, '/')
  return cleaned.split('/').filter(Boolean).pop() ?? cleaned
}

/** What to show for `path`: its alias if one is set, otherwise the folder name.
 *
 *  A blank alias is the same as none — that is how clearing works, so an empty
 *  string must never reach the screen in place of a name. */
export function workspaceDisplayName(
  path: string,
  aliases?: Readonly<Record<string, string>>,
): string {
  if (!path) return ''
  return workspaceAliasOf(path, aliases) || workspaceBasename(path)
}
