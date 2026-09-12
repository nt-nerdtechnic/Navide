import { describe, expect, it } from 'vitest'
import { aiTerminalStorageIdentity } from './aiTerminalStorage'

describe('AI terminal storage identity', () => {
  it('keeps the same plugin, contribution and workspace on one stable identity', () => {
    const binding = {
      pluginId: 'acme.editor',
      contributionKey: 'acme.editor.window',
      workspacePath: '/workspace/project',
    }

    const first = aiTerminalStorageIdentity(binding)
    const second = aiTerminalStorageIdentity({ ...binding })

    expect(second).toEqual(first)
    expect(first.origin).toBe('host')
    expect(first.resumeKey).toMatch(/^plugin-[0-9a-f]{64}-ai-terminal$/)
  })

  it('isolates different callers and workspaces', () => {
    const base = {
      pluginId: 'acme.editor',
      contributionKey: 'acme.editor.window',
      workspacePath: '/workspace/project',
    }
    const differentPlugin = aiTerminalStorageIdentity({ ...base, pluginId: 'other.editor' })
    const differentContribution = aiTerminalStorageIdentity({ ...base, contributionKey: 'acme.editor.panel' })
    const differentWorkspace = aiTerminalStorageIdentity({ ...base, workspacePath: '/workspace/other' })

    expect(new Set([
      aiTerminalStorageIdentity(base).resumeKey,
      differentPlugin.resumeKey,
      differentContribution.resumeKey,
      differentWorkspace.resumeKey,
    ])).toHaveLength(4)
    expect(differentPlugin.origin).toBe('host')
    expect(differentContribution.origin).toBe('host')
    expect(differentWorkspace.origin).toBe('host')
  })

  it('retains the exact legacy FNV workspace key for the migrated Mini-IDE window', () => {
    expect(aiTerminalStorageIdentity({
      pluginId: 'navide.mini-ide',
      contributionKey: 'navide.mini-ide.window',
      workspacePath: '/workspace',
    })).toEqual({
      origin: 'legacy-mini-ide',
      resumeKey: 'c1a2c0ef-editor-ai-terminal',
    })
  })

  it('uses the Host mapping for a non-window Mini-IDE contribution', () => {
    const identity = aiTerminalStorageIdentity({
      pluginId: 'navide.mini-ide',
      contributionKey: 'navide.mini-ide.panel',
      workspacePath: '/workspace',
    })

    expect(identity.origin).toBe('host')
    expect(identity.resumeKey).toMatch(/^plugin-[0-9a-f]{64}-ai-terminal$/)
  })
})
