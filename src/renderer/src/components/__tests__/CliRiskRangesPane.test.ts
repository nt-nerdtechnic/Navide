// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import CliRiskRangesPane from '../CliRiskRangesPane.vue'
import { looksLikeCidr, type SharedRange } from '../../lib/cliRisk'

const row = (over: Partial<SharedRange>): SharedRange => ({
  cidr: '162.158.0.0/15', label: 'Cloudflare', source: 'builtin', enabled: true, createdAt: 1, updatedAt: 1, ...over,
})

let wrapper: VueWrapper
let ranges: SharedRange[]
const send = vi.fn()

function render(): VueWrapper {
  wrapper = mount(CliRiskRangesPane, { props: { backend: { send } }, global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  ranges = [row({}), row({ cidr: '192.0.2.0/24', label: 'Mine', source: 'user' })]
  send.mockReset().mockImplementation(async (type: string, payload: Record<string, unknown>) => {
    if (type === 'cli_risk.ranges.update') ranges = ranges.map((r) => r.cidr === payload.cidr ? { ...r, enabled: payload.enabled as boolean } : r)
    if (type === 'cli_risk.ranges.delete') ranges = ranges.filter((r) => r.cidr !== payload.cidr)
    if (type === 'cli_risk.ranges.add') ranges = [...ranges, row({ cidr: payload.cidr as string, label: payload.label as string, source: 'user' })]
    return { ok: true, payload: { ranges }, error: null }
  })
})
afterEach(() => wrapper?.unmount())

describe('CliRiskRangesPane', () => {
  it('lists ranges with label, source and enabled; only user rows can be deleted', async () => {
    render()
    await flushPromises()
    expect(send).toHaveBeenCalledWith('cli_risk.ranges.list', {})
    const builtin = wrapper.get('[data-cidr="162.158.0.0/15"]')
    expect(builtin.text()).toContain('Cloudflare')
    expect(builtin.text()).toContain('Built-in')
    expect(builtin.find('.ranges-delete').exists()).toBe(false)
    expect((builtin.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(true)
    const user = wrapper.get('[data-cidr="192.0.2.0/24"]')
    expect(user.text()).toContain('Custom')
    await user.get('.ranges-delete').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith('cli_risk.ranges.delete', { cidr: '192.0.2.0/24' })
    expect(wrapper.find('[data-cidr="192.0.2.0/24"]').exists()).toBe(false)
  })

  it('toggles enabled and restores the box when the backend refuses', async () => {
    render()
    await flushPromises()
    const box = () => wrapper.get('[data-cidr="162.158.0.0/15"] input[type=checkbox]')
    await box().setValue(false)
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith('cli_risk.ranges.update', { cidr: '162.158.0.0/15', enabled: false })
    expect(wrapper.get('[data-cidr="162.158.0.0/15"]').classes()).toContain('off')
    send.mockResolvedValueOnce({ ok: false, error: { message: 'refused' } })
    await box().setValue(true)
    await flushPromises()
    expect((box().element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('[role=alert]').text()).toBe('refused')
  })

  it('validates CIDR and label before adding', async () => {
    render()
    await flushPromises()
    const [cidr, label] = wrapper.findAll('.ranges-add input')
    await cidr.setValue('198.51.100.0')
    await label.setValue('Example')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toContain('Invalid CIDR')
    await cidr.setValue('198.51.100.0/24')
    await label.setValue('  ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toBe('A label is required.')
    expect(send).not.toHaveBeenCalledWith('cli_risk.ranges.add', expect.anything())
    await label.setValue('Example')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith('cli_risk.ranges.add', { cidr: '198.51.100.0/24', label: 'Example' })
    expect(wrapper.find('[data-cidr="198.51.100.0/24"]').exists()).toBe(true)
    expect((cidr.element as HTMLInputElement).value).toBe('')
  })

  it.each([
    ['162.158.0.0/15', true], ['2606:4700::/32', true], ['::ffff:0:0/96', true],
    ['256.0.0.0/8', false], ['10.0.0.0/33', false], ['2001:db8::/129', false], ['10.0.0.0', false], ['cloudflare/8', false],
  ])('shape-checks %s', (value, ok) => {
    expect(looksLikeCidr(value)).toBe(ok)
  })
})
