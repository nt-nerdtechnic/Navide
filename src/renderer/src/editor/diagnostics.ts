import { ref } from 'vue'

export interface Diagnostic {
  relPath: string
  line: number
  col: number
  endLine?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
}

export const diagnosticsStore = ref<Map<string, Diagnostic[]>>(new Map())

export function setDiagnostics(relPath: string, diags: Diagnostic[]): void {
  const m = new Map(diagnosticsStore.value)
  m.set(relPath, diags)
  diagnosticsStore.value = m
}

export function clearDiagnostics(relPath: string): void {
  const m = new Map(diagnosticsStore.value)
  m.delete(relPath)
  diagnosticsStore.value = m
}

export function allDiagnosticsSorted(): Diagnostic[] {
  const all: Diagnostic[] = []
  for (const diags of diagnosticsStore.value.values()) {
    all.push(...diags)
  }
  return all.sort((a, b) => {
    if (a.relPath !== b.relPath) return a.relPath.localeCompare(b.relPath)
    return a.line - b.line
  })
}
