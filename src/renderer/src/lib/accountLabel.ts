// Account dimension helpers shared by Turn Stats, the Token panel and the
// quota-cycle views. The backend stores only the pane's pinned profile id;
// the display name is resolved here from the same profiles source the usage
// badge's "Switch account" list reads (useCliProfiles), so an account reads
// the same everywhere.

/** The backend's reserved slot id for the built-in Default (the real home). */
export const DEFAULT_PROFILE_ID = '__default__'
/** Records that cannot be traced back to an account (panes from before the
 *  pin history existed, sessions run outside Navide). Never merged into any
 *  real account. */
export const UNKNOWN_PROFILE_ID = 'unknown'

/** The subset of useCliProfiles the label needs; typed narrowly so a test can
 *  hand in a plain object. */
export interface AccountLabelSource {
  identityFor(agentKey: string, profileId: string | null): { email: string | null } | null
  findProfile(id: string | null | undefined): { name: string } | undefined
  /** The user's own name for this account, when they gave it one. Optional so
   *  a caller holding an older/narrower source still type-checks. */
  aliasFor?(agentKey: string, profileId: string | null): string | undefined
}

/** Translator shape: vue-i18n's `t` for a bare key. */
export type AccountLabelT = (key: string) => string

/** The contract's normalisation: `""`, null and undefined are the pre-pin
 *  era and read as unknown. */
export function normalizeProfileId(id: string | null | undefined): string {
  return id ? id : UNKNOWN_PROFILE_ID
}

/** Stable key for one (agent, account) pair — the shape the backend keys
 *  quota cycles and account periods by. */
export function accountKey(agentKey: string, profileId: string | null | undefined): string {
  return `${agentKey}/${normalizeProfileId(profileId)}`
}

/**
 * Display name of one account, in the same order the badge resolves rows:
 * the user's alias → signed-in email → the profile's given name → "Default"
 * for the built-in slot → "Unknown" for untraceable records → a shortened id
 * marked as removed when the profile no longer exists (its id survives in old
 * records). The alias leads because it is the only part the user wrote; for
 * the half of the vendors that expose no email it is the only thing that
 * tells two accounts apart.
 *
 * `defaultLabel` replaces the generic "Default" where the surface already has
 * a wordier name for the built-in slot (the badge popover's "Default
 * (built-in)").
 */
export function accountLabel(
  source: AccountLabelSource | null | undefined,
  agentKey: string,
  profileId: string | null | undefined,
  t: AccountLabelT,
  opts: { defaultLabel?: string } = {}
): string {
  const id = normalizeProfileId(profileId)
  if (id === UNKNOWN_PROFILE_ID) return t('account-dim.unknown')
  const slot = id === DEFAULT_PROFILE_ID ? null : id
  const alias = source?.aliasFor?.(agentKey, slot)
  if (alias) return alias
  const email = source?.identityFor(agentKey, slot)?.email
  if (email) return email
  const name = source?.findProfile(slot)?.name
  if (name) return name
  if (id === DEFAULT_PROFILE_ID) return opts.defaultLabel ?? t('account-dim.default')
  return `${id.slice(0, 8)} · ${t('account-dim.removed')}`
}

/**
 * The same account, shortened for a pane header chip: alias → the email's
 * local part → the profile's (generated) name → "Default". A full email is
 * over 110px at the header's 9px type, which the title bar has no room for;
 * the whole address stays in the tooltip and the popover.
 */
export function accountChipLabel(
  source: AccountLabelSource | null | undefined,
  agentKey: string,
  profileId: string | null | undefined,
  t: AccountLabelT,
  opts: { defaultLabel?: string } = {}
): string {
  const id = normalizeProfileId(profileId)
  if (id === UNKNOWN_PROFILE_ID) return t('account-dim.unknown')
  const slot = id === DEFAULT_PROFILE_ID ? null : id
  const alias = source?.aliasFor?.(agentKey, slot)
  if (alias) return alias
  const email = source?.identityFor(agentKey, slot)?.email
  if (email) return emailLocalPart(email)
  const name = source?.findProfile(slot)?.name
  if (name) return name
  if (id === DEFAULT_PROFILE_ID) return opts.defaultLabel ?? t('account-dim.default')
  return `${id.slice(0, 8)} · ${t('account-dim.removed')}`
}

/** The part before "@", or the whole string when there is none. */
export function emailLocalPart(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** True when the id names a profile that no longer exists (and is not one of
 *  the two reserved ids). Used to blank the quota column: a removed account
 *  has no slot to read. */
export function accountRemoved(source: AccountLabelSource | null | undefined, profileId: string | null | undefined): boolean {
  const id = normalizeProfileId(profileId)
  if (id === UNKNOWN_PROFILE_ID || id === DEFAULT_PROFILE_ID) return false
  return !source?.findProfile(id)
}

// Chart series colour per account: a deterministic pick from the theme's
// palette (the usage badge tints avatars the same way), so the same account
// keeps its colour across the monthly, yearly and cycle charts. Reserved ids
// take fixed, muted colours so "unknown" never looks like a real account.
const ACCOUNT_TINTS = [
  'var(--accent-fg)',
  'var(--success-fg)',
  'var(--attention-fg)',
  'var(--ansi-magenta)',
  'var(--ansi-cyan)',
  'var(--ansi-yellow)',
  'var(--ansi-blue)'
]
export function accountTint(profileId: string | null | undefined): string {
  const id = normalizeProfileId(profileId)
  if (id === UNKNOWN_PROFILE_ID) return 'var(--text-disabled)'
  if (id === DEFAULT_PROFILE_ID) return 'var(--text-muted)'
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return ACCOUNT_TINTS[h % ACCOUNT_TINTS.length]
}
