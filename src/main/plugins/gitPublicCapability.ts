import { GIT_CAPABILITY_METHODS, GIT_OPERATION_FIELDS, type GitCapabilityMethod, type GitOperation } from '../../../packages/plugin-contracts/src/gitCapabilities'
import { isWorkspaceContainedPath, resolvePathForContainment } from './workspacePathPolicy'
import { resolve } from 'node:path'

export const PUBLIC_GIT_METHODS = Object.keys(GIT_CAPABILITY_METHODS) as GitCapabilityMethod[]

export function validatePublicGitRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!Object.hasOwn(GIT_CAPABILITY_METHODS, address) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const operation = GIT_CAPABILITY_METHODS[address as GitCapabilityMethod]
  const fields: Record<string, string> = { ...GIT_OPERATION_FIELDS[operation], repositoryPath: 'string' }
  return Object.entries(value).every(([key, field]) => {
    if (!Object.hasOwn(fields, key)) return false
    if (field === undefined) return true
    const type = fields[key]
    return type === 'strings' ? Array.isArray(field) && field.every(item => typeof item === 'string')
      : typeof field === type && (type !== 'number' || Number.isFinite(field))
  })
}

export function publicGitRequest(address: string, args: Record<string, unknown>, workspacePath: string): {
  operation: GitOperation
  type: string
  payload: Record<string, unknown>
  timeoutMs: number
} {
  if (!validatePublicGitRequest(address, args)) throw new Error('invalid Git capability request')
  const operation = GIT_CAPABILITY_METHODS[address as GitCapabilityMethod]
  const { repositoryPath = '.', selectionGrant: _selectionGrant, ...payload } = args
  if (!isWorkspaceContainedPath(workspacePath, String(repositoryPath))) throw new Error('repository escapes the Host workspace binding')
  const root = resolvePathForContainment(resolve(workspacePath, String(repositoryPath)))
  if (!root) throw new Error('repository cannot be safely resolved')
  payload.workspace_path = root
  const remote = ['fetch', 'pull', 'push', 'push_force', 'push_upstream', 'sync', 'pull_rebase', 'clone']
  return {
    operation,
    type: `git.${operation}`,
    payload,
    timeoutMs: operation === 'generate_message' ? 75_000 : remote.includes(operation) ? 65_000
      : operation === 'connect_to_remote' ? 60_000 : 20_000,
  }
}
