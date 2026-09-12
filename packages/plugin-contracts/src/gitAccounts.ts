export interface GitAccountSummary {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountParams {
  'ui.listGitAccounts': Record<string, never>
  'ui.getGitAccountBinding': Record<string, never>
  'ui.addGitAccount': { label: string; host: string; username: string; token: string }
  'ui.bindGitAccount': { accountId: string }
  'ui.unbindGitAccount': Record<string, never>
}

export interface GitAccountResults {
  'ui.listGitAccounts': { available: boolean; accounts: GitAccountSummary[] }
  'ui.getGitAccountBinding': { accountId: string | null }
  'ui.addGitAccount': { account: GitAccountSummary }
  'ui.bindGitAccount': { accountId: string }
  'ui.unbindGitAccount': { accountId: null }
}

export interface GitCredentialEvents {
  'shell.gitCredentialRequested': { requestId: string; host: string; prompt: string }
  'shell.gitCredentialCancelled': { requestId: string }
}
