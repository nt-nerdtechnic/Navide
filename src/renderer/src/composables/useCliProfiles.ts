import { onScopeDispose, ref, type InjectionKey } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { paneCanRebuild } from '@navide/plugin-shell'
import type { useBackend } from './useBackend'

// A CLI account profile: a stored credential slot for one agent CLI so the
// user can keep several accounts per agent (claude/codex/kimi/grok). All
// accounts share the real home directory; switching swaps credentials in
// place. The object fields are camelCase (backend serializes them that way);
// the WS request payloads below are snake_case per the backend contract.
export interface CliProfile {
  id: string
  agentKey: string
  name: string
  createdAt: string
}

// Outcome of `setDefault`. `count` is set for PANES_RUNNING refusals — the
// number of live non-login panes the backend saw for the agent. `needsLogin`
// marks a switch onto an account whose stored credentials cannot authenticate
// — the CLI is now signed out and the caller should start a sign-in.
// `needsLoginReason` says which kind, because they read very differently to
// the user: 'signed-out' (the slot holds nothing) versus 'expired' (a parked
// account's access token aged out, which is routine and not a lost login).
export type CliLoginReason = 'signed-out' | 'expired'

export type SetDefaultResult =
  | { ok: true; needsLogin?: boolean; needsLoginReason?: CliLoginReason }
  | { ok: false; code?: string; message?: string; count?: number }

// Map of agentKey -> default profile id, or null for the built-in Default
// (the user's real home directory).
export type CliProfileDefaults = Record<string, string | null>

// Display-only identity of one account slot, resolved by the backend from the
// CLI's own credential files. `email` is null when the CLI stores no identity
// (kimi) or nobody is signed in.
export interface CliAccountIdentity {
  email: string | null
  signedIn: boolean
}

// agentKey -> slotId -> identity; the built-in Default row is keyed
// "__default__" (mirrors the backend's reserved slot id).
export type CliProfileIdentities = Record<string, Record<string, CliAccountIdentity>>

// One account row whose stored credentials name the same account as another
// row of the same agent. `email` is that account; `slotIds` lists every row
// holding it — this one included, the built-in Default keyed "__default__".
// The backend decides what counts as duplicate (row identities cannot be
// compared here: the active row shows the live account, not its own slot).
export interface CliAccountDuplicate {
  email: string
  slotIds: string[]
}

// agentKey -> slotId -> duplicate group. Rows that are unique are absent.
export type CliProfileDuplicates = Record<string, Record<string, CliAccountDuplicate>>

const DEFAULT_SLOT_ID = '__default__'
// Backend setting keys whose change invalidates the cloud view (mirrors
// sync_scopes.SCOPES_SETTING and server_link.ACCOUNT_EMAIL_SETTING).
const SYNC_SCOPES_SETTING = 'sync-scopes'
const ACCOUNT_EMAIL_SETTING = 'agentTeam.p2p.accountEmail'

// ── Portable credentials ────────────────────────────────────────────────────
// A credential the user pasted (`claude setup-token` and its siblings) rather
// than one a CLI wrote by logging in. The backend keeps the value; the
// renderer only ever sees this metadata (`describe` has no value field by
// construction), and only ever sends the value once, on save.
export interface PortableCredentialMeta {
  agentKey: string
  slotId: string
  configured: boolean
  /** True for the one slot per agent whose credential new panes are handed. */
  enabled: boolean
  /** Where the value lives: pasted here, pulled from the cloud, or nowhere. */
  source?: 'local' | 'imported' | 'none'
  /** Whether the value can actually be served right now (an import sealed
   *  under a key this device lacks is listed but not available). */
  available?: boolean
  kind?: 'oauth' | 'api_key'
  updatedAt?: string | null
  env?: string
  keyStorage?: 'keychain' | 'dpapi' | 'file'
  quotaVerified?: boolean
  obtainCommand?: string
  docsUrl?: string
  /** Files on this machine the CLI ranks above the variable; the paste is
   *  stored but not in effect while any is present. */
  shadowedBy?: string[]
}

// "<agentKey>/<slotId>" -> metadata, exactly as `cli_profiles.list` and the
// `.changed` event carry it (the built-in Default is slot "__default__").
export type CliPortableCredentials = Record<string, PortableCredentialMeta>

// One credential's two halves as the cloud inventory reports them. The item
// is named by its opaque id — a random name the payload travels under, so
// the server's rows say nothing about which CLIs an account uses.
export type CloudCredentialState = 'in-sync' | 'local-only' | 'remote-only' | 'diverged' | 'conflict'

export interface CloudCredential {
  itemId: string
  state: CloudCredentialState
  localPresent: boolean
  remotePresent: boolean
  /** When the cloud copy last changed and from which device; empty for local-only. */
  updatedAt: string
  deviceId: string
  /** False when the cloud copy is sealed under a key this device does not hold. */
  readable: boolean
}

export type CloudCredentialStatus = 'off' | 'ok' | 'no-key' | 'not-connected' | 'error'

// agentKey -> slotId -> credentials. Several per slot is possible (two devices
// that each pasted before syncing); the pane lists them all.
export type CliCloudCredentials = Record<string, Record<string, CloudCredential[]>>

/**
 * Per-window cache of CLI account profiles. Loads from the backend on mount and
 * refreshes whenever any window broadcasts `cli_profiles.changed`. Reconnect-safe.
 * Mirrors the useRoles composable shape (WS CRUD + a `.changed` subscription).
 */
export function useCliProfiles(backend: ReturnType<typeof useBackend>) {
  const profiles = ref<CliProfile[]>([])
  const defaults = ref<CliProfileDefaults>({})
  const identities = ref<CliProfileIdentities>({})
  const duplicates = ref<CliProfileDuplicates>({})
  const supportedAgents = ref<string[]>([])
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')
  const portable = ref<CliPortableCredentials>({})
  const portableSupported = ref<string[]>([])
  const cloud = ref<CliCloudCredentials>({})
  const cloudStatus = ref<CloudCredentialStatus>('off')
  const cloudError = ref<string>('')

  let unsubChanged: (() => void) | null = null
  let unsubSettings: (() => void) | null = null
  let unsubBackend: (() => void) | null = null
  // Generation of the cloud view. Every refresh captures it and writes back
  // only if it is still current; anything that changes what the answer would
  // be — a removal here, an account or section switch — bumps it, so a reply
  // that was in flight cannot land on top of newer state.
  let cloudGeneration = 0

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
        identities?: CliProfileIdentities
        duplicates?: CliProfileDuplicates
        supported_agents: string[]
        portable_credentials?: CliPortableCredentials
        portable_supported?: string[]
      }>('cli_profiles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load CLI profiles'
        return
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      identities.value = resp.payload.identities ?? {}
      duplicates.value = resp.payload.duplicates ?? {}
      supportedAgents.value = resp.payload.supported_agents
      portable.value = resp.payload.portable_credentials ?? {}
      portableSupported.value = resp.payload.portable_supported ?? []
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function create(agentKey: string, name: string): Promise<CliProfile | null> {
    try {
      const resp = await backend.send<{
        profile: CliProfile
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.create', { agent_key: agentKey, name })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'create failed'
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'create failed'
      return null
    }
  }

  async function rename(id: string, name: string): Promise<CliProfile | null> {
    try {
      const resp = await backend.send<{
        profile: CliProfile
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.rename', { id, name })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'rename failed'
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'rename failed'
      return null
    }
  }

  async function remove(id: string | null, agentKey?: string): Promise<boolean> {
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.delete', { id, agent_key: agentKey })
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        error.value =
          code === 'PROFILE_ACTIVE'
            ? i18n.global.t('settings.accounts.cli.active-error')
            : code === 'LOGIN_IN_PROGRESS'
              ? i18n.global.t('settings.accounts.cli.login-in-progress-error')
              : (resp.error?.message ?? 'delete failed')
        return false
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'delete failed'
      return false
    }
  }

  async function setDefault(
    agentKey: string,
    profileId: string | null,
    opts?: { force?: boolean },
  ): Promise<SetDefaultResult> {
    try {
      const payload: Record<string, unknown> = {
        agent_key: agentKey,
        profile_id: profileId,
      }
      if (opts?.force) payload.force = true
      const resp = await backend.send<{
        defaults: CliProfileDefaults
        needsLogin?: boolean
        needsLoginReason?: CliLoginReason | null
      }>('cli_profiles.set_default', payload, 30_000)
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        if (code === 'PANES_RUNNING') {
          // Quiescence refusal: live panes still use the current credentials.
          // Not a banner error — the caller either drives a confirm-and-force
          // flow (main window) or surfaces the message as an alert.
          const count = Number(resp.error?.details?.count ?? 0)
          return {
            ok: false,
            code,
            count,
            message: i18n.global.t('cli-account.panes-running', { count }),
          }
        }
        if (code === 'SWITCH_RATE_LIMITED') {
          // Policy guard rather than a fault: account switching is meant to
          // stay a manual action. Like PANES_RUNNING it sets no banner — there
          // is nothing to fix, and the limit clears on its own.
          const seconds = Math.ceil(Number(resp.error?.details?.retryAfter ?? 0))
          return {
            ok: false,
            code,
            message: i18n.global.t('cli-account.switch-rate-limited', { seconds }),
          }
        }
        const message =
          code === 'PROFILE_SWAP_FAILED'
            ? i18n.global.t('cli-account.swap-failed')
            : (resp.error?.message ?? 'set default failed')
        error.value = message
        return { ok: false, code, message }
      }
      defaults.value = resp.payload.defaults
      return {
        ok: true,
        needsLogin: resp.payload.needsLogin === true,
        // A backend that predates the reason field still says `needsLogin`;
        // fall back to the reading it used to imply.
        needsLoginReason: resp.payload.needsLoginReason ?? undefined,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'set default failed'
      error.value = message
      return { ok: false, message }
    }
  }

  /** Profiles belonging to one agent, in creation order. */
  function profilesForAgent(agentKey: string): CliProfile[] {
    return profiles.value.filter((p) => p.agentKey === agentKey)
  }

  /** True when the agent supports multiple accounts (has at least one profile). */
  function hasProfiles(agentKey: string): boolean {
    return profiles.value.some((p) => p.agentKey === agentKey)
  }

  /** The configured default profile id for an agent, or null (built-in Default). */
  function defaultProfileId(agentKey: string): string | null {
    return defaults.value[agentKey] ?? null
  }

  function findProfile(id: string | null | undefined): CliProfile | undefined {
    if (!id) return undefined
    return profiles.value.find((p) => p.id === id)
  }

  /** Display identity of one account row; `profileId` null = built-in Default. */
  function identityFor(agentKey: string, profileId: string | null): CliAccountIdentity | null {
    return identities.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? null
  }

  /** Duplicate group one account row belongs to, or null when it is unique.
   *  `profileId` null = built-in Default. */
  function duplicateFor(agentKey: string, profileId: string | null): CliAccountDuplicate | null {
    return duplicates.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? null
  }

  // ── Portable credentials (local) ──────────────────────────────────────────
  function portableKey(agentKey: string, profileId: string | null): string {
    return `${agentKey}/${profileId ?? DEFAULT_SLOT_ID}`
  }

  function setPortable(agentKey: string, slotId: string, meta: PortableCredentialMeta): void {
    portable.value = { ...portable.value, [`${agentKey}/${slotId}`]: meta }
  }

  /** Whether an agent has a portable-credential interface at all. */
  function portableSupportedFor(agentKey: string): boolean {
    return portableSupported.value.includes(agentKey)
  }

  function portableFor(agentKey: string, profileId: string | null): PortableCredentialMeta | null {
    return portable.value[portableKey(agentKey, profileId)] ?? null
  }

  /** The vendor's descriptor for a slot that has nothing stored yet — which
   *  variable, which command produces the value, where the docs are. The
   *  list only carries configured slots, so an empty one asks for itself. */
  async function portableDescribe(
    agentKey: string,
    profileId: string | null,
  ): Promise<PortableCredentialMeta | null> {
    const slotId = profileId ?? DEFAULT_SLOT_ID
    const resp = await backend.send<{ portable?: PortableCredentialMeta }>('cli_profiles.portable_get', {
      agent_key: agentKey,
      profile_id: slotId,
    })
    if (!resp.ok || !resp.payload?.portable) return null
    setPortable(agentKey, slotId, resp.payload.portable)
    return resp.payload.portable
  }

  /** Slots of an agent that no local card stands for: credentials pasted
   *  into a named account on another device. Two sources, joined: what the
   *  backend lists as imported here, and what the cloud inventory shows for
   *  a slot id this install has no profile for. The second matters after a
   *  local removal — the import is gone from the listing, but the cloud copy
   *  is still there and the card is the only place it can be taken back. */
  function importedSlotsFor(agentKey: string): PortableCredentialMeta[] {
    const foreign = (slotId: string) =>
      slotId !== DEFAULT_SLOT_ID && !profiles.value.some((p) => p.id === slotId)
    const out = new Map<string, PortableCredentialMeta>()
    for (const m of Object.values(portable.value)) {
      if (m.agentKey === agentKey && m.source === 'imported' && foreign(m.slotId)) out.set(m.slotId, m)
    }
    for (const slotId of Object.keys(cloud.value[agentKey] ?? {})) {
      if (foreign(slotId) && !out.has(slotId)) {
        out.set(slotId, { agentKey, slotId, configured: false, enabled: false, source: 'none' })
      }
    }
    return [...out.values()]
  }

  /** Select (or deselect) the slot whose credential new panes of this agent
   *  are handed. One per agent; independent of the native default account. */
  async function portableEnable(
    agentKey: string,
    slotId: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; message?: string }> {
    const resp = await backend.send<{ portable?: PortableCredentialMeta }>(
      'cli_profiles.portable_enable',
      { agent_key: agentKey, profile_id: slotId, enabled },
    )
    if (!resp.ok) return { ok: false, message: resp.error?.message }
    if (resp.payload?.portable) setPortable(agentKey, slotId, resp.payload.portable)
    return { ok: true }
  }

  /** Store a pasted value. The value goes out once and is never kept here;
   *  what comes back is metadata. A save is also what makes the cloud copy
   *  move, when the credentials section is switched on (the backend
   *  schedules that itself). */
  async function portableSet(
    agentKey: string,
    profileId: string | null,
    secret: string,
  ): Promise<{ ok: true } | { ok: false; code?: string; message?: string }> {
    const slotId = profileId ?? DEFAULT_SLOT_ID
    const resp = await backend.send<{ portable?: PortableCredentialMeta }>(
      'cli_profiles.portable_set',
      { agent_key: agentKey, profile_id: slotId, secret },
    )
    if (!resp.ok) return { ok: false, code: resp.error?.code, message: resp.error?.message }
    if (resp.payload?.portable) setPortable(agentKey, slotId, resp.payload.portable)
    invalidateCloud()
    void refreshCloud()
    return { ok: true }
  }

  /** Remove the pasted value from this device. The cloud copy, if any, stays:
   *  removal never propagates. */
  async function portableClear(agentKey: string, profileId: string | null): Promise<boolean> {
    const slotId = profileId ?? DEFAULT_SLOT_ID
    const resp = await backend.send<{ portable?: PortableCredentialMeta }>(
      'cli_profiles.portable_clear',
      { agent_key: agentKey, profile_id: slotId },
    )
    if (!resp.ok) return false
    if (resp.payload?.portable) setPortable(agentKey, slotId, resp.payload.portable)
    else {
      const next = { ...portable.value }
      delete next[portableKey(agentKey, profileId)]
      portable.value = next
    }
    invalidateCloud()
    void refreshCloud()
    return true
  }

  // ── Portable credentials (cloud) ──────────────────────────────────────────
  function cloudFor(agentKey: string, profileId: string | null): CloudCredential[] {
    return cloud.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? []
  }

  /** Drop the cloud view now and make every refresh already in flight a
   *  no-op. What is on screen was true a moment ago and may no longer be. */
  function invalidateCloud(): void {
    cloudGeneration += 1
    cloud.value = {}
  }

  /** What the account holds for the credentials section, lined up against
   *  this device. Reads only: it never moves anything. */
  async function refreshCloud(): Promise<void> {
    const generation = cloudGeneration
    const current = () => generation === cloudGeneration
    cloudError.value = ''
    try {
      const status = await backend.send<{ scopes?: Record<string, boolean>; link?: { state?: string } }>(
        'sync.status',
        {},
      )
      if (!current()) return
      if (!status.ok || !status.payload?.scopes?.credentials) {
        cloudStatus.value = 'off'
        cloud.value = {}
        return
      }
      const resp = await backend.send<{
        scopes?: Record<string, { status: string; items?: unknown[]; error?: string }>
      }>('sync.inventory', { scope: 'credentials' }, 30_000)
      if (!current()) return
      const section = resp.ok ? resp.payload?.scopes?.credentials : undefined
      if (!section) {
        cloudStatus.value = 'error'
        cloudError.value = resp.error?.message ?? 'failed to read the cloud inventory'
        cloud.value = {}
        return
      }
      cloudStatus.value = toCloudStatus(section.status)
      cloudError.value = section.error ?? ''
      cloud.value = groupCloudItems(section.items ?? [])
    } catch (err) {
      if (!current()) return
      cloudStatus.value = 'error'
      cloudError.value = String((err as Error).message ?? err)
    }
  }

  /** Take one cloud credential into use on this device — the one explicit
   *  action that (re)enables a credential here. */
  async function useFromCloud(itemId: string): Promise<{ ok: true } | { ok: false; message?: string }> {
    const resp = await backend.send<{ results?: Array<{ itemId: string; result: string }> }>(
      'sync.pull_items',
      { scope: 'credentials', itemIds: [itemId] },
      30_000,
    )
    if (!resp.ok) return { ok: false, message: resp.error?.message }
    const result = resp.payload?.results?.find((r) => r.itemId === itemId)?.result
    invalidateCloud()
    await refreshCloud()
    return result === 'pulled' ? { ok: true } : { ok: false, message: result }
  }

  // Keep every window's cache in sync: any mutation broadcasts `cli_profiles.changed`.
  unsubChanged = backend.on('cli_profiles.changed', (raw) => {
    const payload = raw as {
      profiles?: CliProfile[]
      defaults?: CliProfileDefaults
      identities?: CliProfileIdentities
      duplicates?: CliProfileDuplicates
      portable_credentials?: CliPortableCredentials
    }
    if (payload?.profiles) profiles.value = payload.profiles
    if (payload?.defaults) defaults.value = payload.defaults
    if (payload?.identities) identities.value = payload.identities
    if (payload?.portable_credentials !== undefined) {
      portable.value = payload.portable_credentials
      invalidateCloud()
      void refreshCloud()
    }
    // Assigned unconditionally: the last duplicate clearing (a row deleted)
    // broadcasts an empty map, and skipping falsy payloads would keep the
    // stale warning on screen.
    if (payload?.duplicates !== undefined) duplicates.value = payload.duplicates
  })

  // The cloud view depends on two settings besides the rows themselves: which
  // sections sync, and which account this install is signed in to. Either
  // changing makes the view stale at once — an old inventory must not outlive
  // the account it belonged to.
  unsubSettings = backend.on('ui.settings_changed', (raw) => {
    const settings = (raw as { settings?: Record<string, unknown> } | null)?.settings
    if (!settings) return
    if (SYNC_SCOPES_SETTING in settings || ACCOUNT_EMAIL_SETTING in settings) {
      invalidateCloud()
      cloudStatus.value = 'off'
      void refreshCloud()
    }
  })

  // Initial load once connected; re-fetch on reconnect (mirrors useRoles).
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubSettings?.()
    unsubBackend?.()
  })

  return {
    profiles,
    defaults,
    identities,
    duplicates,
    supportedAgents,
    loaded,
    loading,
    error,
    refresh,
    create,
    rename,
    remove,
    setDefault,
    profilesForAgent,
    hasProfiles,
    defaultProfileId,
    findProfile,
    identityFor,
    duplicateFor,
    portable,
    portableSupported,
    portableSupportedFor,
    portableFor,
    portableDescribe,
    portableSet,
    portableClear,
    portableEnable,
    importedSlotsFor,
    cloud,
    cloudStatus,
    cloudError,
    cloudFor,
    refreshCloud,
    invalidateCloud,
    useFromCloud,
  }
}

function toCloudStatus(status: string): CloudCredentialStatus {
  return status === 'ok' || status === 'no-key' || status === 'not-connected' ? status : 'error'
}

/** Inventory rows into agentKey -> slotId -> credentials. A row is placed by
 *  the metadata the backend attached to whichever half it could read; a row
 *  it could read neither half of has no home and is left out. */
function groupCloudItems(items: unknown[]): CliCloudCredentials {
  const out: CliCloudCredentials = {}
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as {
      itemId?: unknown
      state?: unknown
      local?: { present?: boolean; meta?: { agentKey?: unknown; slotId?: unknown } } | null
      remote?: {
        present?: boolean
        updatedAt?: unknown
        deviceId?: unknown
        readable?: unknown
        meta?: { agentKey?: unknown; slotId?: unknown }
      } | null
    }
    const meta = item.local?.meta ?? item.remote?.meta
    if (typeof item.itemId !== 'string' || typeof meta?.agentKey !== 'string' || typeof meta?.slotId !== 'string') {
      continue
    }
    const state = String(item.state ?? '')
    if (!['in-sync', 'local-only', 'remote-only', 'diverged', 'conflict'].includes(state)) continue
    const entry: CloudCredential = {
      itemId: item.itemId,
      state: state as CloudCredentialState,
      localPresent: Boolean(item.local?.present),
      remotePresent: Boolean(item.remote?.present),
      updatedAt: typeof item.remote?.updatedAt === 'string' ? item.remote.updatedAt : '',
      deviceId: typeof item.remote?.deviceId === 'string' ? item.remote.deviceId : '',
      readable: item.remote ? item.remote.readable !== false : true,
    }
    const slots = (out[meta.agentKey] ??= {})
    ;(slots[meta.slotId] ??= []).push(entry)
  }
  return out
}

// ── Quiescence-aware account switch ─────────────────────────────────────────

/** Switches an agent's default account like `setDefault`, but resolves the
 *  PANES_RUNNING refusal (confirm with the user, force the switch, restart
 *  the agent's live panes). Provided by the main window, which owns the pane
 *  roster; windows without it fall back to plain `setDefault`. */
export type CliAccountSwitchHandler = (
  agentKey: string,
  profileId: string | null,
) => Promise<SetDefaultResult>

export const cliAccountSwitchKey: InjectionKey<CliAccountSwitchHandler> =
  Symbol('cli-account-switch')

/** App-shell capabilities the switch flow needs but a component cannot own. */
export interface CliAccountSwitchCaps {
  /** Modal confirm — resolves true when the user accepts the restart. */
  confirm: (
    message: string,
    opts: { title: string; confirmText: string; cancelText: string },
  ) => Promise<boolean>
  /** Display label for the agent in the confirm copy. */
  agentLabel: (agentKey: string) => string
  /** Start a live sign-in for the agent — used when the switch landed on an
   *  account whose stored credentials cannot authenticate. The account is
   *  already active by then, so this is a LIVE login (not an isolated one).
   *  `reason` is what the pane's own explanation should say. */
  startLogin: (agentKey: string, reason?: CliLoginReason) => void
}

/**
 * Build the main window's account-switch handler: try the plain switch; when
 * the backend refuses with PANES_RUNNING, ask the user, then force the switch.
 * The pane restart is NOT driven here: the backend broadcasts the forced
 * switch via `cli_profiles.changed` and every main window (this one included)
 * restarts its own panes from that event — see `forcedRestartAgentKey`.
 * A declined confirm returns a message-less failure so callers stay silent.
 */
export function createCliAccountSwitchHandler(
  api: Pick<ReturnType<typeof useCliProfiles>, 'setDefault'>,
  caps: CliAccountSwitchCaps,
): CliAccountSwitchHandler {
  // The switched-to account has no usable credentials: the CLI is signed out
  // right now, so start the sign-in for the user instead of leaving them at a
  // login prompt to resolve by hand.
  function afterSwitch(agentKey: string, res: SetDefaultResult): SetDefaultResult {
    if (res.ok && res.needsLogin) caps.startLogin(agentKey, res.needsLoginReason)
    return res
  }

  return async (agentKey, profileId) => {
    const first = await api.setDefault(agentKey, profileId)
    if (first.ok || first.code !== 'PANES_RUNNING') return afterSwitch(agentKey, first)
    const t = i18n.global.t
    const confirmed = await caps.confirm(
      t('cli-account.switch-restart-confirm-body', {
        count: first.count ?? 0,
        agent: caps.agentLabel(agentKey),
      }),
      {
        title: t('cli-account.switch-restart-confirm-title'),
        confirmText: t('cli-account.switch-restart-confirm-confirm'),
        cancelText: t('cli-account.switch-restart-confirm-cancel'),
      },
    )
    if (!confirmed) return { ok: false, code: 'PANES_RUNNING' }
    return afterSwitch(agentKey, await api.setDefault(agentKey, profileId, { force: true }))
  }
}

// ── Broadcast-driven pane restart (forced account switch) ───────────────────

/** Subset of the `cli_profiles.changed` payload relevant to forced switches. */
export interface CliProfilesChangedEvent {
  reason?: string
  agent_key?: string
  forced?: boolean
}

/**
 * The agent whose panes must restart after this `cli_profiles.changed`
 * broadcast, or null. Only a forced set_default (credentials swapped under
 * live panes) triggers a restart; a quiet switch never touches panes.
 */
export function forcedRestartAgentKey(
  ev: CliProfilesChangedEvent | null | undefined,
): string | null {
  if (!ev || ev.reason !== 'set_default') return null
  if (!ev.forced || !ev.agent_key) return null
  return ev.agent_key
}

/**
 * True when a pane belongs in the post-switch restart batch: a realized,
 * non-login pane of the switched agent whose terminal has not died AND which
 * can actually be rebuilt. `status` is the pane's display/terminal status
 * ('exited'/'error' = dead); undefined (terminal ref not mounted yet) keeps
 * the pane in the batch — it may be starting on the old credentials, and
 * skipping it would leave the stale account live.
 *
 * The rebuild is a resume, so it needs the same preconditions as the manual
 * Rebuild button (paneCanRebuild): a pinned session id, its transcript on
 * disk, and an agent with a resume command. A pane missing any of them — a
 * freshly opened one that has no session yet, typically — cannot be resumed
 * however hard the batch tries, and counting its guaranteed failure in the
 * partial-restart toast reports a problem that is not one. It stays on the
 * outgoing account until the user restarts it by hand.
 */
export function paneNeedsAccountRestart(
  pane: {
    realized?: boolean
    agentKey?: string
    isLogin?: boolean
    pinnedSessionId?: string
    sessionOnDisk?: boolean
  },
  agentKey: string,
  status: string | undefined,
): boolean {
  if (!pane.realized || pane.agentKey !== agentKey || pane.isLogin) return false
  if (status === 'exited' || status === 'error') return false
  return paneCanRebuild({ ...pane, agentKey })
}

/**
 * Run the post-switch restart batch and aggregate failures: `rebuild` resolves
 * undefined on success and a failure token otherwise (and may throw). Each
 * failure is logged; one summary toast is emitted when any pane could not be
 * restarted, none when all succeeded.
 */
export async function runAccountRestartBatch(
  ids: string[],
  rebuild: (id: string) => Promise<string | undefined>,
  log: (line: string) => void,
  toastPartial: (failed: number, total: number) => void,
): Promise<void> {
  const failures: Array<{ id: string; reason: string }> = []
  for (const id of ids) {
    try {
      const outcome = await rebuild(id)
      if (outcome !== undefined) failures.push({ id, reason: outcome })
    } catch (error) {
      failures.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const f of failures) {
    log(`⚠ account-switch rebuild pane ${f.id.slice(0, 8)} failed: ${f.reason}`)
  }
  if (failures.length > 0) toastPartial(failures.length, ids.length)
}
