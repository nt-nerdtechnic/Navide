import { computed, ref, watch, type InjectionKey } from 'vue'
import type { useBackend } from './useBackend'
import type { ChannelPlatform } from '../platform/channels'

/**
 * Chat channels (Telegram, Discord, Slack, …) as seen from the renderer. The
 * backend owns every connection; this is a per-window mirror of its state plus
 * thin wrappers around the `channels.*` WS requests. It re-fetches on
 * `channels.changed` and on reconnect, and patches one platform's status in
 * place on `channels.status`.
 */

// The platform union is derived from the registry (platform/channels/index.ts).
export type { ChannelPlatform }

export type ChannelLifecycle = 'stopped' | 'starting' | 'ready' | 'recovering' | 'blocked'

export interface ChannelStatus {
  lifecycle: ChannelLifecycle
  connected: boolean
  reconnect_attempts: number
  last_error: string
  last_connected_at: number | null
  last_inbound_at: number | null
  identity: string
}

export interface ChannelCapabilities {
  threads: boolean
  create_location: boolean
  edit: boolean
  typing: boolean
  buttons: boolean
  text_limit: number
}

/** One bot on a platform. A platform may run several; `default` is the one every
 *  platform had before that, and added bots get a generated id (see newAccountId). */
export interface ChannelAccountState {
  account: string
  /** Display name the user gave the bot; '' when unnamed. */
  name: string
  configured: boolean
  enabled: boolean
  status: ChannelStatus
  /** Non-secret config only; the backend never sends a secret back. */
  config: Record<string, unknown>
  capabilities: ChannelCapabilities | null
}

export interface ChannelPlatformState {
  platform: ChannelPlatform
  /** True when any bot is configured. */
  configured: boolean
  /** True when any bot is enabled. */
  enabled: boolean
  /** The first bot's status, config and capabilities, as before several bots. */
  status: ChannelStatus
  /** Non-secret config only; the backend never sends a secret back. */
  config: Record<string, unknown>
  capabilities: ChannelCapabilities | null
  /** Every configured bot, `default` first. */
  accounts: ChannelAccountState[]
}

export const DEFAULT_ACCOUNT = 'default'

// The backend's worst case, each step bounded on its side: storing the credential
// (a Keychain write, up to 10 s), waiting for the platform to accept it (10 s,
// QUICK_ADD_TIMEOUT_S), then undoing a failure (a Keychain delete, up to 10 s) —
// 30 s, plus 15 s for the channels lock and the round trips.
const QUICK_ADD_TIMEOUT_MS = 45_000

/** A fresh id for a bot being added: stable for its life, whatever it is renamed to. */
export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return `bot-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** `account` for a request payload: left out for the default bot, so requests for
 *  it stay exactly what they were before several bots per platform. */
function acct(account: string | undefined): { account?: string } {
  return account && account !== DEFAULT_ACCOUNT ? { account } : {}
}

export interface ChannelPairingRequest {
  platform: ChannelPlatform
  /** The bot the sender wrote to; absent from older backends (= default). */
  account?: string
  code: string
  sender_id: string
  sender_name: string
  created_at: number
}

export interface ChannelAllowEntry {
  platform: ChannelPlatform
  /** The bot this sender may talk to; absent from older backends (= default). */
  account?: string
  sender_id: string
  sender_name: string
  added_at: number
}

export interface ChannelBinding {
  pane_id: string
  platform: ChannelPlatform
  account: string
  chat_id: string
  thread_id: string
  title: string
  /** How much of the pane's activity the chat mirrors; absent on older backends (= full). */
  verbosity?: ChannelVerbosity
  /** Set on an auto-created child topic: the pane it reports into. */
  parent_pane_id?: string
  /** True for a topic the backend created itself (a child pane's), false for a manual binding. */
  auto?: boolean
}

export type ChannelVerbosity = 'replies' | 'minimal' | 'standard' | 'full'

export interface ChannelLocation {
  chat_id: string
  title: string
  kind: string
  supports_topics: boolean
}

/** A one-time code from `channels.link.create`: whoever sends it to the bot is linked. */
export interface ChannelLinkInvite {
  code: string
  target: 'direct' | 'group'
  expires_at: number
  /** Platform deep link that sends the code (Telegram) or opens the bot (Discord install, Slack DM). */
  url: string | null
}

/** `channels.quick_add`: the new bot, verified, named and (when asked) with a live invite. */
export interface ChannelQuickAddResult {
  account: string
  /** The stored display name: the one given, else the identity the platform reported. */
  name: string
  identity: string
  link: ChannelLinkInvite | null
}

/** `channels.linked`: a chat was linked by an invite code. */
export interface ChannelLinkedEvent {
  platform: ChannelPlatform
  /** The invite it redeemed, so only the guide that issued it reacts. */
  code: string
  chat_id: string
  title: string
  kind: 'direct' | 'group'
  /** False when the bot could not post its confirmation in the chat. */
  confirmed: boolean
}

/** `channels.link_failed`: a sent invite code was spent but the link did not complete. */
export interface ChannelLinkFailedEvent {
  platform: ChannelPlatform
  code: string
  error: string
}

export interface ChannelResult<T = Record<string, unknown>> {
  ok: boolean
  error?: string
  data?: T
}

export interface BindRequest {
  pane_id: string
  pane_name: string
  platform: ChannelPlatform
  mode: 'new' | 'existing'
  chat_id: string
  thread_id?: string
  title?: string
  /** Mirror level the user chose; the backend uses replies when it is missing. */
  verbosity?: ChannelVerbosity
  /** The bot the chat is reached through; the default bot when missing. */
  account?: string
}

type Backend = Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>

function emptyStatus(): ChannelStatus {
  return {
    lifecycle: 'stopped',
    connected: false,
    reconnect_attempts: 0,
    last_error: '',
    last_connected_at: null,
    last_inbound_at: null,
    identity: '',
  }
}

function createChannelsStore(backend: Backend) {
  const enabled = ref(true)
  const platforms = ref<ChannelPlatformState[]>([])
  const bindings = ref<ChannelBinding[]>([])
  const pairing = ref<ChannelPairingRequest[]>([])
  const allow = ref<ChannelAllowEntry[]>([])
  const loaded = ref(false)
  const error = ref('')
  const lastLinked = ref<ChannelLinkedEvent | null>(null)
  const lastLinkFailed = ref<ChannelLinkFailedEvent | null>(null)
  // Bumped whenever the backend connection drops: invites live only in the
  // backend's memory, so a code handed out before may be gone.
  const linkEpoch = ref(0)

  async function call<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<ChannelResult<T>> {
    try {
      const resp = await backend.send<T & { ok?: boolean; error?: string }>(type, payload)
      const body = resp.payload
      if (!resp.ok || !body) return { ok: false, error: resp.error?.message ?? `${type} failed` }
      if (body.ok === false) return { ok: false, error: body.error ?? `${type} failed` }
      return { ok: true, data: body }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function refresh(): Promise<void> {
    const [list, binds, reqs, allowed] = await Promise.all([
      call<{ enabled: boolean; platforms: ChannelPlatformState[] }>('channels.list'),
      call<{ bindings: ChannelBinding[] }>('channels.bindings'),
      call<{ requests: ChannelPairingRequest[] }>('channels.pairing.list'),
      call<{ entries: ChannelAllowEntry[] }>('channels.allow.list'),
    ])
    if (list.ok && list.data) {
      enabled.value = list.data.enabled !== false
      platforms.value = (list.data.platforms ?? []).map((p) => {
        const status = { ...emptyStatus(), ...(p.status ?? {}) }
        const config = p.config ?? {}
        const capabilities = p.capabilities ?? null
        // An older backend lists no bots: its one configured bot is the default.
        const accounts = p.accounts ?? (p.configured
          ? [{ account: DEFAULT_ACCOUNT, name: '', configured: true, enabled: p.enabled, status, config, capabilities }]
          : [])
        return {
          ...p,
          status,
          config,
          capabilities,
          accounts: accounts.map((a) => ({
            ...a,
            name: a.name ?? '',
            status: { ...emptyStatus(), ...(a.status ?? {}) },
            config: a.config ?? {},
            capabilities: a.capabilities ?? null,
          })),
        }
      })
    }
    if (binds.ok && binds.data) bindings.value = binds.data.bindings ?? []
    if (reqs.ok && reqs.data) pairing.value = reqs.data.requests ?? []
    if (allowed.ok && allowed.data) allow.value = allowed.data.entries ?? []
    error.value = [list, binds, reqs, allowed].find((r) => !r.ok)?.error ?? ''
    loaded.value = true
  }

  /** Run a mutation; the backend broadcasts `channels.changed`, but refresh
   *  here too so this window does not depend on the broadcast round-trip. */
  async function mutate(type: string, payload: Record<string, unknown>): Promise<ChannelResult> {
    const res = await call(type, payload)
    if (res.ok) await refresh()
    return res
  }

  backend.on('channels.changed', () => {
    void refresh()
  })
  backend.on('channels.pairing_request', () => {
    void refresh()
  })
  backend.on('channels.linked', (raw) => {
    const msg = raw as ChannelLinkedEvent | null
    if (msg?.platform) lastLinked.value = msg
  })
  backend.on('channels.link_failed', (raw) => {
    const msg = raw as ChannelLinkFailedEvent | null
    if (msg?.platform) lastLinkFailed.value = msg
  })
  backend.on('channels.status', (raw) => {
    const msg = raw as { platform?: string; account?: string; status?: Partial<ChannelStatus> } | null
    if (!msg?.platform) return
    const entry = platforms.value.find((p) => p.platform === msg.platform)
    if (!entry) {
      void refresh()
      return
    }
    const status = { ...emptyStatus(), ...(msg.status ?? {}) }
    const account = msg.account ?? DEFAULT_ACCOUNT
    const bot = entry.accounts.find((a) => a.account === account)
    if (bot) bot.status = status
    // The platform shows its first bot (or the default slot while none is set up).
    if ((entry.accounts[0]?.account ?? DEFAULT_ACCOUNT) === account) entry.status = status
  })
  watch(
    () => backend.status.value,
    (s, prev) => {
      if (s === 'connected') void refresh()
      else if (prev === 'connected') linkEpoch.value += 1
    },
    { immediate: true }
  )

  const configuredPlatforms = computed(() => platforms.value.filter((p) => p.configured))
  const bindingByPane = computed(() => new Map(bindings.value.map((b) => [b.pane_id, b])))

  return {
    enabled,
    platforms,
    bindings,
    pairing,
    allow,
    loaded,
    error,
    lastLinked,
    lastLinkFailed,
    linkEpoch,
    configuredPlatforms,
    refresh,
    platformState: (platform: ChannelPlatform) => platforms.value.find((p) => p.platform === platform) ?? null,
    accountState: (platform: ChannelPlatform, account: string = DEFAULT_ACCOUNT): ChannelAccountState | null =>
      platforms.value.find((p) => p.platform === platform)?.accounts.find((a) => a.account === account) ?? null,
    bindingFor: (paneId: string): ChannelBinding | null => bindingByPane.value.get(paneId) ?? null,
    configure: (platform: ChannelPlatform, config: Record<string, unknown>, secret?: Record<string, string>,
      account?: string) =>
      mutate('channels.configure', secret ? { platform, ...acct(account), config, secret } : { platform, ...acct(account), config }),
    /** Add a new bot in one step: the backend stores it only once the platform accepted
     *  the credential, and with `linkTarget` answers with a link invite too. A failure
     *  carries `reason` ("rejected" | "timeout" | "invalid") and leaves nothing stored. */
    quickAdd: async (platform: ChannelPlatform, config: Record<string, unknown>, secret: Record<string, string>,
      account: string, linkTarget?: 'direct' | 'group'): Promise<ChannelResult<ChannelQuickAddResult> & { reason?: string }> => {
      const type = 'channels.quick_add'
      try {
        const resp = await backend.send<ChannelQuickAddResult & { ok?: boolean; error?: string; reason?: string }>(type, {
          platform, ...acct(account), config, secret, ...(linkTarget ? { link_target: linkTarget } : {}),
        }, QUICK_ADD_TIMEOUT_MS)
        const body = resp.payload
        if (!resp.ok || !body) return { ok: false, error: resp.error?.message ?? `${type} failed` }
        if (body.ok === false) return { ok: false, error: body.error ?? `${type} failed`, reason: body.reason }
        await refresh()
        return { ok: true, data: body }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    setEnabled: (platform: ChannelPlatform, on: boolean, account?: string) =>
      mutate('channels.set_enabled', { platform, ...acct(account), enabled: on }),
    renameAccount: (platform: ChannelPlatform, account: string, name: string) =>
      mutate('channels.rename_account', { platform, account, name }),
    setGlobalEnabled: (on: boolean) => mutate('channels.set_global_enabled', { enabled: on }),
    /** One bot when `account` is given (always sent, even "default"); without it
     *  the whole platform: every bot, its allowlist and pairing requests. */
    remove: (platform: ChannelPlatform, account?: string) =>
      mutate('channels.remove', account ? { platform, account } : { platform }),
    approvePairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.approve', { platform, code }),
    rejectPairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.reject', { platform, code }),
    removeAllow: (platform: ChannelPlatform, senderId: string, account?: string) =>
      mutate('channels.allow.remove', { platform, sender_id: senderId, ...acct(account) }),
    createLink: (platform: ChannelPlatform, target: 'direct' | 'group', account?: string) =>
      call<ChannelLinkInvite>('channels.link.create', { platform, target, ...acct(account) }),
    locations: async (platform: ChannelPlatform, account?: string): Promise<ChannelResult<{ locations: ChannelLocation[] }>> =>
      call<{ locations: ChannelLocation[] }>('channels.locations', { platform, ...acct(account) }),
    bind: ({ account, ...req }: BindRequest) => mutate('channels.bind', { ...req, ...acct(account) }),
    /** Child topics the backend auto-bound under a parent pane's binding. */
    childrenOf: (paneId: string): ChannelBinding[] => bindings.value.filter((b) => b.parent_pane_id === paneId),
    setBindingOptions: (paneId: string, verbosity: ChannelVerbosity) =>
      mutate('channels.set_binding_options', { pane_id: paneId, verbosity }),
    unbind: (paneId: string, paneName = '') => mutate('channels.unbind', { pane_id: paneId, pane_name: paneName }),
    rebind: (fromPaneId: string, toPaneId: string) =>
      mutate('channels.rebind', { from_pane_id: fromPaneId, to_pane_id: toPaneId }),
    /** A pane really closed. The backend no longer unbinds on unregister (a
     *  workspace switch or detach unregisters too), so this is the only path
     *  that releases the binding. Skipped for panes known to be unbound. */
    paneClosed(paneId: string): void {
      if (loaded.value && !bindingByPane.value.has(paneId)) return
      void call('channels.unbind', { pane_id: paneId, reason: 'closed' })
    },
    /** A rebuild replaced a pane under a new id: carry its binding over. */
    paneReplaced(fromPaneId: string, toPaneId: string): void {
      if (loaded.value && !bindingByPane.value.has(fromPaneId)) return
      void call('channels.rebind', { from_pane_id: fromPaneId, to_pane_id: toPaneId })
    },
  }
}

export type ChannelsStore = ReturnType<typeof createChannelsStore>

// One store per backend connection: the Settings pane, every pane header and
// every sidebar row share it, so N panes do not mean N fetches per change.
const stores = new WeakMap<object, ChannelsStore>()

export function useChannels(backend: Backend): ChannelsStore {
  let store = stores.get(backend)
  if (!store) {
    store = createChannelsStore(backend)
    stores.set(backend, store)
  }
  return store
}

export const channelsKey: InjectionKey<ChannelsStore> = Symbol('channels')
