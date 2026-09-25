// @vitest-environment happy-dom
// Settings ▸ Voice Input ▸ Shortcut: the dictation key, editable in place. It
// must edit the very rules the Shortcuts tab edits (one store, two views), and
// refuse a ⌘ chord, whose key-up macOS never delivers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  getUserRules,
  keySpecToTokens,
  initKeybindingsPort,
  isKeyCaptureActive,
  setUserRules,
} from '@navide/plugin-ui/shared'
import { __resetSettingsForTest, _resetKeybindingsState } from '@navide/plugin-ui/shared/testing'
import VoiceSettingsSection from '../VoiceSettingsSection.vue'
import KeyboardShortcutsEditor from '../../KeyboardShortcutsEditor.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import { HOLD_TO_TALK_COMMAND, useVoiceSettings } from '../../../voice/voiceSettings'

const WHEN = 'paneStage && voiceInput && !modalOpen'

let write: ReturnType<typeof vi.fn>
const wrappers: VueWrapper[] = []

function mountSection(): VueWrapper {
  const mock = createMockBackend('connected')
  mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: 1 }, gpu: true })
  const w = mount(VoiceSettingsSection, { props: { backend: mock.backend }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

function mountEditor(): VueWrapper {
  const w = mount(KeyboardShortcutsEditor, {
    props: { initialQuery: HOLD_TO_TALK_COMMAND },
    attachTo: document.body,
    global: { plugins: [i18n] },
  })
  wrappers.push(w)
  return w
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

async function record(w: VueWrapper, init: KeyboardEventInit): Promise<void> {
  await w.get('[data-testid="voice-shortcut-change"]').trigger('click')
  press(init)
  await flushPromises()
  await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
  await flushPromises()
}

/** The caps a spec renders as, run together (glyphs differ per platform). */
function caps(spec: string): string {
  return keySpecToTokens(spec).flat().join('')
}

function shownKeys(w: VueWrapper): string {
  return w.get('[data-testid="voice-shortcut-keys"]').text().replace(/\s+/g, '')
}

beforeEach(() => {
  __resetSettingsForTest()
  _resetKeybindingsState()
  i18n.global.locale.value = 'en-US'
  write = vi.fn().mockResolvedValue({ ok: true })
  initKeybindingsPort({ read: async () => ({ ok: true, content: '[]' }), write: (c) => write(c), onChanged: () => () => {} })
  useVoiceSettings().setVoiceInputEnabled(true)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
  useVoiceSettings().setVoiceInputEnabled(false)
  initKeybindingsPort({})
  document.body.replaceChildren()
})

describe('Voice Input shortcut row', () => {
  it('shows the effective hold-to-talk binding', () => {
    const w = mountSection()
    expect(shownKeys(w)).toBe(caps('ctrl+alt+m'))
    expect(w.find('[data-testid="voice-shortcut-reset"]').exists()).toBe(false)
  })

  it('is hidden while voice input is off', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    const w = mountSection()
    await flushPromises()
    expect(w.find('[data-settings-section="voice-shortcut"]').exists()).toBe(false)
    expect(w.find('[data-testid="voice-shortcut-open"]').exists()).toBe(false)
  })

  it('records a new chord into the shared rules, and the Shortcuts tab shows it', async () => {
    const w = mountSection()
    const editor = mountEditor()
    await record(w, { key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true })

    expect(getUserRules()).toEqual([
      { key: 'ctrl+alt+m', command: `-${HOLD_TO_TALK_COMMAND}`, when: WHEN },
      { key: 'ctrl+shift+j', command: HOLD_TO_TALK_COMMAND, when: WHEN },
    ])
    expect(write).toHaveBeenCalledTimes(1)
    expect(isKeyCaptureActive()).toBe(false)
    expect(shownKeys(w)).toBe(caps('ctrl+shift+j'))

    const row = editor.findAll('tbody tr').find((r) => r.find('.kse-id').text() === HOLD_TO_TALK_COMMAND)!
    expect(row.find('.kse-chip-keys').text().replace(/\s+/g, '')).toBe(caps('ctrl+shift+j'))
  })

  it('follows a change made in the Shortcuts tab', async () => {
    const w = mountSection()
    setUserRules([
      { key: 'ctrl+alt+m', command: `-${HOLD_TO_TALK_COMMAND}`, when: WHEN },
      { key: 'ctrl+alt+k', command: HOLD_TO_TALK_COMMAND, when: WHEN },
    ])
    await flushPromises()
    expect(shownKeys(w)).toBe(caps('ctrl+alt+k'))
  })

  it('resets to the default', async () => {
    const w = mountSection()
    await record(w, { key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true })
    await w.get('[data-testid="voice-shortcut-reset"]').trigger('click')
    await flushPromises()
    expect(getUserRules()).toEqual([])
    expect(shownKeys(w)).toBe(caps('ctrl+alt+m'))
    expect(w.find('[data-testid="voice-shortcut-reset"]').exists()).toBe(false)
  })

  it('refuses a ⌘ chord and says why', async () => {
    const w = mountSection()
    await record(w, { key: 'm', code: 'KeyM', metaKey: true, altKey: true })
    expect(getUserRules()).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(shownKeys(w)).toBe(caps('ctrl+alt+m'))
    expect(w.get('[data-testid="voice-shortcut-warning"]').text()).toContain('cannot be used')
  })

  it('warns about a ⌘ binding that arrived another way', async () => {
    const w = mountSection()
    setUserRules([{ key: 'cmd+alt+m', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    await flushPromises()
    expect(w.get('[data-testid="voice-shortcut-warning"]').text()).toContain('uses ⌘')
  })

  it('records one key combination, not a two-step chord', async () => {
    const w = mountSection()
    await w.get('[data-testid="voice-shortcut-change"]').trigger('click')
    press({ key: 'k', code: 'KeyK', ctrlKey: true })
    press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true })
    await flushPromises()
    await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
    await flushPromises()
    expect(getUserRules().filter((r) => !r.command.startsWith('-'))).toEqual([
      { key: 'ctrl+alt+j', command: HOLD_TO_TALK_COMMAND, when: WHEN },
    ])
  })

  it('asks the settings page to open Shortcuts on this command', async () => {
    const w = mountSection()
    await w.get('[data-testid="voice-shortcut-open"]').trigger('click')
    expect(w.emitted('open-shortcuts')).toEqual([[HOLD_TO_TALK_COMMAND]])
  })
})
