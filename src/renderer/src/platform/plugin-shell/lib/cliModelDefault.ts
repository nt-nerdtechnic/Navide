/**
 * cliModelDefault.ts
 *
 * The per-vendor model/effort a new pane STARTS on, stored in settings.
 *
 * Separate from cliModel.ts on purpose: that module answers "what does this
 * vendor accept, and what does the flag look like?", which is spec knowledge.
 * This one only remembers what the user picked last time, which is settings
 * knowledge. Keeping them apart is what lets a stored value survive a vendor
 * losing its `modelArgs` — the setting stays put, the spawn just declines to
 * use it, and the pick comes back if the vendor regains the flag.
 *
 * Scope is GLOBAL, matching `agentTeam.cliPermission.<key>`. A model
 * preference follows the person, not the project: the same CLI answering on a
 * different model depending on which folder is open is a surprise nobody
 * asked for.
 *
 * Both fields live under ONE key rather than two. They are picked together and
 * refused together (a vendor that cannot take a model cannot take an effort
 * either), so splitting them invites a half-written pair — an effort stored
 * for a vendor whose model key was cleared.
 *
 * Values are NOT validated here. A model id is checked for shape by
 * modelArgsFor at the moment it reaches a command line, and an effort against
 * the vendor's `knownEfforts` at the same point; re-checking here would mean
 * two places to keep in step, and would silently discard a stored pick the day
 * a vendor renames its levels.
 */

/** A vendor's remembered launch pick. Empty strings mean "vendor default". */
export interface CliModelDefault {
  model: string
  effort: string
}

const NONE: CliModelDefault = { model: '', effort: '' }

/** Settings key holding one vendor's default. Mirrors the existing
 *  `agentTeam.cliPermission.<key>` per-vendor key shape. */
export function cliModelKey(agentKey: string): string {
  return `agentTeam.cliModel.${agentKey}`
}

/** Read a stored value back. Anything that is not an object of two strings —
 *  absent, null, a legacy scalar, a half-written object — reads as "nothing
 *  requested", so an unset vendor spawns exactly as it did before this setting
 *  existed. Whitespace is trimmed here rather than at the call site: a value
 *  that is only spaces is not a pick. */
export function parseCliModelDefault(stored: unknown): CliModelDefault {
  if (!stored || typeof stored !== 'object') return NONE
  const raw = stored as Record<string, unknown>
  return {
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    effort: typeof raw.effort === 'string' ? raw.effort.trim() : '',
  }
}

/** What to persist for a pick, or null to clear the key. Returning null for an
 *  empty pair keeps "use the vendor default" out of the settings file instead
 *  of writing `{model:'',effort:''}`, so an untouched vendor and one reset back
 *  to default are the same stored state. */
export function serializeCliModelDefault(value: CliModelDefault): CliModelDefault | null {
  const next = parseCliModelDefault(value)
  return next.model || next.effort ? next : null
}
