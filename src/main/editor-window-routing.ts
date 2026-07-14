export type EditorWindowRoute =
  | { kind: 'reload'; workspacePath: string }
  | {
      kind: 'reuse'
      openFileParams: Record<string, string> | null
      sidebar: string | null
    }

export function routeEditorWindowOpen(
  loadedWorkspacePath: string,
  params: Record<string, string>
): EditorWindowRoute {
  const requestedWorkspacePath = (params.workspace_path ?? '').trim()
  if (requestedWorkspacePath && requestedWorkspacePath !== loadedWorkspacePath) {
    return { kind: 'reload', workspacePath: requestedWorkspacePath }
  }

  return {
    kind: 'reuse',
    openFileParams: params.filepath ? params : null,
    sidebar: params.sidebar || null,
  }
}
