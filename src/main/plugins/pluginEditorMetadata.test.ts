import { describe, expect, it } from 'vitest'
import { publicCapabilityEntry } from './pluginCapabilityCatalog'

describe('public editor capability metadata', () => {
  it('accepts optional encoding metadata for reads', () => {
    const entry = publicCapabilityEntry('fs.readFile')
    expect(entry?.validateRequest?.({ path: 'src/main.ts' })).toBe(true)
    expect(entry?.validateRequest?.({ path: 'src/main.ts', encoding: 'utf-16le' })).toBe(true)
  })

  it('accepts write encoding and optimistic expected mtime', () => {
    const entry = publicCapabilityEntry('fs.writeFile')
    expect(entry?.validateRequest?.({ path: 'src/main.ts', content: 'x' })).toBe(true)
    expect(entry?.validateRequest?.({
      path: 'src/main.ts', content: 'x', encoding: 'utf-8', expectedMtime: 1726000000.25,
    })).toBe(true)
  })

  it('accepts fixed file picker fields and rejects caller identity or geometry', () => {
    const picker = publicCapabilityEntry('ui.openFilePicker')?.validateRequest
    expect(picker?.({ query: 'readme', candidates: ['README.md'], line: 4 })).toBe(true)
    expect(picker?.({
      query: 'readme', candidates: ['README.md'], sessionId: 'session-1',
    })).toBe(true)
    expect(picker?.({
      query: 'readme', candidates: ['README.md'], workspacePath: '/workspace',
    })).toBe(false)
    expect(picker?.({
      query: 'readme', candidates: ['README.md'], instanceId: 'instance-1',
    })).toBe(false)
    expect(picker?.({
      query: 'readme', candidates: ['README.md'], anchor: { x: 0, y: 0, width: 1, height: 1 },
    })).toBe(false)
  })

  it('retains content-only compatibility and rejects malformed metadata', () => {
    const read = publicCapabilityEntry('fs.readFile')?.validateRequest
    const write = publicCapabilityEntry('fs.writeFile')?.validateRequest
    expect(read?.({ path: 'README.md' })).toBe(true)
    expect(write?.({ path: 'README.md', content: 'updated' })).toBe(true)
    expect(read?.({ path: 'README.md', encoding: 42 })).toBe(false)
    expect(write?.({ path: 'README.md', content: 'x', expectedMtime: Infinity })).toBe(false)
    expect(write?.({ path: 'README.md', content: 'x', authority: 'backend' })).toBe(false)
    expect(read?.({ path: 'README.md', initiator: { kind: 'user', id: 'spoofed' } })).toBe(false)
  })

  it('fails closed for unknown or missing capability entries', () => {
    expect(publicCapabilityEntry('fs.readFile.unknown')).toBeNull()
    expect(publicCapabilityEntry('editor.readFile')).toBeNull()
  })
})
