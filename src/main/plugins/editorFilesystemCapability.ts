import { isWorkspaceContainedPath, workspaceMutationPathError } from './workspacePathPolicy'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Fixed public addresses, never a caller-selected backend method. */
export const EDITOR_FILESYSTEM_METHODS = [
  'fs.previewResource', 'fs.listArchive', 'fs.convertOffice',
  'fs.createFile', 'fs.createDirectory', 'fs.rename', 'fs.delete',
  'fs.findInFiles', 'fs.replaceInFiles',
] as const

export function validateEditorFilesystemRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  let keys: string[]
  if (address === 'fs.findInFiles' || address === 'fs.replaceInFiles') {
    keys = ['query', 'isRegex', 'caseSensitive', 'wholeWord']
    if (typeof value.query !== 'string') return false
    if (['isRegex', 'caseSensitive', 'wholeWord'].some(key =>
      value[key] !== undefined && typeof value[key] !== 'boolean')) return false
    if (address === 'fs.findInFiles') {
      keys.push('includes', 'excludes')
      if (['includes', 'excludes'].some(key =>
        value[key] !== undefined && typeof value[key] !== 'string')) return false
    } else {
      keys.push('replacement', 'files')
      if (typeof value.replacement !== 'string' || !Array.isArray(value.files) ||
        !value.files.every(text)) return false
    }
  } else {
    if (!text(value.path)) return false
    keys = ['path']
    if (['fs.previewResource', 'fs.listArchive', 'fs.convertOffice'].includes(address)) {
      keys.push('selectionGrant')
      if (value.selectionGrant !== undefined && !text(value.selectionGrant)) return false
    }
    if (address === 'fs.createFile') {
      keys.push('content')
      if (value.content !== undefined && typeof value.content !== 'string') return false
    } else if (address === 'fs.rename') {
      keys.push('destination')
      if (!text(value.destination)) return false
    } else if (!['fs.createDirectory', 'fs.delete', 'fs.previewResource', 'fs.listArchive', 'fs.convertOffice'].includes(address)) return false
  }
  return Object.keys(value).every(key => keys.includes(key))
}

/** The caller supplies only the Host-authenticated workspace. Every mutation
 * target, including both rename endpoints and each replacement file, keeps
 * the existing workspace and Git metadata protection. */
export function editorFilesystemRequest(
  address: string,
  args: Record<string, unknown>,
  workspacePath: string,
): { type: string; payload: Record<string, unknown> } | null {
  if (!(EDITOR_FILESYSTEM_METHODS as readonly string[]).includes(address)) return null
  if (!validateEditorFilesystemRequest(address, args)) throw new Error('invalid filesystem request')
  if (['fs.previewResource', 'fs.listArchive', 'fs.convertOffice'].includes(address)) {
    if (!isWorkspaceContainedPath(workspacePath, args.path as string)) {
      throw new Error('path escapes the Host workspace binding')
    }
    return {
      type: address === 'fs.previewResource' ? 'fs.page_capability'
        : address === 'fs.listArchive' ? 'fs.list_archive' : 'fs.convert_office',
      payload: { workspace_path: workspacePath, rel_path: args.path },
    }
  }
  const paths = address === 'fs.findInFiles' ? []
    : address === 'fs.replaceInFiles' ? args.files as string[]
      : address === 'fs.rename' ? [args.path, args.destination] : [args.path]
  for (const path of paths) {
    const error = workspaceMutationPathError(workspacePath, path)
    if (error) throw new Error(error)
  }
  const payload: Record<string, unknown> = { workspace_path: workspacePath }
  switch (address) {
    case 'fs.createFile':
      return { type: 'fs.create_file', payload: { ...payload, rel_path: args.path, content: args.content ?? '' } }
    case 'fs.createDirectory':
      return { type: 'fs.mkdir', payload: { ...payload, rel_path: args.path } }
    case 'fs.rename':
      return { type: 'fs.rename', payload: { ...payload, src_path: args.path, dst_path: args.destination } }
    case 'fs.delete':
      return { type: 'fs.delete', payload: { ...payload, rel_path: args.path } }
    default:
      Object.assign(payload, {
        query: args.query, is_regex: args.isRegex ?? false,
        case_sensitive: args.caseSensitive ?? false, whole_word: args.wholeWord ?? false,
      })
      return address === 'fs.findInFiles'
        ? { type: 'search.find_in_files', payload: { ...payload, includes: args.includes ?? '', excludes: args.excludes ?? '' } }
        : { type: 'search.replace_in_files', payload: { ...payload, replacement: args.replacement, files: args.files } }
  }
}

/** Reuse the backend's workspace-scoped preview capability. Strip every part
 * of the private socket URL except its origin; the backend authentication
 * token must never become part of a Plugin resource URL. The page endpoint
 * preserves relative HTML resources, sandbox headers and byte ranges. */
export function editorPreviewResourceUrl(
  backendWsUrl: string,
  result: unknown,
  path: string,
): string {
  if (!record(result) || result.ok !== true || !text(result.cap) || !text(result.ws_b64)) {
    throw new Error('preview resource is unavailable')
  }
  const socket = new URL(backendWsUrl)
  const origin = `${socket.protocol === 'wss:' ? 'https:' : 'http:'}//${socket.host}`
  return `${origin}/fs/page/${encodeURIComponent(result.cap)}/${encodeURIComponent(result.ws_b64)}/${path.split('/').map(encodeURIComponent).join('/')}`
}
