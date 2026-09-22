// @vitest-environment happy-dom
// Picking English in Settings › Language once left the whole modal in Chinese
// while the English button showed its check mark: setLanguage() switched one
// i18n instance and the screen rendered through another. In dev that second
// instance came from Vite HMR re-running the i18n module after a locale file
// edit, so the module must hand back the instance the app installed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import { useSettings } from '../../composables/useSettings'

const Probe = defineComponent({
  template: `
    <div>
      <input :placeholder="$t('settings.search.placeholder')" />
      <span class="nav">{{ $t('settings.nav.general') }}|{{ $t('settings.nav.language') }}</span>
      <p class="hint">{{ $t('settings.appearance.language-hint') }}</p>
    </div>
  `,
})

describe('Settings › Language switch', () => {
  const originalLocale = i18n.global.locale.value
  afterEach(() => {
    useSettings().setLanguage(originalLocale, { broadcast: false })
  })

  it('re-renders what the app installed in the picked locale', async () => {
    const { setLanguage } = useSettings()
    setLanguage('zh-TW', { broadcast: false })
    const wrapper = mount(Probe, { global: { plugins: [i18n] } })
    expect(wrapper.find('.nav').text()).toBe('一般|語言')

    setLanguage('en-US', { broadcast: false })
    await nextTick()

    expect(wrapper.find('.nav').text()).toBe('General|Language')
    expect(wrapper.find('input').attributes('placeholder')).toBe('Search settings…')
    expect(wrapper.find('.hint').text()).not.toMatch(/[㐀-鿿]/)
  })

  it('keeps one i18n instance across HMR reloads of the locale module', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/index.ts'),
      'utf8',
    )
    expect(source).toContain('(hotData?.i18n as ReturnType<typeof createInstance> | undefined) ?? createInstance()')
    expect(source).toContain('hotData.i18n = i18n')
    expect(source).toContain('i18n.global.setLocaleMessage(locale, bundle)')
  })
})
