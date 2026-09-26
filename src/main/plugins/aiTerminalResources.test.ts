import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, WebContents } from 'electron'

const h = vi.hoisted(() => ({
  saveClipboardImage: vi.fn(),
  template: null as MenuItemConstructorOptions[] | null,
  popups: 0,
  clipboardWrites: [] as string[],
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app/user-data') },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  clipboard: { writeText: (text: string) => { h.clipboardWrites.push(text) } },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      h.template = template
      return { popup: () => { h.popups++ } }
    },
  },
}))

vi.mock('../dropped-file-store', () => ({
  saveClipboardImage: h.saveClipboardImage,
}))

vi.mock('../context-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context-menu')>()
  return {
    ...actual,
    buildTerminalContextMenuTemplate: vi.fn(actual.buildTerminalContextMenuTemplate),
  }
})

import { executeAiTerminalResource } from './aiTerminalResources'
import { buildTerminalContextMenuTemplate } from '../context-menu'
import { forgetTerminalSelection, getTerminalSelection } from '../terminal-selection-cache'

interface FakeContents {
  id: number
  destroyed: boolean
  paste: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  destroy(): void
  asWebContents: WebContents
}

function fakeContents(id: number): FakeContents {
  let destroyed = false
  const destroyedListeners: Array<() => void> = []
  const paste = vi.fn()
  const once = vi.fn((event: string, listener: () => void) => {
    if (event === 'destroyed') destroyedListeners.push(listener)
  })
  const value = {
    id,
    get destroyed() { return destroyed },
    paste,
    once,
    isDestroyed: () => destroyed,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) listener()
    },
  }
  return { ...value, asWebContents: value as unknown as WebContents }
}

function click(label: string): void {
  const item = h.template?.find((entry) => entry.label === label)
  if (!item?.click) throw new Error(`menu item ${label} was not created`)
  ;(item.click as unknown as () => void)()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.saveClipboardImage.mockReset()
  h.saveClipboardImage.mockResolvedValue('/app/user-data/dropped-files/Pasted-Image.png')
  h.template = null
  h.popups = 0
  h.clipboardWrites.length = 0
  for (const id of [701, 702, 703, 704, 705]) forgetTerminalSelection(id)
})

describe('AI terminal native resources', () => {
  it('denies before writing, building a menu, or caching selection', async () => {
    const contents = fakeContents(701)
    const denied = () => false

    await expect(executeAiTerminalResource(
      'aiCli.saveClipboardImage',
      { bytes: [1, 2, 3], mediaType: 'image/png', path: '/caller/path', id: 'caller-id' },
      contents.asWebContents,
      denied,
    )).rejects.toThrow('Terminal resource request denied')
    await expect(executeAiTerminalResource(
      'aiCli.showTerminalContextMenu',
      { selection: 'secret' }, contents.asWebContents, denied,
    )).rejects.toThrow('Terminal resource request denied')
    await expect(executeAiTerminalResource(
      'aiCli.reportTerminalSelection',
      { selection: 'secret' }, contents.asWebContents, denied,
    )).rejects.toThrow('Terminal resource request denied')

    expect(h.saveClipboardImage).not.toHaveBeenCalled()
    expect(buildTerminalContextMenuTemplate).not.toHaveBeenCalled()
    expect(h.template).toBeNull()
    expect(getTerminalSelection(contents.id)).toBe('')
  })

  it('hands supported bytes to the existing store under app userData only', async () => {
    const contents = fakeContents(702)
    const result = await executeAiTerminalResource(
      'aiCli.saveClipboardImage',
      {
        bytes: [0, 128, 255], mediaType: 'image/webp',
        path: '/caller/must-not-be-used', id: 'caller-id-must-not-be-used',
      },
      contents.asWebContents,
      () => true,
    )

    expect(result).toEqual({ path: '/app/user-data/dropped-files/Pasted-Image.png' })
    expect(h.saveClipboardImage).toHaveBeenCalledOnce()
    const [bytes, mediaType, destination, ...extra] = h.saveClipboardImage.mock.calls[0]
    expect(bytes).toEqual(new Uint8Array([0, 128, 255]))
    expect(mediaType).toBe('image/webp')
    expect(destination).toBe(join('/app/user-data', 'dropped-files'))
    expect(extra).toEqual([])
    expect(destination).not.toContain('caller')
  })

  it('rechecks live dispatch when delayed menu items copy or paste', async () => {
    const contents = fakeContents(703)
    let allowed = true
    await executeAiTerminalResource(
      'aiCli.showTerminalContextMenu',
      { selection: 'selected terminal text' },
      contents.asWebContents,
      () => allowed,
    )
    expect(h.popups).toBe(1)
    expect(h.template?.map((item) => item.label)).toEqual(['Copy', 'Paste'])

    allowed = false
    click('Copy')
    click('Paste')

    expect(h.clipboardWrites).toEqual([])
    expect(contents.paste).not.toHaveBeenCalled()
  })

  it('cleans selection by the exact WebContents id when that contents is destroyed', async () => {
    const first = fakeContents(704)
    const second = fakeContents(705)

    await executeAiTerminalResource(
      'aiCli.reportTerminalSelection', { selection: 'first selection' }, first.asWebContents, () => true,
    )
    await executeAiTerminalResource(
      'aiCli.reportTerminalSelection', { selection: 'second selection' }, second.asWebContents, () => true,
    )
    expect(getTerminalSelection(first.id)).toBe('first selection')
    expect(getTerminalSelection(second.id)).toBe('second selection')

    first.destroy()
    expect(getTerminalSelection(first.id)).toBe('')
    expect(getTerminalSelection(second.id)).toBe('second selection')

    second.destroy()
    expect(getTerminalSelection(second.id)).toBe('')
  })
})
