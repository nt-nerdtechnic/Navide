/** True when typing `ch` (the just-typed char) at end of `lineBeforeCursor`
 *  should open the mention menu: ch is '@' or '＠', and the text before it is
 *  empty or ends with whitespace (so "a@b" mid-word does NOT trigger). */
export function shouldOpenMentionMenu(ch: string, lineBeforeCursor: string): boolean {
  return (ch === '@' || ch === '＠') && (lineBeforeCursor === '' || /\s$/.test(lineBeforeCursor))
}

/** The workspace-local broadcast keyword the mention menu offers. Shared so
 *  the menu can tell a broadcast apart from a named pane — ticking "everyone"
 *  alongside two names would deliver to those two twice. */
export const MENTION_BROADCAST_ADDRESS = 'all'

/** One address the @-mention menu can offer.
 *
 *  `group` and `statusLabel` arrive PRE-TRANSLATED. useTerminal owns no i18n
 *  scope by design (the same split onClear and onUserResume follow), so the
 *  host resolves every word and the menu only lays them out — which also keeps
 *  the menu's own logic (filtering, keys) free of locale concerns.
 */
export interface MentionCandidate {
  /** What gets typed into the prompt, e.g. "codex-1", "myproj/claude-2", "all". */
  address: string
  /** The section KEY. Candidates carrying the same one are drawn under a single
   *  header, in list order. Absent means "no section".
   *
   *  For a workspace section this is the workspace's absolute PATH, not its
   *  name: two projects can be called the same thing — the more so now that a
   *  project can be given a display name, which is allowed to repeat — and
   *  keying on the name merged their panes into one section. What the header
   *  shows is `groupLabel`. */
  group?: string
  /** Pre-translated section heading. Absent means the key is presentable as-is
   *  (the pre-path groups — "recent", "this window" — still are). Separate from
   *  `group` so a section can be keyed on something unique and titled with
   *  something readable. */
  groupLabel?: string
  /** The pane's DisplayStatus, when this window can read it. Absent for `all`
   *  and for panes living in another workspace window — those have no local
   *  TerminalPane ref to ask, and the menu draws a hollow dot rather than
   *  inventing a status. */
  status?: string
  /** Pre-translated word shown beside the dot, e.g. "執行中". */
  statusLabel?: string
}

/** The comparison form of mention text: case-folded and NFKC-normalised, so a
 *  full-width "ＣＯＤ" left behind by a CJK input method still finds "codex". */
export function foldMentionText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** Candidates whose address contains `query`, case-insensitively and
 *  regardless of full-width/half-width form.
 *
 *  Substring rather than fuzzy, matching the mini-IDE's Quick Open symbol
 *  filter: with a dozen candidates fuzzy only earns the surprise of a third
 *  typed character still showing unrelated rows. The whole address is matched,
 *  so "myproj/codex-1" answers to both "cod" and "myproj". */
export function filterMentionCandidates<T extends { address: string }>(
  candidates: readonly T[],
  query: string
): T[] {
  if (!query) return [...candidates]
  const needle = foldMentionText(query)
  return candidates.filter((c) => foldMentionText(c.address).includes(needle))
}

/** Cluster candidates so every group is contiguous — the menu draws a header
 *  wherever the group changes, so interleaved groups would draw it twice.
 *  Groups keep first-seen order, except `first` (the sender's own workspace)
 *  leads; order within a group is kept. */
export function clusterMentionCandidates(
  candidates: readonly MentionCandidate[],
  first?: string
): MentionCandidate[] {
  const buckets = new Map<string, MentionCandidate[]>()
  if (first) buckets.set(first, [])
  for (const c of candidates) {
    const key = c.group ?? ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(c)
    else buckets.set(key, [c])
  }
  return [...buckets.values()].flat()
}

/** Move recently-picked addresses to the front under `recentGroup`, newest
 *  first; everything else keeps its list order and its own group.
 *
 *  Re-grouping is the point: a recent address hoisted to the top while still
 *  labelled "this window" would sit under the wrong header, and the menu draws
 *  headers straight from this order. */
export function rankMentionCandidates(
  candidates: readonly MentionCandidate[],
  recents: readonly string[],
  recentGroup: string
): MentionCandidate[] {
  const byAddress = new Map(candidates.map((c) => [c.address, c]))
  const hoisted: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const address of recents) {
    const found = byAddress.get(address)
    if (found && !seen.has(address)) {
      seen.add(address)
      // The recents section is its own group, so the hoisted row must drop the
      // label its old group carried too — keeping it would title the recents
      // header with a project name.
      hoisted.push({ ...found, group: recentGroup, groupLabel: undefined })
    }
  }
  return [...hoisted, ...candidates.filter((c) => !seen.has(c.address))]
}

/** The recents list after `picked` was chosen: newest first, no duplicates,
 *  capped. Pure so the ordering survives a refactor of wherever it is stored. */
export function recordMentionRecents(
  recents: readonly string[],
  picked: readonly string[],
  cap: number
): string[] {
  // Insertion order, not reversed: a multi-pick writes "@a @b", and the menu
  // offering them back in that same order is what makes the list feel like a
  // memory of what was typed rather than a shuffle of it.
  const next = [...picked]
  for (const address of recents) {
    if (!next.includes(address)) next.push(address)
  }
  return next.slice(0, cap)
}

/** The single PTY write that completes a mention: erase the typed query, then
 *  insert the chosen addresses.
 *
 *  One write, not two: a separate erase would let the CLI redraw its prompt
 *  between the two halves, which is exactly when the flicker becomes visible.
 *  The DEL bytes are how the rest of this file spells backspace (see the
 *  selection-delete path in useTerminal). */
export function buildMentionPickData(query: string, addresses: readonly string[]): string {
  if (!addresses.length) return ''
  // One DEL per character the CLI sees, so count code points, not UTF-16
  // units: a query of "測試" is two backspaces, an emoji is one, and counting
  // units would send one too many and eat a character of the real prompt.
  return '\x7f'.repeat([...query].length) + addresses.join(' ') + ' '
}

/** How `pick` changes the draft-tracking input buffer: the query is erased and
 *  the addresses take its place. Kept beside buildMentionPickData because the
 *  two must agree — the menu writes to the PTY through a path that bypasses
 *  term.onData, so nothing else will correct this buffer. */
export function applyMentionPickToInput(
  inputBuffer: string,
  query: string,
  addresses: readonly string[]
): string {
  if (!addresses.length) return inputBuffer
  const trimmed = query.length ? inputBuffer.slice(0, -query.length) : inputBuffer
  return trimmed + addresses.join(' ') + ' '
}
