import { mkdir } from 'node:fs/promises'
import type { NewWorkspaceResult } from '../shared/workspaceCreate'

/**
 * Create the folder the user named in the "New…" save dialog.
 *
 * `mkdir` runs without `recursive` on purpose: it then fails with EEXIST on a
 * taken name instead of succeeding silently, so a new workspace can never
 * start on top of a folder that already holds someone else's files. The user
 * picked the name, so a collision is reported back to them rather than worked
 * around — renaming is their call, not ours.
 */
export async function createWorkspaceFolder(dir: string): Promise<NewWorkspaceResult> {
  try {
    await mkdir(dir)
    return { ok: true, path: dir }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const detail = err instanceof Error ? err.message : String(err)
    if (code === 'EEXIST') return { ok: false, reason: 'exists', path: dir, detail }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
      return { ok: false, reason: 'denied', path: dir, detail }
    return { ok: false, reason: 'failed', path: dir, detail }
  }
}
