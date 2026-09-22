// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
let GitLeftApp: typeof import('../GitLeftApp.vue').default

const runtimeState = vi.hoisted(() => ({
  openDetail: vi.fn(),
  prepareClose: null as null | (() => Promise<unknown>),
  closeCancelled: null as null | (() => void),
}))

vi.mock('@navide/plugin-sdk', () => ({
  createPluginViewRuntimeClient: () => ({
    openDetail: runtimeState.openDetail,
    onPrepareClose: (listener: () => Promise<unknown>) => {
      runtimeState.prepareClose = listener
      return { dispose: vi.fn() }
    },
    onCloseCancelled: (listener: () => void) => {
      runtimeState.closeCancelled = listener
      return { dispose: vi.fn() }
    },
  }),
}))

const settingsListeners: ((keys: string[]) => void)[] = []
const loadTheme = vi.fn()

vi.mock('@navide/plugin-ui/shared', () => ({
  onSettingsChanged: vi.fn((cb: (keys: string[]) => void) => {
    settingsListeners.push(cb)
    return () => undefined
  }),
  settingsGet: vi.fn(() => ''),
  useKeybindings: vi.fn(() => ({ registerCommand: vi.fn() })),
}))

vi.mock('@navide/plugin-ui/foundation', () => ({
  useTheme: () => ({ loadTheme }),
  useNotify: () => ({ toast: notifyState.toast }),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const multiRepoState = vi.hoisted(() => ({
  prepareClose: vi.fn(async () => ({ accepted: true as const })),
  releaseClose: vi.fn(),
}))

const notifyState = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock('../components/MultiRepoGit.vue', () => ({
  default: {
    name: 'MultiRepoGit',
    emits: ['open-branch-diff'],
    template: '<div data-test="multi-repo-git" />',
    methods: {
      prepareClose: multiRepoState.prepareClose,
      releaseClose: multiRepoState.releaseClose,
    },
  },
}))

function props(dispatch = vi.fn()) {
  return {
    surfacePorts: {} as never,
    hostPort: {
      getState: vi.fn(async () => null),
      onStateChanged: vi.fn(() => () => undefined),
      dispatch,
    } as never,
    legacyRepoSelection: {} as never,
  }
}

describe('GitLeftApp', () => {
  beforeEach(async () => {
    window.history.replaceState({}, '', '/?workspace_path=%2Frepo')
    vi.resetModules()
    GitLeftApp = (await import('../GitLeftApp.vue')).default
    runtimeState.openDetail.mockReset()
    multiRepoState.prepareClose.mockReset()
    multiRepoState.prepareClose.mockResolvedValue({ accepted: true })
    multiRepoState.releaseClose.mockClear()
    notifyState.toast.mockClear()
  })

  it('owns a full-height shell around the Git contribution', () => {
    const wrapper = shallowMount(GitLeftApp, {
      props: props(),
    })

    expect(wrapper.element.classList.contains('git-left-root')).toBe(true)
    expect(wrapper.findComponent({ name: 'MultiRepoGit' }).exists()).toBe(true)
  })

  it('adopts the stored theme and follows later switches', async () => {
    settingsListeners.length = 0
    loadTheme.mockClear()
    const wrapper = shallowMount(GitLeftApp, {
      props: props(),
    })
    await flushPromises()

    // mount.ts only stamps data-theme once from the entry query; that snapshot
    // is stale as soon as the user switches theme.
    expect(loadTheme).toHaveBeenCalledTimes(1)
    // No backend fallback: passing one makes loadTheme write the theme back to
    // the shared store, which the Host mirrors — see themeCallSites.test.ts.
    expect(loadTheme).toHaveBeenCalledWith()

    settingsListeners.forEach((cb) => cb(['agent-team:theme']))
    expect(loadTheme).toHaveBeenCalledTimes(2)

    settingsListeners.forEach((cb) => cb(['agent-team:theme-custom']))
    expect(loadTheme).toHaveBeenCalledTimes(3)

    settingsListeners.forEach((cb) => cb(['agentTeam.somethingElse']))
    expect(loadTheme).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it.each([
    {
      name: 'dispatches the unchanged legacy payload for receiver-unpaired',
      result: { opened: false, reason: 'receiver-unpaired' },
      shouldDispatch: true,
    },
    {
      name: 'does not dispatch the legacy action after paired success',
      result: { opened: true },
      shouldDispatch: false,
    },
    {
      name: 'does not dispatch the legacy action for paired failures',
      result: { opened: false, reason: 'receiver-refused' },
      shouldDispatch: false,
    },
    {
      name: 'does not dispatch the legacy action when the detail request throws',
      error: new Error('provider unavailable'),
      shouldDispatch: false,
    },
  ])('$name', async ({ result, error, shouldDispatch }) => {
    const dispatch = vi.fn(async () => undefined)
    if (error) runtimeState.openDetail.mockRejectedValueOnce(error)
    else runtimeState.openDetail.mockResolvedValueOnce(result)
    const wrapper = shallowMount(GitLeftApp, { props: props(dispatch) })
    const child = wrapper.findComponent({ name: 'MultiRepoGit' })
    const payload = { workspace_path: '/repo', base: 'main', compare: 'topic' }

    const onOpenBranchDiff = (child.vm.$attrs as { onOpenBranchDiff?: (value: typeof payload) => Promise<void> }).onOpenBranchDiff
    expect(onOpenBranchDiff).toEqual(expect.any(Function))
    await onOpenBranchDiff?.(payload)
    await flushPromises()

    expect(runtimeState.openDetail).toHaveBeenCalledWith(expect.objectContaining({
      contributionKey: 'navide.git.branch-detail',
      target: expect.objectContaining({
        resource: expect.objectContaining({ repository: '.', base: 'main', compare: 'topic' }),
      }),
    }))
    if (shouldDispatch) {
      expect(dispatch).toHaveBeenCalledWith({ operation: 'open_branch_diff', payload })
    } else {
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'open_branch_diff' }))
    }
    wrapper.unmount()
  })

  it.each([
    {
      name: 'file diff',
      event: 'open-diff',
      payload: { workspace_path: '/repo', filepath: 'src/a.ts', staged: false, name: 'a.ts' },
      fallback: 'open_diff',
    },
    {
      name: 'merge conflict',
      event: 'open-conflict',
      payload: { workspace_path: '/repo', filepath: 'src/b.ts', name: 'b.ts' },
      fallback: 'open_conflict',
    },
  ])('falls back to the legacy $name route when no receiver is paired', async ({ event, payload, fallback }) => {
    runtimeState.openDetail.mockResolvedValueOnce({ opened: false, reason: 'receiver-unpaired' })
    const dispatch = vi.fn(async () => undefined)
    const wrapper = shallowMount(GitLeftApp, { props: props(dispatch) })
    const child = wrapper.findComponent({ name: 'MultiRepoGit' })

    child.vm.$emit(event, payload)
    await flushPromises()

    expect(dispatch).toHaveBeenCalledWith({ operation: fallback, payload })
    expect(notifyState.toast).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('surfaces a detail refusal that has no fallback route', async () => {
    runtimeState.openDetail.mockResolvedValueOnce({ opened: false, reason: 'provider-unavailable' })
    const dispatch = vi.fn(async () => undefined)
    const wrapper = shallowMount(GitLeftApp, { props: props(dispatch) })
    const child = wrapper.findComponent({ name: 'MultiRepoGit' })

    child.vm.$emit('open-diff', { workspace_path: '/repo', filepath: 'src/a.ts', staged: false, name: 'a.ts' })
    await flushPromises()

    expect(runtimeState.openDetail).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        resource: expect.objectContaining({ kind: 'file-diff', repository: '.', filepath: 'src/a.ts' }),
      }),
    }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(notifyState.toast).toHaveBeenCalledWith('git.detail-open-failed', { type: 'error' })
    wrapper.unmount()
  })

  it('answers a receiver close preparation through MultiRepoGit and releases on cancellation', async () => {    const MultiRepoStub = (await import('../components/MultiRepoGit.vue')).default
    const wrapper = shallowMount(GitLeftApp, {
      props: props(),
      global: { stubs: { MultiRepoGit: MultiRepoStub } },
    })
    await flushPromises()

    await expect(runtimeState.prepareClose?.()).resolves.toEqual({ accepted: true, reason: 'accepted' })
    expect(multiRepoState.prepareClose).toHaveBeenCalledOnce()
    expect(multiRepoState.releaseClose).not.toHaveBeenCalled()

    runtimeState.closeCancelled?.()
    expect(multiRepoState.releaseClose).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('keeps the refused reason from a busy or draft MultiRepoGit preparation', async () => {
    const MultiRepoStub = (await import('../components/MultiRepoGit.vue')).default
    const wrapper = shallowMount(GitLeftApp, {
      props: props(),
      global: { stubs: { MultiRepoGit: MultiRepoStub } },
    })
    await flushPromises()

    for (const reason of ['busy', 'refused'] as const) {
      multiRepoState.prepareClose.mockResolvedValueOnce({ accepted: false, reason })
      await expect(runtimeState.prepareClose?.()).resolves.toEqual({ accepted: false, reason })
      expect(multiRepoState.releaseClose).not.toHaveBeenCalled()
    }
    wrapper.unmount()
  })
})
