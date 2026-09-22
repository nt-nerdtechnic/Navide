// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { platformId, setPlatformId, type PlatformId } from '../../../../shared/osplat'
import WindowControls from '../WindowControls.vue'
import { i18n } from '@navide/plugin-ui/foundation'

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

/**
 * The cluster is teleported to <body>, so it is not inside the wrapper and
 * `wrapper.find` cannot see it. Query the document instead, and unmount every
 * wrapper afterwards or the teleported nodes outlive their test.
 */
let wrappers: VueWrapper[] = []
const render = (): VueWrapper => {
  const wrapper = mount(WindowControls)
  wrappers.push(wrapper)
  return wrapper
}
const controls = (): Element | null => document.body.querySelector('.win-controls')
const buttons = (): HTMLElement[] =>
  [...document.body.querySelectorAll<HTMLElement>('.win-controls button')]
const button = (label: string): HTMLElement | null =>
  document.body.querySelector(`.win-controls button[aria-label="${label}"]`)

beforeEach(() => { installBridge(); i18n.global.locale.value = 'en-US' })

afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
  setPlatformId(BASELINE)
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

const on = (id: PlatformId): void => setPlatformId(id)

describe('WindowControls', () => {
  // macOS draws its own traffic lights over the frameless window, so a second
  // set of buttons there would be a duplicate, not a fix.
  it('localizes visible labels and accessible names on language changes', async () => {
    on('linux')
    const wrapper = render()
    i18n.global.locale.value = 'ja-JP'
    await wrapper.vm.$nextTick()
    expect(controls()?.getAttribute('aria-label')).toBe('ウィンドウ操作')
    expect(buttons().map(button => button.getAttribute('aria-label'))).toEqual(['最小化', '最大化', '閉じる'])
    expect(button('最小化')?.getAttribute('title')).toBe('最小化')
    i18n.global.locale.value = 'en-US'
    await wrapper.vm.$nextTick()
    expect(button('Minimize')).not.toBeNull()
  })

  it('draws nothing on macOS', () => {
    on('darwin')
    const wrapper = render()
    expect(controls()).toBeNull()
    expect(buttons()).toHaveLength(0)
    // Not even the marker the title bar's padding rule keys off — macOS keeps
    // its own 80px traffic-light gutter, untouched.
    expect(wrapper.find('.win-controls-anchor').exists()).toBe(false)
    // No element at all — the template is two `v-if`s and nothing else, so on
    // macOS this component contributes no node to any document.
    expect(wrapper.findAll('*')).toHaveLength(0)
  })

  it.each(['win32', 'linux'] as PlatformId[])(
    'draws all three controls on %s',
    (platform) => {
      on(platform)
      const wrapper = render()
      expect(controls()).not.toBeNull()
      expect(buttons()).toHaveLength(3)
      // The marker stays behind in the bar; only the buttons travel.
      expect(wrapper.find('.win-controls-anchor').exists()).toBe(true)
    }
  )

  it('routes each button to its own bridge call', async () => {
    on('linux')
    render()
    const [minimize, maximize, close] = buttons()
    minimize.click()
    maximize.click()
    close.click()
    await Promise.resolve()
    expect(bridge.minimize).toHaveBeenCalledTimes(1)
    expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  // The bar itself is the drag region, so a click that reached it as a drag
  // would move the window instead of pressing the button.
  it('keeps the cluster out of the drag region', () => {
    on('linux')
    render()
    // mousedown is stopped so the frameless drag handler never sees it.
    expect(button('Minimize')).not.toBeNull()
    expect(controls()!.className).toContain('win-controls')
  })

  it('asks for the current maximised state on mount and subscribes', async () => {
    on('win32')
    installBridge(true)
    render()
    await vi.waitFor(() => expect(bridge.isMaximized).toHaveBeenCalled())
    expect(bridge.onMaximizeChanged).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(button('Restore')).not.toBeNull())
  })

  it('follows the state pushed from main', async () => {
    on('linux')
    const wrapper = render()
    await vi.waitFor(() => expect(bridge.onMaximizeChanged).toHaveBeenCalled())
    const push = bridge.onMaximizeChanged.mock.calls[0][0] as (v: boolean) => void
    push(true)
    await wrapper.vm.$nextTick()
    expect(button('Restore')).not.toBeNull()
    push(false)
    await wrapper.vm.$nextTick()
    expect(button('Maximize')).not.toBeNull()
  })

  it('unsubscribes when the window goes away', async () => {
    on('linux')
    const wrapper = render()
    await vi.waitFor(() => expect(bridge.onMaximizeChanged).toHaveBeenCalled())
    wrapper.unmount()
    expect(disposed).toBe(1)
    // …and the teleported cluster goes with it, rather than being left on
    // <body> after the window root that owns it is gone.
    expect(controls()).toBeNull()
  })

  // The plugin case, not a defensive one: EditorWindowApp is mounted both as a
  // Host window and inside the mini-IDE plugin bundle, and a plugin sandbox
  // has `window.nav`, never `window.agentTeam`. Three buttons that cannot act
  // on anything are worse than none — those windows take the system frame
  // instead (see systemFrameUnlessMac).
  it('draws nothing without the Host bridge, even on a platform that needs controls', () => {
    on('linux')
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    render()
    expect(controls()).toBeNull()
    expect(buttons()).toHaveLength(0)
  })
})
