import { computed, ref, watch, type InjectionKey } from 'vue'
import type { useBackend } from './useBackend'

/**
 * Chat channels (Telegram, Discord, Slack, …) as seen from the renderer. The
 * backend owns every connection; this is a per-window mirror of its state plus
 * thin wrappers around the `channels.*` WS requests. It re-fetches on
 * `channels.changed` and on reconnect, and patches one platform's status in
 * place on `channels.status`.
 */

export type ChannelPlatform =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'feishu'
  | 'dingtalk'
  | 'matrix'
  | 'mattermost'
  | 'imessage'

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
}

export interface ChannelLocation {
  chat_id: string
  title: string
  kind: string
  supports_topics: boolean
}

export interface ChannelField {
  key: string
  /** Stored in the credential vault, never echoed back. */
  secret: boolean
  optional?: boolean
  /** Fixed choices; the first is the default. */
  options?: string[]
}

export interface ChannelPlatformSpec {
  platform: ChannelPlatform
  fields: ChannelField[]
  macOnly?: boolean
}

/** Display order and the credentials each platform needs. Keys match each
 *  backend adapter's `create_adapter(config, secret)`. */
export const CHANNEL_PLATFORMS: readonly ChannelPlatformSpec[] = [
  { platform: 'telegram', fields: [{ key: 'token', secret: true }] },
  { platform: 'discord', fields: [{ key: 'token', secret: true }] },
  { platform: 'slack', fields: [{ key: 'app_token', secret: true }, { key: 'bot_token', secret: true }] },
  {
    platform: 'feishu',
    fields: [
      { key: 'app_id', secret: true },
      { key: 'app_secret', secret: true },
      { key: 'domain', secret: false, optional: true, options: ['feishu', 'lark'] },
    ],
  },
  {
    platform: 'dingtalk',
    fields: [
      { key: 'client_id', secret: true },
      { key: 'client_secret', secret: true },
      { key: 'robot_code', secret: false, optional: true },
    ],
  },
  { platform: 'matrix', fields: [{ key: 'homeserver', secret: false }, { key: 'access_token', secret: true }] },
  { platform: 'mattermost', fields: [{ key: 'server_url', secret: false }, { key: 'token', secret: true }] },
  { platform: 'imessage', fields: [], macOnly: true },
]

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
  backend.on('channels.status', (raw) => {
    const msg = raw as { platform?: string; status?: Partial<ChannelStatus> } | null
    if (!msg?.platform) return
    const entry = platforms.value.find((p) => p.platform === msg.platform)
    if (entry) entry.status = { ...emptyStatus(), ...(msg.status ?? {}) }
    else void refresh()
  })
  watch(
    () => backend.status.value,
    (s) => {
      if (s === 'connected') void refresh()
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
    locations: async (platform: ChannelPlatform): Promise<ChannelResult<{ locations: ChannelLocation[] }>> =>
      call<{ locations: ChannelLocation[] }>('channels.locations', { platform }),
    bind: (req: BindRequest) => mutate('channels.bind', { ...req }),
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
