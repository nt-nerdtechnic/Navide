// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EditorViewMonaco from '../EditorViewMonaco.vue'

// Shared holder so tests can reach the fake editor/model created by the mock.
const holder = vi.hoisted(() => ({
  editor: null as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    _fireContentChange: () => void
  },
  model: null as unknown as {
    _value: string
    getValue: ReturnType<typeof vi.fn>
    pushEditOperations: ReturnType<typeof vi.fn>
  },
  setModelMarkers: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../monacoWorkers', () => ({}))

vi.mock('monaco-editor', () => {
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }

  function createFakeModel(initial: string) {
    const model = {
      _value: initial,
      _onChange: () => {},
      getValue: vi.fn(() => model._value),
      getLineCount: () => model._value.split('\n').length,
      getLineLength: (n: number) => {
        const lines = model._value.split('\n')
        if (n < 1 || n > lines.length) throw new Error(`Illegal value for lineNumber: ${n}`)
        return lines[n - 1].length
      },
      getFullModelRange: () => {
        const lines = model._value.split('\n')
        return new Range(1, 1, lines.length, lines[lines.length - 1].length + 1)
      },
      pushEditOperations: vi.fn((
        _sel: unknown,
        edits: Array<{ range: Range; text: string }>,
      ) => {
        for (const e of edits) {
          const lines = model._value.split('\n')
          const off = (ln: number, col: number) =>
            lines.slice(0, ln - 1).reduce((n, l) => n + l.length + 1, 0) + (col - 1)
          model._value =
            model._value.slice(0, off(e.range.startLineNumber, e.range.startColumn)) +
            e.text +
            model._value.slice(off(e.range.endLineNumber, e.range.endColumn))
        }
        model._onChange()
      }),
    }
    return model
  }

  const setModelMarkers = vi.fn()
  holder.setModelMarkers = setModelMarkers

  function create(_el: HTMLElement, opts: { value?: string }) {
    const model = createFakeModel(opts.value ?? '')
    const contentListeners: Array<() => void> = []
    model._onChange = () => contentListeners.forEach((f) => f())
    const editor = {
      getModel: () => model,
      getValue: vi.fn(() => model._value),
      setValue: vi.fn((v: string) => { model._value = v; model._onChange() }),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      setPosition: vi.fn(),
      onDidChangeModelContent: (cb: () => void) => { contentListeners.push(cb); return { dispose() {} } },
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      addCommand: vi.fn(),
      createDecorationsCollection: () => ({ set: vi.fn() }),
      trigger: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
      updateOptions: vi.fn(),
      getOption: vi.fn(() => 13),
      _fireContentChange: () => model._onChange(),
    }
    holder.editor = editor as never
    holder.model = model as never
    return editor
  }

  const tsDefaults = () => ({
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  })

  return {
    Range,
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyF: 36, KeyS: 49, Slash: 90 },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: {
      create,
      defineTheme: vi.fn(),
      setModelMarkers,
      ShowLightbulbIconMode: { OnCode: 'onCode' },
      OverviewRulerLane: { Left: 1 },
      EditorOption: { fontSize: 52, lineNumbers: 67 },
    },
    languages: {
      registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
      typescript: {
        ScriptTarget: { ESNext: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        JsxEmit: { ReactJSX: 4 },
        typescriptDefaults: tsDefaults(),
        javascriptDefaults: tsDefaults(),
      },
    },
  }
})

function lastMarkers(): Array<{ startLineNumber: number; endLineNumber: number; endColumn: number }> {
  const calls = holder.setModelMarkers.mock.calls
  return calls[calls.length - 1][2]
}

beforeEach(() => {
  holder.setModelMarkers?.mockClear()
})

describe('EditorViewMonaco – diagnostics', () => {
  it('renders 1-based diagnostic lines without an off-by-one shift', async () => {
    const wrapper = mount(EditorViewMonaco, {
      props: {
        modelValue: 'a\nbb\nccc',
        diagnostics: [{ line: 1, col: 0, severity: 'error', message: 'boom' }],
      },
    })
    const markers = lastMarkers()
    expect(markers).toHaveLength(1)
    expect(markers[0].startLineNumber).toBe(1)
    expect(markers[0].endLineNumber).toBe(1)
    // endColumn = line length + 1 for line "a"
    expect(markers[0].endColumn).toBe(2)
    wrapper.unmount()
  })

  it('does not throw for an error on the last line and clamps out-of-range lines', async () => {
    const wrapper = mount(EditorViewMonaco, {
      props: {
        modelValue: 'a\nbb\nccc',
        diagnostics: [{ line: 3, col: 0, severity: 'error', message: 'last line' }],
      },
    })
    let markers = lastMarkers()
    expect(markers[0].startLineNumber).toBe(3)
    expect(markers[0].endColumn).toBe(4) // "ccc".length + 1

    // Stale diagnostic pointing past the document must be clamped, not throw.
    await wrapper.setProps({
      diagnostics: [{ line: 99, col: 0, severity: 'warning', message: 'stale' }],
    })
    markers = lastMarkers()
    expect(markers[0].startLineNumber).toBe(3)
    expect(markers[0].endLineNumber).toBe(3)
    wrapper.unmount()
  })
})

describe('EditorViewMonaco – external content updates', () => {
  it('applies external updates via pushEditOperations (undo preserved), not setValue', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'old text' } })
    await wrapper.setProps({ modelValue: 'new text' })
    expect(holder.model.pushEditOperations).toHaveBeenCalled()
    expect(holder.editor.setValue).not.toHaveBeenCalled()
    expect(holder.model._value).toBe('new text')
    wrapper.unmount()
  })

  it('skips re-serializing the document when the prop echoes the emitted value', async () => {
    const wrapper = mount(EditorViewMonaco, { props: { modelValue: 'abc' } })
    // Simulate the user typing: mutate the model then fire the change event.
    holder.model._value = 'abcd'
    holder.editor._fireContentChange()
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted?.[0]).toEqual(['abcd'])

    holder.model.getValue.mockClear()
    // Parent echoes the exact emitted string back as the prop.
    await wrapper.setProps({ modelValue: emitted![0][0] as string })
    await nextTick()
    // The watcher must bail on reference equality without a full getValue scan.
    expect(holder.model.getValue).not.toHaveBeenCalled()
    expect(holder.model.pushEditOperations).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
