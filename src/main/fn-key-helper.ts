// The fn (🌐) key for voice input (macOS). Browsers never deliver fn, so the
// native helper native/fn-key/main.c watches it with a listen-only event tap
// and prints JSON Lines; this module runs that helper and relays its events to
// the renderers that asked for them.
//
// The helper runs only while at least one main-window renderer is subscribed,
// and a renderer subscribes only while voice input and the "Use the fn key"
// setting are both on — with the setting off nothing is spawned. The child is
// ours alone: it is stopped by its own PID (never a pattern), when the last
// subscriber leaves and when the app quits, and it also exits by itself when
// its stdin closes.

import type { ChildProcess } from 'node:child_process'
import { FN_KEY_EVENT_CHANNEL, FN_KEY_STATUS_CHANNEL, type FnKeyEventType, type FnKeyStatus } from '../shared/fnKey'

export type FnKeyLine =
  | { event: FnKeyEventType }
  | { event: 'ready'; fnUsage: number }
  | { event: 'status'; granted: boolean; fnUsage: number }
  | { event: 'permission'; granted: boolean }
  | { event: 'reenabled'; reason: string }

/** One stdout line from the helper, or null for anything unrecognised. */
export function parseFnKeyLine(line: string): FnKeyLine | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const usage = typeof o.fnUsage === 'number' ? o.fnUsage : -1
  switch (o.event) {
    case 'down':
    case 'up':
    case 'chord':
      return { event: o.event }
    case 'ready':
      return { event: 'ready', fnUsage: usage }
    case 'status':
      return { event: 'status', granted: o.granted === true, fnUsage: usage }
    case 'permission':
      return { event: 'permission', granted: o.granted === true }
    case 'reenabled':
      return { event: 'reenabled', reason: typeof o.reason === 'string' ? o.reason : '' }
    default:
      return null
  }
}

/** Exit status the helper uses when Input Monitoring is not granted. */
export const EXIT_NO_PERMISSION = 3
/** Respawn delays after consecutive crashes; past the last one it gives up. */
export const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** A helper that ran this long before exiting resets the crash count. */
const STABLE_MS = 60_000

export interface FnKeySubscriber {
  id: number
  send: (channel: string, payload: unknown) => void
}

export interface FnKeyServiceDeps {
  supported: boolean
  /** Absolute path of the helper, or null when it is not there. */
  helperPath: () => string | null
  spawn: (path: string, args: string[]) => ChildProcess
  /** Run `helper --check` / `--request` and return its status line. */
  query: (path: string, arg: '--check' | '--request') => Promise<FnKeyLine | null>
  log: (message: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export class FnKeyService {
  private readonly subscribers = new Map<number, FnKeySubscriber>()
  private child: ChildProcess | null = null
  private status: FnKeyStatus
  private crashes = 0
  private startedAt = 0
  private respawnTimer: unknown = null
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void

  constructor(private readonly deps: FnKeyServiceDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.status = { phase: deps.supported ? 'off' : 'unsupported', fnUsage: null }
  }

  getStatus(): FnKeyStatus {
    return { ...this.status }
  }

  /** Whether a helper process is running right now. */
  isRunning(): boolean {
    return this.child !== null
  }

  subscribe(sub: FnKeySubscriber): FnKeyStatus {
    if (!this.deps.supported) return this.getStatus()
    this.subscribers.set(sub.id, sub)
    if (!this.child && !this.respawnTimer && this.status.phase !== 'no-permission') {
      this.crashes = 0
      this.start()
    }
    return this.getStatus()
  }

  unsubscribe(id: number): void {
    if (!this.subscribers.delete(id) || this.subscribers.size > 0) return
    this.stop()
    this.setStatus({ phase: 'off' })
  }

  /** Ask macOS for Input Monitoring (shows its prompt the first time), then
   *  start the helper if access is there and someone is waiting for it. */
  async requestPermission(): Promise<FnKeyStatus> {
    const path = this.deps.helperPath()
    if (!this.deps.supported || !path) return this.getStatus()
    const res = await this.deps.query(path, '--request')
    const granted = res?.event === 'status' && res.granted
    if (res?.event === 'status') this.status.fnUsage = res.fnUsage
    if (granted && this.subscribers.size > 0 && !this.child) {
      this.crashes = 0
      this.start()
    } else {
      this.broadcastStatus()
    }
    return this.getStatus()
  }

  /** App quit: stop our own helper, for good. */
  dispose(): void {
    this.subscribers.clear()
    this.stop()
  }

  private start(): void {
    const path = this.deps.helperPath()
    if (!path) {
      this.deps.log('fn-key: helper binary not found')
      this.setStatus({ phase: 'failed' })
      return
    }
    this.setStatus({ phase: 'starting' })
    let child: ChildProcess
    try {
      child = this.deps.spawn(path, [])
    } catch (e) {
      this.deps.log(`fn-key: spawn failed: ${String(e)}`)
      this.onExit(null, null)
      return
    }
    this.child = child
    this.startedAt = this.now()
    let buffered = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        if (this.child === child) this.onLine(line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => this.deps.log(`fn-key: ${String(chunk).trim()}`))
    child.on('error', (e) => this.deps.log(`fn-key: ${String(e)}`))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return // stopped on purpose
      this.child = null
      this.onExit(code, signal)
    })
  }

  private stop(): void {
    if (this.respawnTimer) {
      this.clearTimer(this.respawnTimer)
      this.respawnTimer = null
    }
    const child = this.child
    this.child = null
    if (!child) return
    child.stdin?.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }

  private onLine(line: string): void {
    const msg = parseFnKeyLine(line)
    if (!msg) return
    switch (msg.event) {
      case 'down':
      case 'up':
      case 'chord':
        this.broadcast(FN_KEY_EVENT_CHANNEL, { type: msg.event })
        return
      case 'ready':
        this.setStatus({ phase: 'ready', fnUsage: msg.fnUsage })
        return
      case 'permission':
        if (!msg.granted) this.setStatus({ phase: 'no-permission' })
        return
      case 'reenabled':
        this.deps.log(`fn-key: event tap re-enabled (${msg.reason})`)
        return
      default:
        return
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Release a take the dead helper can no longer end.
    this.broadcast(FN_KEY_EVENT_CHANNEL, { type: 'up' })
    if (code === EXIT_NO_PERMISSION) {
      this.setStatus({ phase: 'no-permission' })
      return
    }
    if (this.subscribers.size === 0) {
      this.setStatus({ phase: 'off' })
      return
    }
    if (this.now() - this.startedAt >= STABLE_MS) this.crashes = 0
    const delay = RESPAWN_BACKOFF_MS[this.crashes]
    this.crashes++
    this.deps.log(`fn-key: helper exited (code=${code} signal=${signal})`)
    if (delay === undefined) {
      this.setStatus({ phase: 'failed' })
      return
    }
    this.setStatus({ phase: 'restarting' })
    this.respawnTimer = this.setTimer(() => {
      this.respawnTimer = null
      if (this.subscribers.size > 0 && !this.child) this.start()
    }, delay)
  }

  private setStatus(patch: Partial<FnKeyStatus>): void {
    this.status = { ...this.status, ...patch }
    this.broadcastStatus()
  }

  private broadcastStatus(): void {
    this.broadcast(FN_KEY_STATUS_CHANNEL, this.getStatus())
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const sub of this.subscribers.values()) sub.send(channel, payload)
  }
}
