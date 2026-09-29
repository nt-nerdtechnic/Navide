// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import GitWindowApp from '../GitWindowApp.vue'
import {
  GIT_ACCOUNTS_KEY,
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from '../ports/gitSurface'
import type { GitTransport, GitTransportResponse } from '#git-feature'
import type { AiCliSessionController } from '@navide/plugin-ui'

const notify = vi.hoisted(() => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => true) }))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

let cleanCalls: boolean[] = []
let cleanFiles: string[][] = []

const transport: GitTransport = {
  status: { value: 'connected' },
  async send<TPayload = unknown>(type: Parameters<GitTransport['send']>[0], payload: Record<string, unknown> = {}) {
    if (type === 'git.status') {
      return { ok: true, payload: {
        is_git_repo: true, branch: 'main', remote_branch: '', ahead: 0, behind: 0,
        staged: [], unstaged: [], untracked: [], ignored: [], operation_in_progress: '',
      }, error: null } as GitTransportResponse<TPayload>
    }
    if (type === 'git.clean') {
      const dry = payload.dry_run === true
      cleanCalls.push(dry)
      const files = cleanFiles.shift() ?? []
      return { ok: true, payload: { ok: true, files, dry_run: dry }, error: null } as GitTransportResponse<TPayload>
    }
    if (type === 'git.discover_repositories') {
      return { ok: true, payload: { ok: true, repositories: [] }, error: null } as GitTransportResponse<TPayload>
    }
    return { ok: true, payload: { ok: true }, error: null } as GitTransportResponse<TPayload>
  },
  on: () => () => undefined,
}

const aiCliController = {
  sessionId: null, profileId: null,
  listProfiles: vi.fn(async () => []), resume: vi.fn(async () => null), start: vi.fn(async () => 'session'),
  send: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined), dispose: vi.fn(), onOutput: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined),
} as unknown as import('@navide/plugin-ui').AiCliSessionController

describe('navide.git window clean untracked', () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => { wrapper?.unmount(); wrapper = null; cleanCalls = []; cleanFiles = []; vi.clearAllMocks() })

  async function mountWindow(): Promise<VueWrapper> {
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
    const w = mount(GitWindowApp, {
      attachTo: document.body,
      props: {
        workspaceGrantPort: { pickWorkspace: vi.fn(async () => null), openWorkspace: vi.fn(async () => undefined), openKnownWorktree: vi.fn(async () => undefined) },
        aiCliController,
      },
      global: {
        plugins: [i18n],
        stubs: { SafeAiCliPanel: true, GitCredentialModal: true, GitHistoryModal: true, NotificationHost: true, DiffPane: true, BranchDiffPane: true, ConflictPane: true },
        provide: {
          [GIT_TRANSPORT_KEY as symbol]: transport,
          [GIT_FILE_ACCESS_KEY as symbol]: { readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn() },
          [GIT_UI_KEY as symbol]: { openInEditor: vi.fn(), openExternal: vi.fn(), revealPath: vi.fn(), pickFolder: vi.fn() },
          [GIT_BRANCH_DIFF_KEY as symbol]: { load: vi.fn() },
          [GIT_ACCOUNTS_KEY as symbol]: {
            accounts: { value: [] }, available: { value: true }, refresh: vi.fn(async () => undefined),
            addAccount: vi.fn(async () => true), bind: vi.fn(async () => true), unbind: vi.fn(async () => true),
            getBinding: vi.fn(async () => null),
          },
          [GIT_ISSUES_KEY as symbol]: { provider: vi.fn(async () => ({ ok: true, payload: { provider: 'none' }, error: null })), list: vi.fn(), get: vi.fn(), create: vi.fn(), comment: vi.fn(), setState: vi.fn() },
        },
      },
    })
    await flushPromises()
    return w
  }

  async function runClean(w: VueWrapper): Promise<void> {
    await w.get('.tb-more').trigger('click')
    await flushPromises()
    const items = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    const item = items.at(-1)
    item!.click()
    await flushPromises()
  }

  it('does not delete when the untracked set changed after the user confirmed (LOW-4)', async () => {
    cleanFiles = [['a.tmp'], ['a.tmp', 'secret.tmp']]
    wrapper = await mountWindow()
    await runClean(wrapper)

    expect(cleanCalls).toEqual([true, true])
    expect(notify.toast).toHaveBeenCalledWith(expect.stringContaining('Nothing was deleted'), { type: 'error' })
  })

  it('deletes when the set is unchanged', async () => {
    cleanFiles = [['a.tmp'], ['a.tmp'], ['a.tmp']]
    wrapper = await mountWindow()
    await runClean(wrapper)

    expect(cleanCalls).toEqual([true, true, false])
  })
})
