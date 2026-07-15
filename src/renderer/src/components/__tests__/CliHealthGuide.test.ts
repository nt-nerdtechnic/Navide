// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CliHealthGuide from '../CliHealthGuide.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { CliHealthStatus } from '../../composables/useOnboarding'

const health: CliHealthStatus = {
  entries: [{
    agent_key: 'claude',
    label: 'Claude Code',
    diagnostic_command: 'claude doctor',
    candidates: [
      {
        path: '/Users/test/.nvm/bin/claude',
        resolved_path: '/Users/test/.nvm/lib/claude.exe',
        aliases: ['/Users/test/.nvm/bin/claude'],
        version: '2.1.210',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 42,
        is_primary: true,
      },
      {
        path: '/opt/homebrew/bin/claude',
        resolved_path: '/opt/homebrew/lib/claude.exe',
        aliases: ['/opt/homebrew/bin/claude'],
        version: '2.1.168',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 100,
        is_primary: false,
      },
    ],
  }],
  findings: [{
    type: 'duplicate_install',
    agent_key: 'claude',
    label: 'Claude Code',
  }],
  fingerprint: '0123456789abcdef',
  dismissed: false,
  needs_attention: true,
}

describe('CliHealthGuide', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => wrapper?.unmount())

  it('shows the active and alternate binaries with exact versions and paths', () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    expect(wrapper.text()).toContain('2.1.210')
    expect(wrapper.text()).toContain('/Users/test/.nvm/bin/claude')
    expect(wrapper.text()).toContain('2.1.168')
    expect(wrapper.text()).toContain('/opt/homebrew/bin/claude')
  })

  it('persists the exact fingerprint when the user skips the guide', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-footer .ghost').trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: '0123456789abcdef' },
    })
    expect(wrapper.emitted('close')).toEqual([[]])
  })
})
