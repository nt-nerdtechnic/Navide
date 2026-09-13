// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

// The Settings → Prompts half of custom icons. normalizeCustomIcon itself is
// covered in lib/__tests__/promptSkills.test.ts; what only a mount can show is
// the WIRING — that typing an emoji reaches the store, that an unusable entry
// puts the field back instead of blanking the icon, and that picking a builtin
// clears the field again.

const store: Record<string, unknown> = {}
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  settingsSet: (key: string, value: unknown) => {
    store[key] = value
  },
  onSettingsChanged: () => {},
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import PromptSkillsPane from '../PromptSkillsPane.vue'
import { PROMPT_SKILLS_SETTING_KEY, type PromptSkill } from '../../lib/promptSkills'
import { reloadPromptSkills } from '../../composables/usePromptSkills'

function seed(icon: string): void {
  const skill: PromptSkill = {
    id: 'a',
    name: 'skill a',
    icon,
    description: '',
    prompt: 'do the thing',
    resumePrompt: '',
    maxTurns: 0,
    category: 'dev',
    enabled: true,
    isDefault: true,
  }
  store[PROMPT_SKILLS_SETTING_KEY] = [skill]
  reloadPromptSkills()
}

function storedIcon(): string {
  return (store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[])[0].icon
}

/** Mount and open the drawer on the only skill. */
async function openDrawer(): Promise<VueWrapper> {
  const w = mount(PromptSkillsPane)
  await w.find('.prompt-card').trigger('click')
  expect(w.find('.prompts-drawer').exists()).toBe(true)
  return w
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
})

describe('Settings → Prompts – custom icon field', () => {
  it('stores the emoji the user typed', async () => {
    seed('advance')
    const w = await openDrawer()

    const field = w.find('.icon-custom')
    expect((field.element as HTMLInputElement).value).toBe('')
    await field.setValue('🚀')
    await field.trigger('change')

    expect(storedIcon()).toBe('🚀')
    // And the drawer title now shows it rather than an empty svg box.
    expect(w.find('.drawer-title .ps-glyph').text()).toBe('🚀')
  })

  it('keeps only the first character of a multi-emoji paste', async () => {
    seed('advance')
    const w = await openDrawer()
    const field = w.find('.icon-custom')
    await field.setValue('🚀🎉')
    await field.trigger('change')

    expect(storedIcon()).toBe('🚀')
    expect((field.element as HTMLInputElement).value).toBe('🚀')
  })

  it('restores the field instead of blanking the icon when nothing usable is typed', async () => {
    seed('🚀')
    const w = await openDrawer()
    const field = w.find('.icon-custom')
    expect((field.element as HTMLInputElement).value).toBe('🚀')

    await field.setValue('   ')
    await field.trigger('change')

    expect(storedIcon()).toBe('🚀')
    expect((field.element as HTMLInputElement).value).toBe('🚀')
  })

  it('clears the field when a builtin swatch is picked', async () => {
    seed('🚀')
    const w = await openDrawer()
    expect((w.find('.icon-custom').element as HTMLInputElement).value).toBe('🚀')

    // The first swatch is the first builtin name.
    await w.findAll('button.icon-btn')[0].trigger('click')

    expect(storedIcon()).toBe('advance')
    expect((w.find('.icon-custom').element as HTMLInputElement).value).toBe('')
  })
})
