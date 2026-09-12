import { describe, expect, it } from 'vitest'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

const entry = PUBLIC_CAPABILITY_CATALOG['ui.openExternal']
const policy = manifestV2CapabilityPolicy({ system: ['ui'] })
const binding = {
  pluginId: 'acme.links',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'external',
}

function call(url: string) {
  return {
    pluginId: binding.pluginId,
    ns: 'ui',
    method: 'openExternal',
    args: { url },
    reqId: 'web-link-1',
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    publisherEligible: false,
    userGrant: { packageVersion: binding.packageVersion, system: ['ui'] as const },
    runtimeBinding: binding,
    ...overrides,
  }
}

describe('public web link capability catalog', () => {
  it('keeps external links in the plugin-scoped UI catalog', () => {
    expect(entry).toMatchObject({
      address: 'ui.openExternal',
      kind: 'method',
      namespace: 'ui',
      scope: 'plugin',
      eligibility: 'public',
    })
  })

  it.each(['http://example.com', 'https://example.com/path?q=1', 'HTTPS://EXAMPLE.COM'])(
    'accepts %s',
    (url) => {
      expect(entry?.validateRequest?.({ url })).toBe(true)
    },
  )

  it.each([
    'file:///Users/example/secret.txt',
    'javascript:alert(1)',
    'custom://example.test/path',
    'mailto:user@example.com',
    'https://',
    '',
  ])('rejects non-web or malformed URL %s', (url) => {
    expect(entry?.validateRequest?.({ url })).toBe(false)
  })

  it('keeps the existing broker grant gate around valid web links', () => {
    expect(planPublicCapabilityCall(call('https://example.com'), policy, context())).toMatchObject({
      kind: 'allow',
      plan: { address: 'ui.openExternal', scope: 'plugin', runtime: binding },
    })
    expect(planPublicCapabilityCall(call('https://example.com'), policy, context({ userGrant: null }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
    expect(planPublicCapabilityCall(call('javascript:alert(1)'), policy, context())).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'INVALID_ARGUMENT' } },
    })
  })
})
