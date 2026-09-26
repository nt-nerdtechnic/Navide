// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'

// The plugin's native bridge ships without window controls today (the view
// keeps the system frame off macOS); give it one so the drawn cluster renders.
vi.mock('../../lib/osplat', () => ({ needsDrawnWindowControls: () => true }))
vi.mock('../../composables/native', () => ({
  native: {
    windowControls: {
      minimize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => ({ maximized: true })),
      isMaximized: vi.fn(async () => ({ maximized: false })),
      onMaximizeChanged: vi.fn(() => () => undefined),
    },
  },
}))

import WindowControls from '../WindowControls.vue'

let wrappers: VueWrapper[] = []
const render = (): VueWrapper => {
  const wrapper = mount(WindowControls, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
const controls = (): Element | null => document.body.querySelector('.win-controls')
const buttons = (): HTMLElement[] =>
  [...document.body.querySelectorAll<HTMLElement>('.win-controls button')]

beforeEach(() => { i18n.global.locale.value = 'en-US' })

afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
})

describe('mini-IDE WindowControls', () => {
  it('teleports the cluster to <body> and leaves only the marker in the title bar', () => {
    const wrapper = render()

    expect(controls()?.parentElement).toBe(document.body)
    expect(wrapper.find('.win-controls').exists()).toBe(false)
    expect(wrapper.find('.win-controls-anchor').exists()).toBe(true)
  })

  it('localizes visible labels and accessible names on language changes', async () => {
    const wrapper = render()
    i18n.global.locale.value = 'ja-JP'
    await wrapper.vm.$nextTick()

    expect(controls()?.getAttribute('aria-label')).toBe('ウィンドウ操作')
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['最小化', '最大化', '閉じる'])
    expect(buttons().map((b) => b.getAttribute('title'))).toEqual(['最小化', '最大化', '閉じる'])
  })
})
