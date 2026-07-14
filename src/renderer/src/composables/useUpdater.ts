import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UpdateState } from '../../../shared/updater'

export type RendererUpdateState = UpdateState

export function useUpdater() {
  const state = ref<RendererUpdateState>({
    status: 'idle',
    currentVersion: window.agentTeam?.version ?? '',
  })
  let dispose: (() => void) | undefined

  onMounted(() => {
    const api = window.agentTeam?.updater
    if (!api) return
    dispose = api.onStateChanged((next) => { state.value = next })
    void api.getState().then((next) => { state.value = next }).catch((error: unknown) => {
      state.value = {
        ...state.value,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    })
  })

  onUnmounted(() => dispose?.())

  async function run(action: 'check' | 'download' | 'install'): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api) return
    try {
      const result = await api[action]()
      state.value = result.state
    } catch (error) {
      state.value = {
        ...state.value,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    state,
    isBusy: computed(() => ['checking', 'downloading', 'installing'].includes(state.value.status)),
    checkForUpdates: (): Promise<void> => run('check'),
    startDownload: (): Promise<void> => run('download'),
    installUpdate: (): Promise<void> => run('install'),
  }
}
