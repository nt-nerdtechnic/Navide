import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGuestAttachHooks, type MutableWebPreferences } from './pluginGuestAttach'
import { PluginFrameAssetProtocol, PLUGIN_FRAME_SCHEME } from './pluginFrameAssetProtocol'
import { PluginFrameBindingRegistry } from './pluginFrameBinding'

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = { on: vi.fn(), postMessage: vi.fn(), close: vi.fn(), start: vi.fn() }
    port2 = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() }
  },
}))

const APPROVED = 'file:///pkg/index.html?workspace_path=/ws&nv_guest=tok'

function target(overrides: Partial<{ prefs: unknown; attach: boolean }> = {}) {
  return {
    guestAttachPreferences: vi.fn((src: string) =>
      src === APPROVED ? { preload: '/preload/plugin-preload.js', pluginId: 'navide.git' } : null
    ),
    attachGuestContribution: vi.fn(() => overrides.attach ?? true),
  }
}
const guest = (): { close: ReturnType<typeof vi.fn> } => ({ close: vi.fn() })
const event = (): { preventDefault: ReturnType<typeof vi.fn> } => ({ preventDefault: vi.fn() })

describe('createGuestAttachHooks', () => {
  it('forces the Host preload, sandbox and plugin id over whatever the tag asked for', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    // A renderer trying to escalate through the tag.
    const prefs: MutableWebPreferences = {
      preload: '/evil.js',
      nodeIntegration: true,
      sandbox: false,
      contextIsolation: false,
      additionalArguments: ['--plugin-id=navide.plans'],
    }
    hooks.onWillAttach(e, prefs, { src: APPROVED })

    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(prefs.preload).toBe('/preload/plugin-preload.js')
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.webSecurity).toBe(true)
    // Replaced, not appended: the spoofed id is gone.
    expect(prefs.additionalArguments).toEqual(['--plugin-id=navide.git'])
  })

  it('forwards approved additionalArguments including backend flags', () => {
    const mgr = {
      guestAttachPreferences: vi.fn(() => ({
        preload: '/preload/plugin-preload.js',
        pluginId: 'navide.plans',
        additionalArguments: ['--plugin-id=navide.plans', '--plugin-backend=1'],
      })),
      attachGuestContribution: vi.fn(() => true),
    }
    const hooks = createGuestAttachHooks(mgr)
    const prefs: MutableWebPreferences = {}
    hooks.onWillAttach(event(), prefs, { src: APPROVED })
    expect(prefs.additionalArguments).toEqual(['--plugin-id=navide.plans', '--plugin-backend=1'])
  })

  it('vetoes a src the Host never handed out', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    const prefs: MutableWebPreferences = {}
    hooks.onWillAttach(e, prefs, { src: 'file:///elsewhere/index.html' })
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(prefs.preload).toBeUndefined()
  })

  it('vetoes an attach with no src at all', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    hooks.onWillAttach(e, {}, {})
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('binds the guest that follows an approved will-attach', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).toHaveBeenCalledWith(APPROVED, g)
    expect(g.close).not.toHaveBeenCalled()
  })

  it('closes a guest that arrives without an approval', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).not.toHaveBeenCalled()
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('closes a guest the manager refuses to bind', () => {
    const manager = target({ attach: false })
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(g)
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('consumes the approval once, so a second guest cannot ride it', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(guest())
    const second = guest()
    hooks.onDidAttach(second)
    expect(manager.attachGuestContribution).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('a vetoed will-attach clears any earlier approval', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onWillAttach(event(), {}, { src: 'file:///elsewhere/index.html' })
    const g = guest()
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).not.toHaveBeenCalled()
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('drops the webPreferences the tag contributed before applying the Host values', () => {
    const hooks = createGuestAttachHooks(target())
    // Electron merges these in before will-attach-webview runs; `partition`
    // would put the guest on a session outside the Host's request filtering.
    const prefs: MutableWebPreferences = {
      partition: 'persist:evil',
      plugins: true,
      allowpopups: true,
      enableBlinkFeatures: 'Something',
      experimentalFeatures: true,
      javascript: false,
    }
    hooks.onWillAttach(event(), prefs, { src: APPROVED })

    for (const key of ['partition', 'plugins', 'allowpopups', 'enableBlinkFeatures', 'experimentalFeatures', 'javascript']) {
      expect(prefs[key]).toBeUndefined()
    }
    // …and the Host's own values are still what the guest gets.
    expect(prefs.preload).toBe('/preload/plugin-preload.js')
    expect(prefs.sandbox).toBe(true)
  })
})

describe('PluginFrameAssetProtocol', () => {
  it('serves only mounted regular assets and rejects foreign, escaping, symlink, and non-GET requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-frame-assets-'))
    const outside = mkdtempSync(join(tmpdir(), 'plugin-frame-assets-outside-'))
    try {
      mkdirSync(join(root, 'frontend'), { recursive: true })
      writeFileSync(join(root, 'frontend/index.html'), '<!doctype html>')
      writeFileSync(join(outside, 'secret.html'), 'secret')
      symlinkSync(join(outside, 'secret.html'), join(root, 'frontend/linked.html'))
      const protocol = new PluginFrameAssetProtocol()
      const origin = await protocol.mount({
        artifactId: 'artifact', packageId: 'acme.viewer', packageVersion: '1.0.0', root,
      })
      const ok = await protocol.handle(new Request(`${origin}frontend/index.html`))
      expect(ok.status).toBe(200)
      await expect(ok.text()).resolves.toContain('<!doctype html>')
      expect((await protocol.handle(new Request(`${PLUGIN_FRAME_SCHEME}://foreign/frontend/index.html`))).status).toBe(404)
      expect((await protocol.handle(new Request(`${origin}../secret.html`))).status).toBe(404)
      expect((await protocol.handle(new Request(`${origin}frontend/linked.html`))).status).toBe(404)
      expect((await protocol.handle(new Request(`${origin}frontend/index.html`, { method: 'POST' }))).status).toBe(404)
      protocol.revoke(origin)
      expect((await protocol.handle(new Request(`${origin}frontend/index.html`))).status).toBe(404)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('PluginFrameBindingRegistry', () => {
  const identity = {
    artifactId: 'artifact', contributionKey: 'acme.viewer.left', entryUrl: 'navide-plugin-frame://host/frontend/index.html',
    instanceId: 'instance-1', packageId: 'acme.viewer', packageVersion: '1.0.0', receiverGeneration: 'nonce-1',
    receiverWebContentsId: 10, workspacePath: '/workspace',
  }

  it('rejects wrong frame/state and revocation stops delivery', () => {
    const registry = new PluginFrameBindingRegistry()
    const reserved = registry.reserve(identity)
    const wrong = { detached: true, frameTreeNodeId: 2 }
    const right = { detached: false, frameTreeNodeId: 1 }
    expect(registry.beginNavigation(reserved.id, right as never, identity.entryUrl)).toBeNull()
    expect(registry.bindBlank(reserved.id, wrong as never)).toBeNull()
    expect(registry.bindBlank(reserved.id, right as never)).not.toBeNull()
    expect(registry.beginNavigation(reserved.id, wrong as never, identity.entryUrl)).toBeNull()
    expect(registry.beginNavigation(reserved.id, right as never, identity.entryUrl)).not.toBeNull()

    const second = registry.reserve({ ...identity, instanceId: 'instance-2', receiverGeneration: 'nonce-2' })
    const rightSecond = { detached: false, frameTreeNodeId: 3 }
    expect(registry.bindBlank(second.id, rightSecond as never)).not.toBeNull()
    expect(registry.beginNavigation(second.id, rightSecond as never, identity.entryUrl)).not.toBeNull()
    expect(registry.admit(rightSecond as never, 10, 'nonce-2', () => undefined)).not.toBeNull()
    expect(registry.post('instance-2', 'plugin:test', { ok: true })).toBe(true)
    expect(registry.size).toBe(2)
    registry.revoke(second.id)
    expect(registry.post('instance-2', 'plugin:test', { ok: false })).toBe(false)
    expect(registry.admit(rightSecond as never, 10, 'nonce-2', () => undefined)).toBeNull()
    // A revoked reservation is dropped, so repeated open/close cycles cannot
    // grow the registry.
    expect(registry.size).toBe(1)
    registry.revokeInstance(identity.instanceId)
    expect(registry.size).toBe(0)
    registry.revoke(second.id)
    expect(registry.size).toBe(0)
  })

  it('keeps only live bindings across repeated reserve/revoke cycles', () => {
    const registry = new PluginFrameBindingRegistry()
    for (let index = 0; index < 25; index += 1) {
      const reserved = registry.reserve({ ...identity, instanceId: `instance-${index}` })
      const frame = { detached: false, frameTreeNodeId: 100 + index }
      expect(registry.bindBlank(reserved.id, frame as never)).not.toBeNull()
      expect(registry.beginNavigation(reserved.id, frame as never, identity.entryUrl)).not.toBeNull()
      expect(registry.admit(frame as never, 10, 'nonce', () => undefined)).not.toBeNull()
      registry.revokeInstance(`instance-${index}`)
    }
    expect(registry.size).toBe(0)
  })
})
