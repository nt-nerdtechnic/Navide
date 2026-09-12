// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface PickerItem {
  abs: string
  name: string
  dir: string
}

interface PickerOptions {
  query(query: string): Promise<PickerItem[]>
  onPick(item: PickerItem, lineNum: number | undefined, event: MouseEvent | KeyboardEvent): void
  onClose?(reason: 'cancel' | 'select'): void
}

const pickerState = vi.hoisted(() => {
  let options: PickerOptions | undefined
  let readyListener: ((init: { invocationId: string; query: string; theme: string; homePath: string }) => void) | undefined
  const open = vi.fn()
  const close = vi.fn()
  const create = vi.fn((next: PickerOptions) => {
    options = next
    return { active: false, open, close }
  })
  const bridge = {
    ready: vi.fn((listener: typeof readyListener) => { readyListener = listener }),
    search: vi.fn(async () => [] as Array<{ id: string; label: string; path: string }>),
    select: vi.fn(),
    cancel: vi.fn(),
  }
  return {
    bridge,
    create,
    open,
    close,
    get options() { return options },
    fireReady(init: { invocationId: string; query: string; theme: string; homePath: string }) { readyListener?.(init) },
  }
})

vi.mock('@navide/plugin-ui/file-picker', () => ({
  createTerminalFilePicker: pickerState.create,
}))

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  pickerState.bridge.ready.mockClear()
  pickerState.bridge.search.mockReset()
  pickerState.bridge.search.mockResolvedValue([])
  pickerState.bridge.select.mockClear()
  pickerState.bridge.cancel.mockClear()
  pickerState.create.mockClear()
  pickerState.open.mockClear()
  pickerState.close.mockClear()
  Object.assign(window, { navideFilePicker: pickerState.bridge })
})

async function bootPicker() {
  await import('./filePicker')
  pickerState.fireReady({ invocationId: 'invocation-1', query: 'README', theme: 'dark-github', homePath: '/Users/test' })
  return pickerState.options
}

describe('isolated file-picker renderer', () => {
  it('keeps the bootstrap import boundary limited to the picker bridge and shared types', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/platform/file-picker/filePicker.ts'), 'utf8')
    const imports = [...source.matchAll(/(?:from|import)\s*[('\"]([^('\"]+)[('\"]\)?/g)].map(match => match[1])

    expect(imports).toEqual(['@navide/plugin-ui/file-picker', '../../../../shared/filePicker'])
    expect(imports.some(specifier => /(?:^|\/)(?:HostApp|IDE|terminal|backend)(?:\/|$)/i.test(specifier))).toBe(false)
  })

  it('searches with only the invocation and query, and selects by row ID', async () => {
    const options = await bootPicker()
    expect(options).toBeDefined()
    expect(pickerState.open).toHaveBeenCalledWith({ initialQuery: 'README' })

    pickerState.bridge.search.mockResolvedValueOnce([{ id: 'row-7', label: 'display label', path: '/workspace/src/report.ts' }])
    const rows = await options!.query('report')

    expect(pickerState.bridge.search).toHaveBeenCalledOnce()
    expect(pickerState.bridge.search).toHaveBeenCalledWith('invocation-1', 'report')
    expect(rows).toEqual([{ abs: 'row-7', name: 'report.ts', dir: '/workspace/src' }])

    options!.onPick(rows[0]!, undefined, { isTrusted: true } as MouseEvent)
    expect(pickerState.bridge.select).toHaveBeenCalledOnce()
    expect(pickerState.bridge.select).toHaveBeenCalledWith('invocation-1', 'row-7')
    expect(pickerState.bridge.select).not.toHaveBeenCalledWith('invocation-1', '/workspace/src/report.ts')
  })

  it('cancels synthetic picks and close events without sending a row selection', async () => {
    const options = await bootPicker()
    expect(options).toBeDefined()

    options!.onPick({ abs: 'row-forged', name: 'report.ts', dir: '/workspace/src' }, 12, { isTrusted: false } as MouseEvent)
    expect(pickerState.bridge.select).not.toHaveBeenCalled()
    expect(pickerState.bridge.cancel).toHaveBeenCalledWith('invocation-1')

    options!.onClose?.('cancel')
    expect(pickerState.bridge.cancel).toHaveBeenCalledTimes(2)
    expect(pickerState.bridge.cancel).toHaveBeenLastCalledWith('invocation-1')
  })
})
