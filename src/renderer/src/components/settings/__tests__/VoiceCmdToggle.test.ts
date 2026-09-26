// @vitest-environment happy-dom
// Settings ▸ Voice Input ▸ Shortcut in toggle mode: a ⌘ chord is allowed there
// (the second press is a keydown, no keyup needed) but refused in hold modes,
// refused when Navide or macOS already uses it — with free keys offered
// instead — and a ⌘ binding left behind by a mode switch is flagged, never
// changed silently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { buildRows, getUserRules, initKeybindingsPort, isKeyCaptureActive, keySpecToTokens, setUserRules } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest, _resetKeybindingsState } from '@navide/plugin-ui/shared/testing'
import VoiceSettingsSection from '../VoiceSettingsSection.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import { HOLD_TO_TALK_COMMAND, useVoiceSettings, type VoiceRecordingMode } from '../../../voice/voiceSettings'
import { holdToTalkKeyProblem, reservedChordAction } from '../../../voice/holdToTalkKey'

const WHEN = 'paneStage && voiceInput && !modalOpen'
const FREE_OPEN_PLANS = { key: 'cmd+shift+d', command: '-workbench.action.openPlans' }
const CMD_SHIFT_D: KeyboardEventInit = { key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }

let write: ReturnType<typeof vi.fn>
const wrappers: VueWrapper[] = []

function mountSection(): VueWrapper {
  const mock = createMockBackend('connected')
  mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: 1 }, gpu: true })
  const w = mount(VoiceSettingsSection, { props: { backend: mock.backend }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function record(w: VueWrapper, keys: Array<['keydown' | 'keyup', KeyboardEventInit]>): Promise<void> {
  await w.get('[data-testid="voice-shortcut-change"]').trigger('click')
  for (const [type, init] of keys) key(type, init)
  await flushPromises()
  await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
  await flushPromises()
}

const caps = (spec: string) => keySpecToTokens(spec).flat().join('')
const shownKeys = (w: VueWrapper) => w.get('[data-testid="voice-shortcut-keys"]').text().replace(/\s+/g, '')
const voiceRules = () => getUserRules().filter((r) => r.command === HOLD_TO_TALK_COMMAND)
const warning = (w: VueWrapper) => w.get('[data-testid="voice-shortcut-warning"]').text()
const suggestions = (w: VueWrapper) => w.findAll('[data-testid="voice-shortcut-suggestions"] button').map((b) => b.attributes('data-suggest')!)
/** Every key some command is bound to right now. */
const boundKeys = () => new Set(buildRows(getUserRules()).flatMap((r) => r.keys.map((k) => k.key)))

function setMode(mode: VoiceRecordingMode): void {
  useVoiceSettings().setVoiceRecordingMode(mode)
}

beforeEach(() => {
  __resetSettingsForTest()
  _resetKeybindingsState()
  i18n.global.locale.value = 'en-US'
  write = vi.fn().mockResolvedValue({ ok: true })
  initKeybindingsPort({ read: async () => ({ ok: true, content: '[]' }), write: (c) => write(c), onChanged: () => () => {} })
  useVoiceSettings().setVoiceInputEnabled(true)
  setMode('toggle')
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
  setMode('hold-tap')
  useVoiceSettings().setVoiceInputEnabled(false)
  initKeybindingsPort({})
  document.body.replaceChildren()
})

describe('⌘ dictation shortcut', () => {
  it('refuses ⌘⇧D while Open Plans has it, naming Open Plans', async () => {
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    expect(voiceRules()).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(shownKeys(w)).toBe(caps('ctrl+alt+m'))
    expect(warning(w)).toContain('Open Plans')
  })

  it('accepts ⌘⇧D in toggle mode once Open Plans is unbound', async () => {
    setUserRules([FREE_OPEN_PLANS])
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    expect(voiceRules()).toEqual([{ key: 'cmd+shift+d', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(shownKeys(w)).toBe(caps('cmd+shift+d'))
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(false)
  })

  it.each(['hold', 'hold-tap'] as const)('refuses ⌘⇧D in %s mode even when it is free', async (mode) => {
    setMode(mode)
    setUserRules([FREE_OPEN_PLANS])
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    expect(voiceRules()).toEqual([])
    expect(warning(w)).toContain('cannot be used in this recording mode')
  })

  it('refuses ⌘Q, naming what macOS does with it', async () => {
    const w = mountSection()
    await record(w, [['keydown', { key: 'q', code: 'KeyQ', metaKey: true }]])
    expect(voiceRules()).toEqual([])
    expect(warning(w)).toContain('macOS uses it to quit the app')
  })

  it('offers free keys valid in the mode after a collision, and one click saves one', async () => {
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    const offered = suggestions(w)
    expect(offered.length).toBeGreaterThanOrEqual(2)
    expect(offered.length).toBeLessThanOrEqual(3)
    const taken = boundKeys()
    for (const s of offered) {
      expect(taken.has(s), s).toBe(false)
      expect(reservedChordAction(s), s).toBeNull()
      expect(holdToTalkKeyProblem(s, 'toggle'), s).toBeNull()
    }

    await w.get(`[data-suggest="${offered[0]}"]`).trigger('click')
    await flushPromises()
    expect(voiceRules()).toEqual([{ key: offered[0], command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(write).toHaveBeenCalledTimes(1)
    expect(shownKeys(w)).toBe(caps(offered[0]))
    expect(w.find('[data-testid="voice-shortcut-suggestions"]').exists()).toBe(false)
  })

  it.each(['hold', 'hold-tap'] as const)('offers only keys without ⌘ after a refusal in %s mode', async (mode) => {
    setMode(mode)
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    const offered = suggestions(w)
    expect(offered.length).toBeGreaterThan(0)
    const taken = boundKeys()
    for (const s of offered) {
      expect(s, s).not.toContain('cmd')
      expect(taken.has(s), s).toBe(false)
      expect(holdToTalkKeyProblem(s, mode), s).toBeNull()
    }
  })

  it('drops the offers when the recording mode changes', async () => {
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    expect(suggestions(w).length).toBeGreaterThan(0)
    setMode('hold')
    await flushPromises()
    expect(suggestions(w)).toEqual([])
  })
})

describe('switching the recording mode away from toggle', () => {
  async function boundCmdShiftD(): Promise<VueWrapper> {
    setUserRules([FREE_OPEN_PLANS])
    const w = mountSection()
    await record(w, [['keydown', CMD_SHIFT_D]])
    expect(voiceRules()).toHaveLength(1)
    return w
  }

  it.each(['hold', 'hold-tap'] as const)('warns and keeps the ⌘ binding when switched to %s', async (mode) => {
    const w = await boundCmdShiftD()
    const before = getUserRules()
    setMode(mode)
    await flushPromises()
    expect(warning(w)).toContain('uses ⌘')
    expect(w.find('[data-testid="voice-shortcut-warning-reset"]').exists()).toBe(true)
    expect(w.find('[data-testid="voice-shortcut-warning-rebind"]').exists()).toBe(true)
    expect(getUserRules()).toEqual(before)
    expect(shownKeys(w)).toBe(caps('cmd+shift+d'))
  })

  it('resets to the default from the warning', async () => {
    const w = await boundCmdShiftD()
    setMode('hold')
    await flushPromises()
    await w.get('[data-testid="voice-shortcut-warning-reset"]').trigger('click')
    await flushPromises()
    expect(voiceRules()).toEqual([])
    expect(shownKeys(w)).toBe(caps('ctrl+alt+m'))
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(false)
  })

  it('starts recording a new key from the warning', async () => {
    const w = await boundCmdShiftD()
    setMode('hold-tap')
    await flushPromises()
    await w.get('[data-testid="voice-shortcut-warning-rebind"]').trigger('click')
    expect(isKeyCaptureActive()).toBe(true)
    key('keydown', { key: 'F13', code: 'F13' })
    await flushPromises()
    await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
    await flushPromises()
    expect(voiceRules()).toEqual([{ key: 'f13', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
  })

  it('clears the warning when switched back to toggle', async () => {
    const w = await boundCmdShiftD()
    setMode('hold')
    await flushPromises()
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(true)
    setMode('toggle')
    await flushPromises()
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(false)
  })
})
