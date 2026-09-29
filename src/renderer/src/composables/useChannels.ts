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

export interface ChannelPlatformState {
  platform: ChannelPlatform
  configured: boolean
  enabled: boolean
  status: ChannelStatus
  /** Non-secret config only; the backend never sends a secret back. */
  config: Record<string, unknown>
  capabilities: ChannelCapabilities | null
}

export interface ChannelPairingRequest {
  platform: ChannelPlatform
  code: string
  sender_id: string
  sender_name: string
  created_at: number
}

export interface ChannelAllowEntry {
  platform: ChannelPlatform
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

export type ChannelVerbosity = 'minimal' | 'standard' | 'full'

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
      platforms.value = (list.data.platforms ?? []).map((p) => ({
        ...p,
        status: { ...emptyStatus(), ...(p.status ?? {}) },
        config: p.config ?? {},
        capabilities: p.capabilities ?? null,
      }))
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
    const msg = raw as { platform?: string; status?: Partial<ChannelStatus> } | null
    if (!msg?.platform) return
    const entry = platforms.value.find((p) => p.platform === msg.platform)
    if (entry) entry.status = { ...emptyStatus(), ...(msg.status ?? {}) }
    else void refresh()
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
    bindingFor: (paneId: string): ChannelBinding | null => bindingByPane.value.get(paneId) ?? null,
    configure: (platform: ChannelPlatform, config: Record<string, unknown>, secret?: Record<string, string>) =>
      mutate('channels.configure', secret ? { platform, config, secret } : { platform, config }),
    setEnabled: (platform: ChannelPlatform, on: boolean) => mutate('channels.set_enabled', { platform, enabled: on }),
    setGlobalEnabled: (on: boolean) => mutate('channels.set_global_enabled', { enabled: on }),
    remove: (platform: ChannelPlatform) => mutate('channels.remove', { platform }),
    approvePairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.approve', { platform, code }),
    rejectPairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.reject', { platform, code }),
    removeAllow: (platform: ChannelPlatform, senderId: string) =>
      mutate('channels.allow.remove', { platform, sender_id: senderId }),
    createLink: (platform: ChannelPlatform, target: 'direct' | 'group') =>
      call<ChannelLinkInvite>('channels.link.create', { platform, target }),
    locations: async (platform: ChannelPlatform): Promise<ChannelResult<{ locations: ChannelLocation[] }>> =>
      call<{ locations: ChannelLocation[] }>('channels.locations', { platform }),
    bind: (req: BindRequest) => mutate('channels.bind', { ...req }),
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
