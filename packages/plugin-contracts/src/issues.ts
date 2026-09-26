export const ISSUE_CAPABILITY_OPERATIONS = {
  'shell.issueProvider': 'provider',
  'shell.listIssues': 'list',
  'shell.getIssue': 'get',
  'shell.createIssue': 'create',
  'shell.commentIssue': 'comment',
  'shell.setIssueState': 'set_state',
} as const

export interface IssueParams {
  'shell.issueProvider': { repositoryPath?: string }
  'shell.listIssues': { repositoryPath?: string; limit?: number }
  'shell.getIssue': { repositoryPath?: string; number: number }
  'shell.createIssue': { repositoryPath?: string; title: string; body?: string }
  'shell.commentIssue': { repositoryPath?: string; number: number; body: string }
  'shell.setIssueState': { repositoryPath?: string; number: number; state: 'open' | 'closed' }
}

export interface IssueSummary {
  number: number
  title: string
  state: string
  author: string
  labels: string[]
  assignees: string[]
  updated_at: string
  url: string
}
export interface IssueDetail extends IssueSummary {
  body: string
  created_at: string
  comments: Array<{ author: string; body: string; created_at: string }>
}
export interface IssueResults {
  'shell.issueProvider': { ok: boolean; provider: string; host: string; cli_available: boolean; authenticated: boolean; error?: string }
  'shell.listIssues': { ok: boolean; provider: string; issues: IssueSummary[]; error?: string }
  'shell.getIssue': { ok: boolean; issue?: IssueDetail; error?: string }
  'shell.createIssue': { ok: boolean; url?: string; error?: string }
  'shell.commentIssue': { ok: boolean; error?: string }
  'shell.setIssueState': { ok: boolean; error?: string }
}
