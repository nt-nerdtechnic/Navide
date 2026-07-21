import { describe, it, expect, vi } from 'vitest'

// The manager imports electron for its view lifecycle; the registry logic under
// test touches none of it, so a minimal stub lets the module load under Vitest's
// node environment.
vi.mock('electron', () => ({
  WebContentsView: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  app: {},
}))

import {
  FrontendPluginManager,
  isReservedPluginId,
  type PluginLaunchDescriptor,
} from './frontendPluginManager'

function descriptor(id: string): PluginLaunchDescriptor {
  return { id, requires: [], devUrl: '', entryFile: `/plugins/${id}/index.html` }
}

describe('isReservedPluginId', () => {
  it('flags the built-in navide.* namespace, not third-party ids', () => {
    expect(isReservedPluginId('navide.mini-ide')).toBe(true)
    expect(isReservedPluginId('navide.noop')).toBe(true)
    expect(isReservedPluginId('acme.demo')).toBe(false)
  })
})

describe('registerDescriptor reserved-id guard', () => {
  it('refuses a third-party plugin claiming a reserved built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(descriptor('navide.mini-ide'))).toThrow(/reserved/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('allows the host itself to register a built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('registers an ordinary third-party descriptor', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(descriptor('acme.demo'))
    expect(mgr.getDescriptor('acme.demo')?.id).toBe('acme.demo')
  })
})
