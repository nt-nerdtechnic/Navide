// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import MultiRepoGit from '../MultiRepoGit.vue'

const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number } }[]>([])

vi.mock('../../composables/useRepoDiscovery', () => ({
  useRepoDiscovery: () => ({ repositories: mockRepositories, refresh: vi.fn() }),
}))

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
  it('renders a single GitPane and no repos-list when 0 repos discovered', () => {
    mockRepositories.value = []
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repos-list').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'GitPane' }).exists() ||
           wrapper.find('git-pane-stub').exists() ||
           wrapper.html().toLowerCase().includes('git-pane')).toBeTruthy()
  })

  it('renders no repos-list when only 1 repo discovered', () => {
    mockRepositories.value = [makeRepo('.', '/ws', 'main')]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repos-list').exists()).toBe(false)
  })
})

describe('MultiRepoGit – multi-repo accordion', () => {
  it('renders repos-list with REPOSITORIES header when 2 repos discovered', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 2),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    expect(wrapper.find('.repos-list').exists()).toBe(true)
    expect(wrapper.find('.repos-header').text()).toBe('pane.git.repositories')
    expect(wrapper.findAll('.repo-header')).toHaveLength(2)
  })

  it('first repo is expanded by default, others collapsed', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const headers = wrapper.findAll('.repo-header')
    expect(headers[0].attributes('aria-expanded')).toBe('true')
    expect(headers[1].attributes('aria-expanded')).toBe('false')
  })

  it('shows dirty badge when dirtyCount > 0', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 5),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const blocks = wrapper.findAll('.repo-block')
    expect(blocks[0].find('.repo-dirty-badge').exists()).toBe(true)
    expect(blocks[0].find('.repo-dirty-badge').text()).toBe('5')
    expect(blocks[1].find('.repo-dirty-badge').exists()).toBe(false)
  })

  it('clicking collapsed header expands it', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const headers = wrapper.findAll('.repo-header')
    await headers[1].trigger('click')
    expect(headers[1].attributes('aria-expanded')).toBe('true')
  })

  it('clicking expanded header collapses it', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const headers = wrapper.findAll('.repo-header')
    // First is expanded by default; click to collapse.
    await headers[0].trigger('click')
    expect(headers[0].attributes('aria-expanded')).toBe('false')
  })

  it('shows repo-name text matching repoLabel', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('pkg', '/ws/pkg', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend },
    })
    const names = wrapper.findAll('.repo-name')
    expect(names[0].text()).toBe('label.git-repo-root')
    expect(names[1].text()).toBe('pkg')
  })
})
