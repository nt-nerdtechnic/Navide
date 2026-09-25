import { describe, expect, it } from 'vitest'
import { selectPluginArtifact } from './pluginTarget'

const row = (target: string) => ({ version: '1.2.0', target })

describe('selectPluginArtifact', () => {
  it('picks the exact Host target among platform artifacts', () => {
    const rows = [row('darwin-arm64'), row('win32-x64'), row('linux-x64')]
    expect(selectPluginArtifact(rows, 'win32-x64')).toBe(rows[1])
  })

  it('falls back to the universal artifact', () => {
    const rows = [row('universal')]
    expect(selectPluginArtifact(rows, 'linux-arm64')).toBe(rows[0])
  })

  it('prefers the exact target over universal', () => {
    const rows = [row('universal'), row('darwin-arm64')]
    expect(selectPluginArtifact(rows, 'darwin-arm64')).toBe(rows[1])
  })

  it('names the version, Host target and available targets when none fits', () => {
    expect(() => selectPluginArtifact([row('darwin-arm64'), row('darwin-x64')], 'win32-arm64')).toThrow(
      "version 1.2.0 has no artifact for host target 'win32-arm64' (available: darwin-arm64, darwin-x64)"
    )
  })

  it('does not treat a same-platform, other-architecture build as a match', () => {
    expect(() => selectPluginArtifact([row('darwin-x64')], 'darwin-arm64')).toThrow(/no artifact/)
  })
})
