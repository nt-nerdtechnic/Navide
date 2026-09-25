// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, onMounted } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { executeCommand } from '@navide/plugin-ui/shared'

type EditorTargetListener = (target: { path: string; line?: number; column?: number; sourceItem: string }) => Promise<{ opened: boolean }>
type ClosePrepareListener = (reason: 'receiver-item-batch' | 'native-window-close' | 'reload' | 'quit') => Promise<{ accepted: boolean; reason?: string }>

const state = {
  editorTargetListener: null as EditorTargetListener | null,
  closePrepareListener: null as ClosePrepareListener | null,
}

const nav = {
  callCapability: vi.fn(async (_namespace: string, method: string) => ({
    reqId: 'test',
    ok: true,
    result: method === 'readEditorPreferences' ? { preferences: {} } : { found: false },
  })),
  on: vi.fn(() => vi.fn()),
  ready: vi.fn(),
  hideSelf: vi.fn(),
  registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-1' })),
  listReceiverLeftContributions: vi.fn(async () => []),
  openReceiverLeft: vi.fn(async () => undefined),
  acceptExistingReceiverOffer: vi.fn(async () => ({ accepted: true, itemId: 'item-1' })),
  onReceiverOffer: vi.fn(() => vi.fn()),
  onReceiverEditorTarget: vi.fn((_receiverId: string, listener: EditorTargetListener) => {
    state.editorTargetListener = listener
    return vi.fn()
  }),
  onReceiverCloseGuard: vi.fn((_receiverId: string, onPrepare: ClosePrepareListener) => {
    state.closePrepareListener = onPrepare
    return vi.fn()
  }),
  mountReceiver: vi.fn(async () => ({ itemId: 'item-1' })),
  requestCloseReceiver: vi.fn(async () => ({ closed: true as const })),
  requestCloseReceiverTransaction: vi.fn(async () => ({ closed: true as const })),
  abortReceiverItem: vi.fn(async () => undefined),
  onReceiverItemClosed: vi.fn(() => vi.fn()),
  disposeReceiver: vi.fn(async () => undefined),
  onOpenTarget: vi.fn(() => vi.fn()),
}

;(globalThis as unknown as { nav: typeof nav }).nav = nav

let MiniIdeApp: typeof import('../MiniIdeApp.vue').default

beforeAll(async () => {
  MiniIdeApp = (await import('../MiniIdeApp.vue')).default
})

let wrapper: VueWrapper | null = null
const originalLocale = i18n.global.locale.value

afterEach(() => {
  const { dialog, resolveDialog } = useNotify()
  if (dialog.value) resolveDialog(false)
  wrapper?.unmount()
  wrapper = null
  i18n.global.locale.value = originalLocale
})

// An EditorPane that reports its buffer dirty as soon as it mounts.
const dirtyEditorPane = defineComponent({
  name: 'EditorPane',
  emits: ['dirty'],
  setup(_, { emit, expose }) {
    expose({
      prepareClose: () => ({ isCurrent: () => true, release: vi.fn() }),
      save: vi.fn(async () => undefined),
      revealPositionWhenReady: vi.fn(async () => true),
    })
    onMounted(() => emit('dirty', true))
    return () => h('div', { class: 'test-editor-pane' })
  },
})

async function mountWithDirtyFile(): Promise<void> {
  wrapper = mount(MiniIdeApp, {
    shallow: true,
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, plugins: [i18n], stubs: { EditorPane: dirtyEditorPane } },
  })
  await flushPromises()
  await state.editorTargetListener?.({ path: 'src/App.ts', line: 1, column: 1, sourceItem: 'item-a' })
  await flushPromises()
  expect(wrapper.find('.test-editor-pane').exists()).toBe(true)
}

function shownDialog(): { title: string; message: string; confirmText: string } {
  const d = useNotify().dialog.value
  expect(d).not.toBeNull()
  return { title: d!.title, message: d!.message, confirmText: d!.confirmText }
}

describe('MiniIdeApp dirty-close prompts follow the UI language', () => {
  it('asks in Japanese before closing the editor window with unsaved files', async () => {
    i18n.global.locale.value = 'ja-JP'
    await mountWithDirtyFile()

    void state.closePrepareListener?.('native-window-close')
    await flushPromises()

    expect(shownDialog()).toEqual({
      title: 'エディターを閉じる',
      message: '1 個のファイルに未保存の変更があります。それでもエディターを閉じますか？',
      confirmText: '閉じる',
    })
  })

  it('asks in Traditional Chinese before quitting with unsaved files', async () => {
    i18n.global.locale.value = 'zh-TW'
    await mountWithDirtyFile()

    void state.closePrepareListener?.('quit')
    await flushPromises()

    expect(shownDialog()).toEqual({
      title: '結束',
      message: '1 個檔案有未儲存的變更。要結束並捨棄嗎？',
      confirmText: '結束',
    })
  })

  it('asks in Japanese before Close All Editors discards unsaved files', async () => {
    i18n.global.locale.value = 'ja-JP'
    await mountWithDirtyFile()

    void executeCommand('workbench.action.closeAllEditors')
    await flushPromises()

    expect(shownDialog()).toEqual({
      title: 'すべて閉じる',
      message: '1 個のファイルに未保存の変更があります。それでもすべて閉じますか？',
      confirmText: 'すべて閉じる',
    })
  })
})
