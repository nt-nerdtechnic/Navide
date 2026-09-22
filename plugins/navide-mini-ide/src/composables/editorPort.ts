import type { EditorPort, EditorReadResult, EditorWriteResult, EditorAiResult } from '@navide/plugin-ui/editor'
import type { useBackend } from './useBackend'
import { diagnosticsKey, diagnosticsStore } from '../editor/diagnostics'

export function createMiniIdeEditorPort(backend: ReturnType<typeof useBackend>): EditorPort {
  async function invoke<T extends { ok: boolean; error?: string }>(type: string, payload: Record<string, unknown>): Promise<T> {
    const response = await backend.send<T>(type, payload)
    return response.ok && response.payload
      ? response.payload
      : { ok: false, error: response.error?.message || 'Editor operation failed' } as T
  }
  return {
    status: backend.status,
    lastError: backend.lastError,
    restart: backend.restart,
    readFile: ({ workspacePath, relPath, encoding }) => invoke<EditorReadResult>('fs.read_file', {
      workspace_path: workspacePath, rel_path: relPath,
      ...(encoding === undefined ? {} : { encoding_override: encoding }),
    }),
    writeFile: ({ workspacePath, relPath, content, encoding, expectedMtime }) => invoke<EditorWriteResult>('fs.write_file', {
      workspace_path: workspacePath, rel_path: relPath, content,
      ...(encoding === undefined ? {} : { encoding }),
      ...(expectedMtime === undefined ? {} : { expected_mtime: expectedMtime }),
    }),
    async readImage({ workspacePath, relPath }) {
      const result = await invoke<{ ok: boolean; data_url?: string }>('fs.read_image', {
        workspace_path: workspacePath, rel_path: relPath,
      })
      return result.ok ? result.data_url ?? '' : ''
    },
    rewrite: request => invoke<EditorAiResult>('editor.rewrite', { ...request }),
    complete: request => invoke<EditorAiResult>('editor.complete', { ...request }),
    onFilesChanged: listener => backend.on('workspace.changed', payload => {
      const workspacePath = (payload as { workspace_path?: unknown } | null)?.workspace_path
      if (typeof workspacePath === 'string') listener(workspacePath)
    }),
    diagnostics: ({ workspacePath, relPath }) => diagnosticsStore.value.get(diagnosticsKey(workspacePath, relPath)) ?? [],
  }
}
