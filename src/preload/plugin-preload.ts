// Dedicated preload for plugin `WebContentsView`s — Phase 2 M1.
//
// Deliberately minimal: it exposes ONLY `window.nav` (callCapability / on /
// ready). It must NOT expose `window.agentTeam` or any of the host's privileged
// surface — a plugin reaches the host solely through brokered capability calls.

import { contextBridge, ipcRenderer } from 'electron'
import { randomUUID } from 'node:crypto'

// The manager injects `--plugin-id=<id>` via webPreferences.additionalArguments,
// so the id is authoritative (main also verifies by sender) and not spoofable
// from page content.
const PLUGIN_ID_PREFIX = '--plugin-id='
const pluginId =
  process.argv.find((a) => a.startsWith(PLUGIN_ID_PREFIX))?.slice(PLUGIN_ID_PREFIX.length) ?? ''

interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

type EventListener = (data: unknown) => void
const listeners = new Map<string, Set<EventListener>>()

ipcRenderer.on('plugin:cap:event', (_event, payload: { type: string; data: unknown }) => {
  listeners.get(payload.type)?.forEach((cb) => cb(payload.data))
})

const nav = {
  /** Call a host capability. Resolves with the response envelope. */
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse> {
    return ipcRenderer.invoke('plugin:cap:call', {
      pluginId,
      ns,
      method,
      args,
      reqId: randomUUID(),
    })
  },
  /** Subscribe to host-pushed events of a given type. Returns a disposer. */
  on(type: string, cb: EventListener): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  },
  /** Announce the plugin has mounted. */
  ready(): void {
    ipcRenderer.send('plugin:ready')
  },
}

contextBridge.exposeInMainWorld('nav', nav)
