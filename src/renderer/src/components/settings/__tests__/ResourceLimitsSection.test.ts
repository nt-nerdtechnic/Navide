// @vitest-environment happy-dom
// Settings → General → Resource limits. Two promises are pinned here for every
// limit: its default is "what Navide did before" (nothing changes until the
// user turns it on), and changing it writes the key the backend reads.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'
import { settingsGet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

import ResourceLimitsSection from '../ResourceLimitsSection.vue'
import { TEST_MAX_WORKERS_KEY, _resetResourceLimitsForTest } from '../../../composables/useResourceLimits'

const here = dirname(fileURLToPath(import.meta.url))

function mountSection() {
  return mount(ResourceLimitsSection, { global: { plugins: [i18n] } })
}

describe('Resource limits — test-runner worker cap', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    _resetResourceLimitsForTest()
  })

  it('is off by default and writes nothing', () => {
    const w = mountSection()
    const toggle = w.get('[data-testid="limit-test-workers-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="limit-test-workers-value"]').exists()).toBe(false)
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 'unset')).toBe('unset')
  })

  it('turning it on stores a cap the backend reads, and the value is adjustable', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-test-workers-toggle"]').trigger('click')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(4)

    const input = w.get('[data-testid="limit-test-workers-value"]')
    await input.setValue('2')
    await input.trigger('change')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(2)
  })

  it('turning it back off stores 0, which the backend reads as off', async () => {
    const w = mountSection()
    const toggle = w.get('[data-testid="limit-test-workers-toggle"]')
    await toggle.trigger('click')
    await toggle.trigger('click')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, -1)).toBe(0)
  })

  it('ignores an out-of-range value instead of storing it', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-test-workers-toggle"]').trigger('click')
    const input = w.get('[data-testid="limit-test-workers-value"]')
    await input.setValue('500')
    await input.trigger('change')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(4)
  })
})

describe('Resource limits — placement', () => {
  it('sits in Settings → General', () => {
    const modal = readFileSync(resolve(here, '../../SettingsModal.vue'), 'utf8')
    const general = modal.slice(modal.indexOf(`v-show="activeTab === 'general'"`), modal.indexOf(`v-show="activeTab === 'appearance'"`))
    expect(general).toContain('<ResourceLimitsSection')
  })

  it.each(['en-US', 'zh-TW', 'ja-JP'] as const)('has its strings in %s', (locale) => {
    for (const key of [
      'settings.section.resource-limits',
      'settings.limits.hint',
      'settings.limits.test-workers',
      'settings.limits.test-workers-hint',
      'settings.limits.test-workers-value',
    ]) {
      expect(i18n.global.te(key, locale), `${locale}: ${key}`).toBe(true)
    }
  })
})
