export const GIT_ACCOUNT_PUBLIC_METHODS = {
  'ui.listGitAccounts': 'list',
  'ui.getGitAccountBinding': 'get_binding',
  'ui.addGitAccount': 'add',
  'ui.bindGitAccount': 'bind',
  'ui.unbindGitAccount': 'unbind',
} as const

export function validateGitAccountRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!Object.hasOwn(GIT_ACCOUNT_PUBLIC_METHODS, address) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = address === 'ui.addGitAccount' ? ['label', 'host', 'username', 'token']
    : address === 'ui.bindGitAccount' ? ['accountId'] : []
  const args = value as Record<string, unknown>
  return Object.keys(args).every(key => fields.includes(key)) &&
    fields.every(key => typeof args[key] === 'string' && args[key].length > 0)
}
