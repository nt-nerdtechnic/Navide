import { ISSUE_CAPABILITY_OPERATIONS } from '../../../packages/plugin-contracts/src/issues'
import { isWorkspaceContainedPath, resolvePathForContainment } from './workspacePathPolicy'
import { resolve } from 'node:path'

export const PUBLIC_ISSUE_METHODS = Object.keys(ISSUE_CAPABILITY_OPERATIONS)
const operationFields: Record<string, Record<string, string>> = {
  provider: {}, list: { limit: 'number?' }, get: { number: 'number' },
  create: { title: 'string', body: 'string?' }, comment: { number: 'number', body: 'string' },
  set_state: { number: 'number', state: 'string' },
}

export function validateIssueRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!Object.hasOwn(ISSUE_CAPABILITY_OPERATIONS, address) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  const operation = ISSUE_CAPABILITY_OPERATIONS[address as keyof typeof ISSUE_CAPABILITY_OPERATIONS]
  const fields = { repositoryPath: 'string?', ...operationFields[operation] }
  return Object.keys(args).every(key => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, type]) => args[key] === undefined && type.endsWith('?') ||
      typeof args[key] === type.replace('?', '')) &&
    (args.number === undefined || Number.isInteger(args.number) && Number(args.number) >= 0) &&
    (args.limit === undefined || Number.isInteger(args.limit)) &&
    (operation !== 'set_state' || args.state === 'open' || args.state === 'closed')
}

export function issueRequest(address: string, args: Record<string, unknown>, workspacePath: string) {
  if (!validateIssueRequest(address, args)) throw new Error('invalid Issue capability request')
  const { repositoryPath = '.', ...arguments_ } = args
  if (!isWorkspaceContainedPath(workspacePath, String(repositoryPath))) throw new Error('repository escapes Host workspace')
  const root = resolvePathForContainment(resolve(workspacePath, String(repositoryPath)))
  if (!root) throw new Error('repository cannot be safely resolved')
  return {
    operation: ISSUE_CAPABILITY_OPERATIONS[address as keyof typeof ISSUE_CAPABILITY_OPERATIONS],
    workspace_path: root,
    arguments: arguments_,
  }
}
