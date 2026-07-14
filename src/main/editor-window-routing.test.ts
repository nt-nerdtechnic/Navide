import { describe, expect, it } from 'vitest'
import { routeEditorWindowOpen } from './editor-window-routing'

describe('routeEditorWindowOpen', () => {
  it('reuses the renderer for a file in the loaded workspace and preserves its payload', () => {
    const params = {
      workspace_path: '/workspace/app',
      filepath: 'src/main.ts',
      name: 'main.ts',
      line: '42',
    }

    expect(routeEditorWindowOpen('/workspace/app', params)).toEqual({
      kind: 'reuse',
      openFileParams: params,
      sidebar: null,
    })
  })

  it('reloads when a different workspace is requested', () => {
    expect(routeEditorWindowOpen('/workspace/one', {
      workspace_path: '/workspace/two',
      filepath: 'README.md',
    })).toEqual({ kind: 'reload', workspacePath: '/workspace/two' })
  })

  it('reuses the renderer when no workspace is supplied', () => {
    expect(routeEditorWindowOpen('/workspace/app', { filepath: 'README.md' })).toMatchObject({
      kind: 'reuse',
      openFileParams: { filepath: 'README.md' },
    })
  })

  it('keeps sidebar-only requests on the existing renderer', () => {
    expect(routeEditorWindowOpen('/workspace/app', {
      workspace_path: '/workspace/app',
      sidebar: 'search',
    })).toEqual({ kind: 'reuse', openFileParams: null, sidebar: 'search' })
  })
})
