/** Internal Host-to-owner messages. Never exposed as a Plugin capability. */
export type TerminalStorageOwnerRequest =
  | { operation: 'read'; resumeKey: string }
  | { operation: 'session'; resumeKey: string; ptyId: string | null }
  | { operation: 'snapshot'; resumeKey: string; snapshots: string[] }
  | { operation: 'release'; resumeKey: string }
  | { operation: 'font'; fontSize: number }
  | { operation: 'size'; cols: number; rows: number }

export interface TerminalStorageOwnerState {
  fontSize: number
  lastSize: { cols: number; rows: number } | null
  ptyId: string | null
  snapshot: string | null
}

export function editorTerminalResumeKey(workspacePath: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < workspacePath.length; index++) {
    hash ^= workspacePath.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-editor-ai-terminal`
}

export function validTerminalOwnerRequest(value: unknown): value is TerminalStorageOwnerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  const fields: Record<string, string[]> = {
    read: ['operation', 'resumeKey'], session: ['operation', 'resumeKey', 'ptyId'],
    snapshot: ['operation', 'resumeKey', 'snapshots'], release: ['operation', 'resumeKey'],
    font: ['operation', 'fontSize'], size: ['operation', 'cols', 'rows'],
  }
  const keys = Object.hasOwn(fields, String(request.operation)) ? fields[String(request.operation)] : undefined
  if (!keys || Object.keys(request).some(key => !keys.includes(key))) return false
  if (request.operation === 'font') return typeof request.fontSize === 'number' && Number.isFinite(request.fontSize) && request.fontSize > 0
  if (request.operation === 'size') return [request.cols, request.rows].every(item => typeof item === 'number' && Number.isInteger(item) && item > 0)
  if (typeof request.resumeKey !== 'string' || !/^(?:[0-9a-f]{8}-editor-ai-terminal|plugin-[0-9a-f]{64}-ai-terminal)$/.test(request.resumeKey)) return false
  if (request.operation === 'session') return request.ptyId === null || typeof request.ptyId === 'string'
  if (request.operation === 'snapshot') return Array.isArray(request.snapshots) && request.snapshots.every(item => typeof item === 'string')
  return request.operation === 'read' || request.operation === 'release'
}
