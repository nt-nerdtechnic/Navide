// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PromptSkillIcon from '../PromptSkillIcon.vue'
import { PROMPT_SKILL_ICONS } from '../../lib/promptSkills'

// The icon renders one of two things and the call sites never know which: a
// builtin line-art glyph, or the single character a user typed.

describe('PromptSkillIcon – builtin names', () => {
  it('draws every name in PROMPT_SKILL_ICONS', () => {
    // The name list and the path table are two lists that must stay in step;
    // a name added to one and not the other would render an empty box, which
    // no other test would notice.
    for (const name of PROMPT_SKILL_ICONS) {
      const w = mount(PromptSkillIcon, { props: { name } })
      const path = w.find('svg path')
      expect(path.exists(), `${name} has no path`).toBe(true)
      expect((path.attributes('d') ?? '').length, `${name} has an empty path`).toBeGreaterThan(8)
      w.unmount()
    }
  })

  it('has no duplicate names', () => {
    expect(new Set(PROMPT_SKILL_ICONS).size).toBe(PROMPT_SKILL_ICONS.length)
  })

  it('keeps the two circle-backed glyphs', () => {
    expect(mount(PromptSkillIcon, { props: { name: 'green' } }).find('circle').exists()).toBe(true)
    expect(mount(PromptSkillIcon, { props: { name: 'scan' } }).find('circle').exists()).toBe(true)
    expect(mount(PromptSkillIcon, { props: { name: 'rocket' } }).find('circle').exists()).toBe(false)
  })
})

describe('PromptSkillIcon – custom characters', () => {
  it('renders a custom glyph as text, not as an empty svg', () => {
    const w = mount(PromptSkillIcon, { props: { name: '🚀' } })
    expect(w.find('svg').exists()).toBe(false)
    expect(w.find('.ps-glyph').text()).toBe('🚀')
  })

  it('renders a multi-codepoint emoji whole', () => {
    const w = mount(PromptSkillIcon, { props: { name: '👩‍💻' } })
    expect(w.find('.ps-glyph').text()).toBe('👩‍💻')
  })
})
