interface Selection { path: string; grant: string }
const files = new Map<string, string>()
const directories = new Map<string, string>()

/** Coordinates are display data only. The Host validates every opaque grant. */
export function targetPath(root: string, path: string): string {
  const value = path.startsWith('/') ? path : `${root}/${path}`
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function rememberSelection(selection: Selection, kind: 'file' | 'directory'): void {
  ;(kind === 'file' ? files : directories).set(targetPath('', selection.path), selection.grant)
}
export function fileGrant(path: string): string | undefined { return files.get(targetPath('', path)) }
export function directoryGrant(path: string): string | undefined { return directories.get(targetPath('', path)) }

const query = new URLSearchParams(window.location.search)
if (query.get('file_grant') && query.get('filepath')) {
  rememberSelection({
    path: targetPath(query.get('file_ws') ?? query.get('workspace_path') ?? '', query.get('filepath')!),
    grant: query.get('file_grant')!,
  }, 'file')
}

export function rememberOpenTarget(target: Record<string, string>): void {
  if (target.file_grant && target.filepath) {
    rememberSelection({ path: targetPath(target.file_ws ?? target.workspace_path ?? '', target.filepath), grant: target.file_grant }, 'file')
  }
}
