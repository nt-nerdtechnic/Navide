import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_CAPABILITY_METHODS, gitCapabilityMethod, type GitOperation } from '../../../packages/plugin-contracts/src/gitCapabilities'
import { HOST_GIT_REQUEST_TYPES } from '../../shared/gitCompatibility'
import {
  PUBLIC_GIT_METHODS,
  publicGitRequest,
  validatePublicGitRequest,
} from './gitPublicCapability'
import {
  planPublicCapabilityCall,
  type CapabilityCall,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import type { ExecutionPolicySnapshot } from './executionPolicy'

const workspaces: string[] = []

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'navide-git-capability-'))
  workspaces.push(path)
  return path
}

afterEach(() => {
  // The temporary directories are intentionally left for the OS to clean up;
  // no repository or user path is ever removed by this test.
  workspaces.length = 0
})

const binding = {
  pluginId: 'example.git-plugin',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'git-pane',
} as const

const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const

function executionPolicy(shell: string[]): ExecutionPolicySnapshot {
  return {
    policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell },
    revision: 7,
    state: 'user',
  }
}

function context(overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext {
  return {
    publisherEligible: true,
    userGrant: { packageVersion: binding.packageVersion, system: [], shell: 'allowlist' },
    runtimeBinding: binding,
    initiator: agent,
    executionPolicy: executionPolicy(['git']),
    ...overrides,
  }
}

function call(overrides: Partial<CapabilityCall> = {}): CapabilityCall {
  return {
    pluginId: binding.pluginId,
    ns: 'shell',
    method: 'gitStatus',
    args: { repositoryPath: '.' },
    reqId: 'git-request-1',
    ...overrides,
  }
}

describe('public Git capability inventory and Host mapping', () => {
  it('maps every legacy transport request to exactly one public operation', () => {
    const root = workspace()
    const addresses = HOST_GIT_REQUEST_TYPES.map((requestType) => {
      expect(requestType.startsWith('git.')).toBe(true)
      const operation = requestType.slice('git.'.length) as GitOperation
      const address = gitCapabilityMethod(operation)
      expect(Object.entries(GIT_CAPABILITY_METHODS).filter(([, candidate]) => candidate === operation)).toHaveLength(1)
      expect(PUBLIC_GIT_METHODS.filter((candidate) => candidate === address)).toHaveLength(1)

      const plan = publicGitRequest(address, { repositoryPath: '.' }, root)
      expect(plan.operation).toBe(operation)
      expect(plan.type).toBe(requestType)
      expect(plan.payload.workspace_path).toBe(realpathSync(root))
      return address
    })

    expect(HOST_GIT_REQUEST_TYPES).toHaveLength(77)
    expect(PUBLIC_GIT_METHODS).toHaveLength(HOST_GIT_REQUEST_TYPES.length)
    expect(new Set(addresses).size).toBe(HOST_GIT_REQUEST_TYPES.length)
  })

  it('preserves the fixed Host deadlines for remote Git and AI message work', () => {
    const root = workspace()
    for (const operation of ['clone', 'fetch', 'pull', 'pull_rebase', 'push', 'push_force', 'push_upstream', 'sync'] as GitOperation[]) {
      expect(publicGitRequest(gitCapabilityMethod(operation), { repositoryPath: '.' }, root).timeoutMs).toBe(65_000)
    }
    expect(publicGitRequest('aiCli.generateCommitMessage', { repositoryPath: '.' }, root)).toMatchObject({
      operation: 'generate_message',
      type: 'git.generate_message',
      timeoutMs: 75_000,
    })
  })

  it('publishes Git operations with the Host-owned git executable', () => {
    const entry = PUBLIC_CAPABILITY_CATALOG['shell.gitStatus']
    expect(entry).toMatchObject({
      address: 'shell.gitStatus',
      namespace: 'shell',
      shellCommand: 'git',
      scope: 'workspace',
    })
  })
})

describe('public Git request validation', () => {
  it.each([
    ['unknown method', 'shell.gitUnknown', { repositoryPath: '.' }],
    ['authority field', 'shell.gitStatus', { repositoryPath: '.', workspaceId: 'forged' }],
    ['credential nonce', 'shell.gitCredentialSubmit', { request_id: 'request-1', value: 'secret', nonce: 'forged' }],
    ['command injection', 'shell.gitStatus', { repositoryPath: '.', command: 'git status; rm -rf .' }],
    ['typed scalar', 'shell.gitStatus', { repositoryPath: '.', include_ignored: 'true' }],
    ['typed array', 'shell.gitStage', { repositoryPath: '.', files: ['README.md', 7] }],
    ['non-finite number', 'shell.gitDiscoverRepositories', { repositoryPath: '.', max_depth: Number.NaN }],
  ])('rejects %s', (_label, address, args) => {
    expect(validatePublicGitRequest(address, args)).toBe(false)
  })

  it('rejects malformed values before the broker could plan them', () => {
    expect(validatePublicGitRequest('shell.gitStatus', null)).toBe(false)
    expect(validatePublicGitRequest('shell.gitStatus', ['repositoryPath', '.'])).toBe(false)
    expect(validatePublicGitRequest('shell.gitStatus', { repositoryPath: '.', workspacePath: '/outside' })).toBe(false)
    expect(
      planPublicCapabilityCall(
        call({ args: { repositoryPath: '.', command: 'git status; rm -rf .' } }),
        manifestV2CapabilityPolicy({ shell: 'allowlist' }),
        context(),
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
    expect(
      planPublicCapabilityCall(
        call({ args: { repositoryPath: '.', workspaceId: 'forged' } }),
        manifestV2CapabilityPolicy({ shell: 'allowlist' }),
        context(),
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
    expect(
      planPublicCapabilityCall(
        call({
          method: 'gitCredentialSubmit',
          args: { request_id: 'request-1', value: 'secret', nonce: 'forged' },
        }),
        manifestV2CapabilityPolicy({ shell: 'allowlist' }),
        context(),
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
    expect(
      planPublicCapabilityCall(call({ method: 'gitUnknown' }), manifestV2CapabilityPolicy({ shell: 'allowlist' }), context())
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'METHOD_NOT_FOUND' } } })
  })
})

describe('public Git workspace containment', () => {
  it('rejects a repository outside the authenticated workspace', () => {
    const root = workspace()
    const outside = workspace()
    expect(() => publicGitRequest('shell.gitStatus', { repositoryPath: outside }, root)).toThrow(/workspace/)
    expect(() => publicGitRequest('shell.gitStatus', { repositoryPath: '../outside' }, root)).toThrow(/workspace/)
  })

  it('rejects a symlink inside the workspace that resolves outside it', () => {
    const root = workspace()
    const outside = workspace()
    const link = join(root, 'linked-repository')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, link)
    expect(() => publicGitRequest('shell.gitStatus', { repositoryPath: 'linked-repository' }, root)).toThrow(/workspace/)
  })
})

describe('public Git broker policy', () => {
  const policy = manifestV2CapabilityPolicy({ shell: 'allowlist' })

  it('allows an agent only when the Host execution policy includes git', () => {
    expect(planPublicCapabilityCall(call(), policy, context({ executionPolicy: executionPolicy(['git']) }))).toMatchObject({
      kind: 'allow',
      plan: { address: 'shell.gitStatus', shellMode: 'allowlist' },
    })
    expect(planPublicCapabilityCall(call(), policy, context({ executionPolicy: executionPolicy([]) }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('retains direct-user semantics independently of the agent execution snapshot', () => {
    expect(
      planPublicCapabilityCall(
        call({ args: { repositoryPath: '.', command: 'rm -rf .' } }),
        policy,
        context({ initiator: { kind: 'user', id: 'user-1' }, executionPolicy: executionPolicy([]) }),
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })

    expect(
      planPublicCapabilityCall(
        call(),
        policy,
        context({ initiator: { kind: 'user', id: 'user-1' }, executionPolicy: executionPolicy([]) }),
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.gitStatus' } })
  })
})
