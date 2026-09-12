import type { ReactiveValue } from '../shared/ports/value'

export interface EditorFile { workspacePath: string; relPath: string }
export interface EditorReadRequest extends EditorFile { encoding?: string }
export interface EditorReadResult {
  ok: boolean
  content?: string
  error?: string
  encoding?: string
  bom?: boolean
  mtime?: number
  is_binary?: boolean
  is_image?: boolean
  size?: number
  ext?: string
}
export interface EditorWriteRequest extends EditorFile {
  content: string
  encoding?: string
  expectedMtime?: number
}
export interface EditorWriteResult { ok: boolean; error?: string; mtime?: number; conflict?: boolean }
export interface EditorAiResult { ok: boolean; text?: string; error?: string }
export interface EditorRewriteRequest { code: string; instruction: string; language: string; model: string }
export interface EditorCompleteRequest { prefix: string; suffix: string; language: string; model: string }
export interface EditorDiagnostic {
  line: number
  col: number
  endLine?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
}

/** Consumer-owned effects. Implementations authenticate requests at their own
 * boundary; file coordinates never grant access to a workspace. */
export interface EditorPort {
  readonly status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  readonly lastError: ReactiveValue<string>
  restart(): Promise<void>
  readFile(file: EditorReadRequest): Promise<EditorReadResult>
  writeFile(file: EditorWriteRequest): Promise<EditorWriteResult>
  readImage(file: EditorFile): Promise<string>
  rewrite(request: EditorRewriteRequest): Promise<EditorAiResult>
  complete(request: EditorCompleteRequest): Promise<EditorAiResult>
  onFilesChanged(listener: (workspacePath: string) => void): () => void
  diagnostics(file: EditorFile): EditorDiagnostic[]
}

/** A candidate renders the same UI without acquiring a production adapter. */
export function createPreflightEditorPort(): EditorPort {
  const denied = async () => ({ ok: false, error: 'Editor operations are unavailable during preflight' })
  return {
    status: { value: 'connected' }, lastError: { value: '' },
    restart: async () => {}, readFile: denied, writeFile: denied,
    readImage: async () => '', rewrite: denied, complete: denied,
    onFilesChanged: () => () => {}, diagnostics: () => [],
  }
}
