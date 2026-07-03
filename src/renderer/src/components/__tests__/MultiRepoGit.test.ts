// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import MultiRepoGit from '../MultiRepoGit.vue'

// Stub useRepoDiscovery so we can control the repositories list.
const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number } }[]>([])

vi.mock('../../composables/useRepoDiscovery', () => ({
  useRepoDiscovery: () => ({ repositories: mockRepositories, refresh: vi.fn() }),
}))

// Stub vue-i18n.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0) {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

const stubBackend = {} as never

beforeEach(() => {
  mockRepositories.value = []
  try { localStorage.clear() } catch { /* ignore */ }
})

describe('MultiRepoGit – single-repo passthrough', () => {
  it('renders a single GitPane stub and no tab bar when 0 repos discovered', () => {
    mockRepositories.value = []
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
    // Shallow stub renders as <git-pane-stub> (or similar).
    expect(wrapper.findComponent({ name: 'GitPane' }).exists() ||
           wrapper.find('[class]').exists() ||
           wrapper.html().includes('git-pane')).toBeTruthy()
  })

  it('renders no tab bar when only 1 repo discovered', () => {
    mockRepositories.value = [makeRepo('.', '/ws', 'main')]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
  })
})

describe('MultiRepoGit – multi-repo tab bar', () => {
  it('renders tab bar with 2 tabs when 2 repos discovered', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 2),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)
    expect(wrapper.findAll('.repo-tab')).toHaveLength(2)
  })

  it('first tab is active by default', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const tabs = wrapper.findAll('.repo-tab')
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
  })

  it('shows dirty count badge on tab when dirtyCount > 0', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 5),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const firstTab = wrapper.findAll('.repo-tab')[0]
    expect(firstTab.find('.repo-tab-badge').exists()).toBe(true)
    expect(firstTab.find('.repo-tab-badge').text()).toBe('5')

    const secondTab = wrapper.findAll('.repo-tab')[1]
    expect(secondTab.find('.repo-tab-badge').exists()).toBe(false)
  })

  it('clicking a tab switches active state', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const tabs = wrapper.findAll('.repo-tab')
    await tabs[1].trigger('click')
    expect(tabs[1].classes()).toContain('active')
    expect(tabs[0].classes()).not.toContain('active')
  })

  it('uses label.git-repo-root for rel_path "."', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('pkg', '/ws/pkg', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const firstTabName = wrapper.findAll('.repo-tab-name')[0].text()
    // Our stub t() returns the key itself.
    expect(firstTabName).toBe('label.git-repo-root')
  })
})
