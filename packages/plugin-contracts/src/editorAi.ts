export interface EditorAiParams {
  'aiCli.getEditorProfile': Record<string, never>
  'aiCli.setEditorProfile': { profileId: string }
  'aiCli.rewrite': { code: string; instruction: string; language: string; model: string }
  'aiCli.complete': { prefix: string; suffix: string; language: string; model: string }
  'aiCli.reviewStart': { mode: 'working' | 'branch'; base?: string; compare?: string }
  'aiCli.reviewStop': { reviewId: string }
  'aiCli.getModelPreferences': Record<string, never>
  'aiCli.setModelPreferences': { provider: string; model: string }
  'aiCli.listModels': Record<string, never>
}

export interface EditorAiResults {
  'aiCli.getEditorProfile': { profileId: string | null }
  'aiCli.setEditorProfile': { ok: boolean }
  'aiCli.rewrite': { ok: boolean; text?: string; error?: string }
  'aiCli.complete': { ok: boolean; text?: string; error?: string }
  'aiCli.reviewStart': { reviewId: string }
  'aiCli.reviewStop': { ok: boolean }
  /** Compatibility snapshot: empty fields mean the current backend does not
   * retain provider/model preferences. No provider credentials are returned. */
  'aiCli.getModelPreferences': { provider: string; model: string }
  'aiCli.setModelPreferences': { provider: string; model: string }
  'aiCli.listModels': { ok: boolean; models?: Array<{ name: string }>; error?: string }
}

export interface EditorReviewResult {
  summary: string
  findings: Array<{
    id: string
    file: string
    line: number | null
    severity: 'critical' | 'warning' | 'suggestion'
    title: string
    body: string
  }>
  verdict: 'approve' | 'approve_with_comments' | 'request_changes'
}

export interface EditorAiEvents {
  'aiCli.reviewResult': { reviewId: string; result: EditorReviewResult }
  'aiCli.reviewEnd': { reviewId: string }
  'aiCli.reviewError': { reviewId: string; message: string }
}
