import type { useBackend } from '../composables/useBackend'

/**
 * Load an image file as a base64 `data:` URL via the backend `fs.read_image`
 * channel. Used wherever the UI shows an image preview (editor, source-control
 * diff). A raw `file://` <img> src is blocked by webSecurity from the dev http
 * origin; a data URL is origin-independent, so this works in dev and prod alike.
 * Returns '' on any failure so callers can fall back to a placeholder.
 */
export async function loadImageDataUrl(
  backend: ReturnType<typeof useBackend>,
  workspacePath: string,
  relPath: string,
): Promise<string> {
  try {
    const resp = await backend.send<{ ok: boolean; data_url?: string }>('fs.read_image', {
      workspace_path: workspacePath,
      rel_path: relPath,
    })
    return resp.ok && resp.payload?.ok ? (resp.payload.data_url ?? '') : ''
  } catch {
    return ''
  }
}
