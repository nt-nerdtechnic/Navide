export interface FileSearchOptions {
  query: string
  isRegex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

export interface EditorFilesystemParams {
  'fs.previewResource': { path: string; selectionGrant?: string }
  'fs.listArchive': { path: string; selectionGrant?: string }
  'fs.convertOffice': { path: string; selectionGrant?: string }
  'fs.createFile': { path: string; content?: string }
  'fs.createDirectory': { path: string }
  'fs.rename': { path: string; destination: string }
  'fs.delete': { path: string }
  'fs.findInFiles': FileSearchOptions & { includes?: string; excludes?: string }
  'fs.replaceInFiles': FileSearchOptions & { replacement: string; files: string[] }
}

export interface FileMutationResult { ok: boolean; error?: string }
export interface EditorFilesystemResults {
  'fs.previewResource': { url: string }
  'fs.listArchive': {
    ok: boolean
    error?: string
    entries?: Array<{ name: string; size: number; is_dir: boolean }>
    total_entries?: number
    truncated?: boolean
  }
  'fs.convertOffice': {
    ok: boolean
    error?: string
    kind?: 'docx' | 'xlsx'
    html?: string
    sheets?: Array<{ name: string; rows: string[][]; truncated?: boolean }>
  }
  'fs.createFile': FileMutationResult
  'fs.createDirectory': FileMutationResult
  'fs.rename': FileMutationResult
  'fs.delete': FileMutationResult
  'fs.findInFiles': {
    ok: boolean
    error?: string
    results?: Array<{
      rel_path: string
      name: string
      matches: Array<{ line: number; col: number; end: number; text: string }>
    }>
    total?: number
    truncated?: boolean
  }
  'fs.replaceInFiles': {
    ok: boolean
    error?: string
    changed?: Array<{ rel_path: string; count: number }>
    total?: number
  }
}
