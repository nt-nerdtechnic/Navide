import { onScopeDispose, ref, shallowRef } from 'vue'

export type BackendStatus = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

interface BackendInfo {
  status: 'starting' | 'ready'
  host?: string
  port?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
}

export interface WsRequest<TPayload = Record<string, unknown>> {
  id: string
  type: string
  payload: TPayload
  timestamp: string
}

export interface WsResponse<TPayload = unknown> {
  id: string
  type: string
  ok: boolean
  payload: TPayload | null
  error: { code: string; message: string; details?: Record<string, unknown> } | null
  timestamp: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function uuid(): string {
  return crypto.randomUUID()
}

export function useBackend() {
  const status = ref<BackendStatus>('starting')
  const wsUrl = ref<string>('')
  const httpUrl = ref<string>('')
  const shell = ref<string>('')
  const lastError = ref<string>('')
  const ws = shallowRef<WebSocket | null>(null)
  interface PendingEntry { resolve: (resp: WsResponse) => void; reject: (err: Error) => void }
  const pending = new Map<string, PendingEntry>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  let pingTimer: number | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempts = 0
  let disposed = false

  function emit(type: string, payload: unknown): void {
    const set = listeners.get(type)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[useBackend] listener error', err)
      }
    }
  }

  function on(type: string, cb: (payload: unknown) => void): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  }

  function send<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<WsResponse<T>> {
    return new Promise((resolve, reject) => {
      const socket = ws.value
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ws not open'))
        return
      }
      const req: WsRequest = { id: uuid(), type, payload, timestamp: nowIso() }
      let timerId: ReturnType<typeof setTimeout>
      pending.set(req.id, {
        resolve: (resp: WsResponse) => { clearTimeout(timerId); resolve(resp as WsResponse<T>) },
        reject: (err: Error) => { clearTimeout(timerId); reject(err) },
      })
      socket.send(JSON.stringify(req))
      timerId = setTimeout(() => {
        const entry = pending.get(req.id)
        if (entry) {
          pending.delete(req.id)
          entry.reject(new Error(`request ${type} timeout`))
        }
      }, timeoutMs)
    })
  }

  function connect(): void {
    if (!wsUrl.value || disposed) return
    status.value = 'connecting'
    const socket = new WebSocket(wsUrl.value)
    ws.value = socket

    socket.addEventListener('open', () => {
      status.value = 'connected'
      lastError.value = ''
      reconnectAttempts = 0
      if (pingTimer !== null) window.clearInterval(pingTimer)
      // A wedged backend connection can stay TCP-open for minutes while every
      // frame fails. Pings are the liveness probe: two consecutive failures
      // force a close so the reconnect path takes over immediately instead of
      // waiting for the server to abort the socket.
      let pingFailures = 0
      pingTimer = window.setInterval(() => {
        send('ping', { t: Date.now() })
          .then(() => {
            pingFailures = 0
          })
          .catch((err) => {
            console.warn('[useBackend] ping failed', err)
            if (++pingFailures >= 2) {
              pingFailures = 0
              try { socket.close() } catch { /* close handler reconnects */ }
            }
          })
      }, 10_000)
    })

    socket.addEventListener('message', (ev) => {
      let msg: WsResponse | (WsRequest & { ok?: undefined })
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as WsResponse
      } catch (err) {
        console.error('[useBackend] bad message', err)
        return
      }
      if ('ok' in msg && msg.ok !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!
        pending.delete(msg.id)
        entry.resolve(msg)
        return
      }
      emit(msg.type, (msg as WsRequest).payload)
    })

    socket.addEventListener('close', () => {
      ws.value = null
      if (pingTimer !== null) {
        window.clearInterval(pingTimer)
        pingTimer = null
      }
      // Immediately reject all pending requests so callers aren't left hanging.
      for (const [, entry] of pending) {
        entry.reject(new Error('WebSocket closed'))
      }
      pending.clear()
      if (!disposed) {
        status.value = 'disconnected'
        // Exponential backoff: 1.5 s → 3 s → 6 s → … capped at 30 s.
        const delay = Math.min(1500 * Math.pow(2, reconnectAttempts), 30_000)
        reconnectAttempts++
        reconnectTimer = window.setTimeout(connect, delay)
      }
    })

    socket.addEventListener('error', () => {
      status.value = 'error'
      lastError.value = 'WebSocket error'
    })
  }

  async function init(): Promise<void> {
    let info: BackendInfo = { status: 'starting' }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      info = (await window.agentTeam?.getBackendInfo?.()) ?? { status: 'starting' }
      if (info.status === 'ready') break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (info.status !== 'ready' || !info.wsUrl) {
      status.value = 'error'
      lastError.value = 'backend did not start'
      return
    }
    wsUrl.value = info.wsUrl
    httpUrl.value = info.httpUrl ?? ''
    shell.value = info.shell ?? ''
    connect()
  }

  void init()

  onScopeDispose(() => {
    disposed = true
    if (pingTimer !== null) window.clearInterval(pingTimer)
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    ws.value?.close()
  })

  return { status, wsUrl, httpUrl, shell, lastError, send, on }
}
