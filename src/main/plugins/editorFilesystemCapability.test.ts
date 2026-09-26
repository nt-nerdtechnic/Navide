import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { editorFilesystemRequest, editorPreviewResourceUrl, EDITOR_FILESYSTEM_METHODS, validateEditorFilesystemRequest } from './editorFilesystemCapability'

describe('public editor filesystem capability', () => {
  it('exposes fixed addresses and rejects authority fields', () => {
    expect(EDITOR_FILESYSTEM_METHODS).toEqual(expect.arrayContaining(['fs.rename', 'fs.findInFiles', 'fs.replaceInFiles']))
    expect(validateEditorFilesystemRequest('fs.rename', { path: 'a', destination: 'b' })).toBe(true)
    expect(validateEditorFilesystemRequest('fs.rename', { path: 'a', destination: 'b', workspace_path: '/tmp' })).toBe(false)
    expect(validateEditorFilesystemRequest('fs.rename', { path: 'a', destination: 'b', initiator: {} })).toBe(false)
    expect(editorFilesystemRequest('fs.nope', { path: 'a' }, '/tmp')).toBeNull()
  })

  it('maps both rename endpoints and protects traversal and metadata paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'navide-editor-fs-'))
    try {
      expect(editorFilesystemRequest('fs.rename', { path: 'a.txt', destination: 'b.txt' }, workspace)).toEqual({
        type: 'fs.rename', payload: { workspace_path: workspace, src_path: 'a.txt', dst_path: 'b.txt' },
      })
      for (const args of [
        { path: '../escape', destination: 'b' }, { path: 'a', destination: '../escape' },
        { path: '.git/config', destination: 'b' }, { path: 'a', destination: '.git/config' },
      ]) expect(() => editorFilesystemRequest('fs.rename', args, workspace)).toThrow()
      expect(() => editorFilesystemRequest('fs.delete', { path: '../escape' }, workspace)).toThrow()
      const outside = mkdtempSync(join(tmpdir(), 'navide-editor-fs-outside-'))
      try {
        symlinkSync(outside, join(workspace, 'linked'))
        expect(() => editorFilesystemRequest('fs.delete', { path: 'linked/file.txt' }, workspace)).toThrow()
      } finally { rmSync(outside, { recursive: true, force: true }) }
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })

  it('preserves search and replacement arguments exactly', () => {
    const workspace = '/workspace'
    expect(editorFilesystemRequest('fs.findInFiles', {
      query: 'needle', isRegex: true, caseSensitive: true, wholeWord: false, includes: '**/*.ts', excludes: '**/node_modules/**',
    }, workspace)).toEqual({ type: 'search.find_in_files', payload: {
      workspace_path: workspace, query: 'needle', is_regex: true, case_sensitive: true, whole_word: false,
      includes: '**/*.ts', excludes: '**/node_modules/**',
    } })
    expect(editorFilesystemRequest('fs.replaceInFiles', {
      query: 'x', replacement: 'y\n', files: ['src/a.ts', 'src/b.ts'], isRegex: false, caseSensitive: true, wholeWord: true,
    }, workspace)).toEqual({ type: 'search.replace_in_files', payload: {
      workspace_path: workspace, query: 'x', replacement: 'y\n', files: ['src/a.ts', 'src/b.ts'],
      is_regex: false, case_sensitive: true, whole_word: true,
    } })
    expect(() => editorFilesystemRequest('fs.replaceInFiles', { query: 'x', replacement: 'y', files: ['../escape'] }, workspace)).toThrow()
  })

  it('maps preview resources without exposing backend credentials', () => {
    const workspace = '/workspace'
    expect(editorFilesystemRequest('fs.listArchive', { path: 'bundle.zip' }, workspace)).toEqual({
      type: 'fs.list_archive', payload: { workspace_path: workspace, rel_path: 'bundle.zip' },
    })
    expect(editorFilesystemRequest('fs.convertOffice', { path: 'report.docx' }, workspace)).toEqual({
      type: 'fs.convert_office', payload: { workspace_path: workspace, rel_path: 'report.docx' },
    })
    expect(editorFilesystemRequest('fs.previewResource', { path: 'dir/page 例.html' }, workspace)).toEqual({
      type: 'fs.page_capability', payload: { workspace_path: workspace, rel_path: 'dir/page 例.html' },
    })
    const url = editorPreviewResourceUrl('wss://user:secret@example.test:8787/ws?token=private', {
      ok: true, cap: 'cap value', ws_b64: 'L3dvcmtzcGFjZQ',
    }, 'dir/page 例.html')
    expect(url).toBe('https://example.test:8787/fs/page/cap%20value/L3dvcmtzcGFjZQ/dir/page%20%E4%BE%8B.html')
    expect(url).not.toContain('secret')
    expect(url).not.toContain('token')
    expect(() => editorPreviewResourceUrl('ws://example.test/ws', { ok: false }, 'x')).toThrow()
  })
})
