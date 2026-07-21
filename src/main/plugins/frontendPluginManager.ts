// Frontend plugin runtime (main process) — Phase 2 M1 skeleton.
//
// Runs a plugin's UI inside an isolated `WebContentsView` attached to a host
// BrowserWindow, with a minimal, dedicated preload (`plugin-preload.js`). The
// only capability wired in M1 is the in-process `ping` no-op; the pure broker
// logic lives in `pluginCapabilityBroker.ts` (unit-tested, electron-free).
//
// M2 replaces the `ping` branch of the broker with a dispatch to the backend
// plugin host over WebSocket. Nothing here talks to the backend yet.

import { WebContentsView, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import {
  parseCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  isCapabilityAllowed,
  buildError,
  type CapabilityResponse,
} from './pluginCapabilityBroker'
import { CAP_EVENTS, eventNamespace } from './capabilityMap'
import { createWsClient, type WsClient, type WsConstructor } from '../../shared/wsClient'

/** Everything the manager needs to launch one plugin view. */
export interface PluginLaunchDescriptor {
  /** Manifest id, e.g. `navide.noop`. */
  id: string
  /** Capabilities the plugin's manifest declares (drives broker scoping). */
  requires: string[]
  /** Dev-server URL for the plugin entry (used when running under electron-vite dev). */
  devUrl: string
  /** Absolute file path to the built plugin entry (packaged / built runs). */
  entryFile: string
  /** Optional `?a=b` query appended to the entry (e.g. the mini-IDE workspace
   *  path the app reads from `window.location.search`). Omitted → no query. */
  query?: string
}

export interface PluginBounds {
  x: number
  y: number
  width: number
  height: number
}

interface RunningPlugin {
  id: string
  requires: string[]
  view: WebContentsView
  hostWindow: BrowserWindow
}

const IPC_CALL = 'plugin:cap:call'
const IPC_EVENT = 'plugin:cap:event'
const IPC_READY = 'plugin:ready'

/**
 * Manages the lifecycle of frontend plugin views and brokers their capability
 * calls. A single instance owns all plugin views across every host window.
 */
/** Coerce plugin-supplied args into a WS payload object; non-objects become an
 *  empty payload rather than corrupting the backend request. */
function toPayload(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

export class FrontendPluginManager {
  private readonly running = new Map<string, RunningPlugin>()
  /** webContents.id → pluginId, so a call's origin can be trusted, not the payload. */
  private readonly bySender = new Map<number, string>()
  private ipcReady = false
  /** Backend WS url as last reported by main, or null when no backend is up. */
  private backendWsUrl: string | null = null
  /** Lazily-created shared transport to the backend plugin host. */
  private wsClient: WsClient | null = null

  /** Register the broker IPC handlers exactly once. Safe to call repeatedly. */
  registerIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true

    ipcMain.handle(IPC_CALL, async (event, payload: unknown): Promise<CapabilityResponse> => {
      const pluginId = this.bySender.get(event.sender.id)
      if (!pluginId) {
        // Not a known plugin view — refuse without leaking anything.
        return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
      }
      const plugin = this.running.get(pluginId)
      const call = parseCapabilityCall(payload, pluginId)
      if (!call || !plugin) {
        const reqId =
          typeof payload === 'object' && payload && 'reqId' in payload
            ? String((payload as Record<string, unknown>).reqId ?? '')
            : ''
        return buildError(reqId, 'BAD_REQUEST', 'malformed capability call')
      }

      // Enforce scoping + route. A denied namespace is rejected here and never
      // reaches the backend; `ping`/unknown resolve in-process.
      const plan = planCapabilityCall(call, plugin.requires)
      if (plan.kind === 'respond') return plan.response

      const client = this.ensureBackend()
      if (!client) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'backend not connected')
      }
      try {
        const resp = await client.send(plan.wsType, toPayload(call.args))
        return backendResponseToCapability(call.reqId, resp)
      } catch (err) {
        return buildError(
          call.reqId,
          'BACKEND_ERROR',
          err instanceof Error ? err.message : 'backend request failed'
        )
      }
    })

    // M1: plugins announce readiness; we only log it. M2 may gate activation on it.
    ipcMain.on(IPC_READY, (event) => {
      const pluginId = this.bySender.get(event.sender.id)
      if (pluginId) console.log(`[plugin] ${pluginId} ready`)
    })
  }

  /**
   * Main tells the manager the backend WS url on every backend transition
   * (ready / restart with a new port / stop / crash). A live client is
   * re-pointed at the new url; a stopped/errored backend puts it into fail-fast
   * so brokered calls reject instead of queueing forever.
   */
  setBackendWsUrl(url: string | null): void {
    this.backendWsUrl = url
    const client = this.wsClient
    if (url) {
      if (!client) {
        // Connect eagerly if a running plugin already needs the backend, so
        // server-push events (git.changed) flow without waiting for the first
        // capability call. Otherwise ensureBackend() connects lazily later.
        if (this.anyPluginNeedsBackend()) this.ensureBackend()
        return
      }
      if (client.isHealthyFor(url)) return
      client.reset('backend changed')
      client.connect(url)
    } else if (client) {
      client.reset('backend stopped')
      client.markErrored()
    }
  }

  /** True when any running plugin declares a non-empty `requires` (i.e. needs
   *  the backend for calls and/or events; `ping`-only plugins don't). */
  private anyPluginNeedsBackend(): boolean {
    for (const plugin of this.running.values()) {
      if (plugin.requires.length > 0) return true
    }
    return false
  }

  /** Lazily create + connect the backend transport, subscribing to the
   *  server-push events the broker forwards. Returns null when no backend url
   *  is known yet. */
  private ensureBackend(): WsClient | null {
    if (!this.backendWsUrl) return null
    if (!this.wsClient) {
      const client = createWsClient({ WebSocketImpl: NodeWebSocket as unknown as WsConstructor })
      for (const event of Object.keys(CAP_EVENTS)) {
        client.on(event, (payload) => this.dispatchEvent(event, payload))
      }
      client.connect(this.backendWsUrl)
      this.wsClient = client
    }
    return this.wsClient
  }

  /** Fan a backend server-push event out to every running plugin whose
   *  manifest grants the namespace gating that event. */
  private dispatchEvent(event: string, payload: unknown): void {
    const ns = eventNamespace(event)
    if (!ns) return
    for (const plugin of this.running.values()) {
      if (isCapabilityAllowed(plugin.requires, ns)) {
        this.emit(plugin.id, event, payload)
      }
    }
  }

  /**
   * create → attach → activate. If the plugin is already running it is brought
   * back to visible and re-bounded (idempotent open).
   */
  open(hostWindow: BrowserWindow, descriptor: PluginLaunchDescriptor, bounds: PluginBounds): void {
    this.registerIpc()

    const existing = this.running.get(descriptor.id)
    if (existing) {
      existing.view.setBounds(bounds)
      this.activate(descriptor.id)
      return
    }

    const preload = join(__dirname, '../preload/plugin-preload.js')
    const view = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Injected so the preload can stamp calls with an authoritative plugin id.
        additionalArguments: [`--plugin-id=${descriptor.id}`],
      },
    })

    // attach
    hostWindow.contentView.addChildView(view)
    view.setBounds(bounds)

    const record: RunningPlugin = {
      id: descriptor.id,
      requires: descriptor.requires,
      view,
      hostWindow,
    }
    this.running.set(descriptor.id, record)
    this.bySender.set(view.webContents.id, descriptor.id)

    // A plugin needing the backend gets the shared transport connected now (if
    // the backend url is already known) so server-push events reach it without
    // waiting for its first capability call.
    if (descriptor.requires.length > 0) this.ensureBackend()

    // If the host window goes away, tear the view down with it.
    hostWindow.once('closed', () => this.destroy(descriptor.id))

    // load entry (dev server when available, built file otherwise). A plugin
    // with an empty devUrl (e.g. the separately-built mini-IDE) always loadFiles.
    const devUrl = process.env['ELECTRON_RENDERER_URL'] ? descriptor.devUrl : null
    const query = descriptor.query ?? ''
    if (devUrl) void view.webContents.loadURL(devUrl + query)
    else void view.webContents.loadFile(descriptor.entryFile, query ? { search: query } : undefined)

    // activate (show)
    view.setVisible(true)
  }

  /** Show a plugin view without recreating it. */
  activate(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (plugin) plugin.view.setVisible(true)
  }

  /** Hide a plugin view without destroying its WebContents. */
  deactivate(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (plugin) plugin.view.setVisible(false)
  }

  /** Update the plugin view's rect (host-driven layout). */
  setBounds(pluginId: string, bounds: PluginBounds): void {
    const plugin = this.running.get(pluginId)
    if (plugin) plugin.view.setBounds(bounds)
  }

  /** detach → destroy. WebContents are not auto-released, so close explicitly. */
  destroy(pluginId: string): void {
    const plugin = this.running.get(pluginId)
    if (!plugin) return
    this.running.delete(pluginId)
    this.bySender.delete(plugin.view.webContents.id)
    try {
      if (!plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.contentView.removeChildView(plugin.view)
      }
      if (!plugin.view.webContents.isDestroyed()) {
        plugin.view.webContents.close()
      }
    } catch {
      // View/window already torn down by Electron — nothing to release.
    }
  }

  /** Push an event to a plugin view (M1 has no producers; wired for M2). */
  emit(pluginId: string, type: string, data: unknown): void {
    const plugin = this.running.get(pluginId)
    if (plugin && !plugin.view.webContents.isDestroyed()) {
      plugin.view.webContents.send(IPC_EVENT, { type, data })
    }
  }
}

/** Process-wide singleton. */
export const frontendPluginManager = new FrontendPluginManager()

/**
 * The M1 no-op plugin descriptor. Its entry is built as a second renderer input
 * (see electron.vite.config.ts), so in dev it is served by the renderer dev
 * server and in packaged builds it sits next to the main renderer bundle.
 */
export function noopPluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.noop',
    requires: [], // only the built-in `ping` capability is used
    devUrl: `${base}/plugins/noop/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/noop/index.html'),
  }
}

/**
 * Convenience used by the dev-only menu entry: open the no-op plugin view in a
 * fixed rect at the top-left of the host window. Precise host-rect sync is left
 * for later — see the manual-verification notes in the M1 report.
 */
export function openNoopPluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, noopPluginDescriptor(), {
    x: 40,
    y: 60,
    width: 480,
    height: 360,
  })
}

/**
 * The M2 fs-probe plugin descriptor. Declares `requires: ['fs']` so its
 * brokered `fs.*` calls reach the backend WS and it receives `git.changed`.
 */
export function fsProbePluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.fs_probe',
    requires: ['fs'],
    devUrl: `${base}/plugins/fs_probe/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/fs_probe/index.html'),
  }
}

/** Dev-only helper mirroring {@link openNoopPluginView} for the fs probe. */
export function openFsProbePluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, fsProbePluginDescriptor(), {
    x: 40,
    y: 60,
    width: 520,
    height: 480,
  })
}

/**
 * The M4 mini-IDE plugin descriptor. Declares all seven capability namespaces so
 * its brokered `fs`/`git`/`terminal`/`search`/`chat`/`ui`/`issues` calls are
 * authorized (issues drives GitPane's gh/glab cloud-issue pane).
 *
 * Unlike noop/fs_probe, this bundle is built SEPARATELY (vite.mini-ide.config.ts)
 * with the `useBackend` → capabilityBackend alias, so it is NOT served by the
 * electron-vite dev server. `devUrl` is therefore empty and it always loadFiles
 * the built entry — run `pnpm build` (or `pnpm run build:mini-ide`) first.
 * `workspacePath` (and the backend `httpUrl`) are passed as a query the app
 * reads from window.location.search — the shim resolves `httpUrl` from it so
 * panes can build backend HTTP URLs inside the isolated view.
 */
export function miniIdePluginDescriptor(
  workspacePath: string,
  httpUrl = ''
): PluginLaunchDescriptor {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (httpUrl) params.set('http_url', httpUrl)
  const qs = params.toString()
  return {
    id: 'navide.mini-ide',
    requires: ['fs', 'git', 'terminal', 'search', 'chat', 'ui', 'issues'],
    devUrl: '', // separate build → not on the dev server; always loadFile
    entryFile: join(__dirname, '../renderer/plugins/mini-ide/index.html'),
    query: qs ? `?${qs}` : '',
  }
}

/** Open the mini-IDE plugin view for a workspace. Used by the dev menu and, when
 *  `AGENT_TEAM_MINI_IDE_PLUGIN=1`, by the flag-gated `window:openEditor` path
 *  (see index.ts). Coexists with the legacy editor window; the old path stays
 *  the default until the user validates this one. */
export function openMiniIdePluginView(
  hostWindow: BrowserWindow,
  workspacePath: string,
  httpUrl = ''
): void {
  frontendPluginManager.open(hostWindow, miniIdePluginDescriptor(workspacePath, httpUrl), {
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  })
}
