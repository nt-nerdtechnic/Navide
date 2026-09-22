// The result of "New…" on the Welcome screen, shared by the three sides that
// have to agree on it: main creates the folder, preload forwards the outcome,
// and the renderer turns a failure into a message the user can act on.
//
// It is a result object rather than `string | null` because the folder name is
// now the user's to choose, so a name can collide or land somewhere unwritable
// — outcomes that used to be impossible when main picked the name itself.
//
// DOM-free and Electron-free on purpose — this file is compiled on both sides.

/** Why no workspace folder was created. `canceled` is not an error. */
export type NewWorkspaceFailure = 'canceled' | 'exists' | 'denied' | 'failed'

export type NewWorkspaceResult =
  | { ok: true; path: string }
  | { ok: false; reason: NewWorkspaceFailure; path?: string; detail?: string }

/**
 * Message to show for a failure. `canceled` is absent: the user closed the
 * dialog themselves and needs no explanation.
 */
export const NEW_WORKSPACE_ERROR_KEYS: Record<
  Exclude<NewWorkspaceFailure, 'canceled'>,
  string
> = {
  exists: 'error.workspace-create-exists',
  denied: 'error.workspace-create-denied',
  failed: 'error.workspace-create-failed'
}
