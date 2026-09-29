import { describe, expect, it } from 'vitest'
import { splitEditorTarget } from '../editorTargetPath'

describe('splitEditorTarget', () => {
  const roots = ['/ws', '/real/ws']
  it('keeps a relative path as is', () => {
    expect(splitEditorTarget('src/a.ts', roots)).toEqual({ filepath: 'src/a.ts' })
  })
  it('turns an absolute path inside the workspace into a relative one', () => {
    expect(splitEditorTarget('/ws/src/a.ts', roots)).toEqual({ filepath: 'src/a.ts' })
  })
  it('recognises the canonical spelling of the workspace', () => {
    expect(splitEditorTarget('/real/ws/src/a.ts', roots)).toEqual({ filepath: 'src/a.ts' })
  })
  it('does not treat a sibling that merely shares the prefix as inside', () => {
    expect(splitEditorTarget('/ws-other/a.ts', roots)).toEqual({ filepath: 'a.ts', wsPath: '/ws-other' })
  })
  it('addresses an outside file by its own directory', () => {
    expect(splitEditorTarget('/etc/hosts', roots)).toEqual({ filepath: 'hosts', wsPath: '/etc' })
    expect(splitEditorTarget('/hosts', roots)).toEqual({ filepath: 'hosts', wsPath: '/' })
  })
})
