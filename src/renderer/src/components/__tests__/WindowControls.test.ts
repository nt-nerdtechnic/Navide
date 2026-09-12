// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { platformId, setPlatformId, type PlatformId } from '../../../../shared/osplat'
import WindowControls from '../WindowControls.vue'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

type Bridge = {
  minimize: ReturnType<typeof vi.fn>
  toggleMaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  onMaximizeChanged: ReturnType<typeof vi.fn>
}

let bridge: Bridge
let disposed: number

function installBridge(maximized = false): void {
  disposed = 0
  bridge = {
    minimize: vi.fn().mockResolvedValue({ ok: true }),
    toggleMaximize: vi.fn().mockResolvedValue({ ok: true, maximized: !maximized }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    isMaximized: vi.fn().mockResolvedValue({ maximized }),
    onMaximizeChanged: vi.fn(() => () => {
      disposed += 1
    }),
  }
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { windowControls: bridge }
}

beforeEach(() => installBridge())

afterEach(() => {
  setPlatformId(BASELINE)
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

const on = (id: PlatformId): void => setPlatformId(id)

describe('WindowControls', () => {
  // macOS draws its own traffic lights over the frameless window, so a second
  // set of buttons there would be a duplicate, not a fix.
  it('draws nothing on macOS', () => {
    on('darwin')
    const wrapper = mount(WindowControls)
    expect(wrapper.find('.win-controls').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it.each(['win32', 'linux'] as PlatformId[])(
    'draws all three controls on %s',
    (platform) => {
      on(platform)
      const wrapper = mount(WindowControls)
      expect(wrapper.find('.win-controls').exists()).toBe(true)
      expect(wrapper.findAll('button')).toHaveLength(3)
    }
  )

  it('routes each button to its own bridge call', async () => {
    on('linux')
    const wrapper = mount(WindowControls)
    const [minimize, maximize, close] = wrapper.findAll('button')
    await minimize.trigger('click')
    await maximize.trigger('click')
    await close.trigger('click')
    expect(bridge.minimize).toHaveBeenCalledTimes(1)
    expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  // The bar itself is the drag region, so a click that reached it as a drag
  // would move the window instead of pressing the button.
  it('keeps the cluster out of the drag region', () => {
    on('linux')
    const wrapper = mount(WindowControls)
    expect(wrapper.find('.win-controls').classes()).toContain('win-controls')
    // mousedown is stopped so the frameless drag handler never sees it.
    expect(wrapper.html()).toContain('aria-label="Minimize"')
  })

  it('asks for the current maximised state on mount and subscribes', async () => {
    on('win32')
    installBridge(true)
    const wrapper = mount(WindowControls)
    await vi.waitFor(() => expect(bridge.isMaximized).toHaveBeenCalled())
    expect(bridge.onMaximizeChanged).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(wrapper.find('button[aria-label="Restore"]').exists()).toBe(true)
    )
  })

  it('follows the state pushed from main', async () => {
    on('linux')
    const wrapper = mount(WindowControls)
    await vi.waitFor(() => expect(bridge.onMaximizeChanged).toHaveBeenCalled())
    const push = bridge.onMaximizeChanged.mock.calls[0][0] as (v: boolean) => void
    push(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[aria-label="Restore"]').exists()).toBe(true)
    push(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[aria-label="Maximize"]').exists()).toBe(true)
  })

  it('unsubscribes when the window goes away', async () => {
    on('linux')
    const wrapper = mount(WindowControls)
    await vi.waitFor(() => expect(bridge.onMaximizeChanged).toHaveBeenCalled())
    wrapper.unmount()
    expect(disposed).toBe(1)
  })

  // The plugin case, not a defensive one: EditorWindowApp is mounted both as a
  // Host window and inside the mini-IDE plugin bundle, and a plugin sandbox
  // has `window.nav`, never `window.agentTeam`. Three buttons that cannot act
  // on anything are worse than none — those windows take the system frame
  // instead (see systemFrameUnlessMac).
  it('draws nothing without the Host bridge, even on a platform that needs controls', () => {
    on('linux')
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    const wrapper = mount(WindowControls)
    expect(wrapper.find('.win-controls').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})
