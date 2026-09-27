import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UpdateState, UpdaterSettings } from '../../../shared/updater'
import {
  DEFAULT_CHECK_FAILURE_THRESHOLD,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
} from '../../../shared/updater'

export type RendererUpdateState = UpdateState

const BLOCK_NOTE_ELEMENTS = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
])
const OMIT_NOTE_ELEMENTS = new Set(['script', 'style', 'template', 'noscript'])

function htmlNoteNodeText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== 1) return ''

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (OMIT_NOTE_ELEMENTS.has(tag)) return ''
  if (tag === 'br') return '\n'

  const content = Array.from(element.childNodes, htmlNoteNodeText).join('')
  if (tag === 'li') return `\n• ${content.trim()}\n`
  if (BLOCK_NOTE_ELEMENTS.has(tag)) return `\n${content.trim()}\n`
  return content
}

/**
 * GitHub release feeds can provide rendered HTML instead of Markdown. Convert
 * it to readable text for the UI; release metadata is never rendered as HTML.
 */
function normalizeReleaseNotes(notes: string | undefined): string | undefined {
  if (!notes || !/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/i.test(notes)) return notes

  const parsed = new DOMParser().parseFromString(notes, 'text/html')
  return Array.from(parsed.body.childNodes, htmlNoteNodeText)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeUpdateState(state: RendererUpdateState): RendererUpdateState {
  if (state.releaseNotes === undefined) return state
  return { ...state, releaseNotes: normalizeReleaseNotes(state.releaseNotes) }
}

const DEFAULT_SETTINGS: UpdaterSettings = {
  autoCheck: true,
  autoDownload: true,
  autoInstallOnQuit: false,
  channel: 'stable',
  notifyOnCheckFailure: true,
  checkFailureThreshold: DEFAULT_CHECK_FAILURE_THRESHOLD,
  retryDownload: true,
  downloadRetryCount: DEFAULT_DOWNLOAD_RETRY_COUNT,
  installTimeoutSeconds: DEFAULT_INSTALL_TIMEOUT_SECONDS,
}

export function useUpdater() {
  const state = ref<RendererUpdateState>({
    status: 'idle',
    currentVersion: window.agentTeam?.version ?? '',
  })
  const settings = ref<UpdaterSettings>({ ...DEFAULT_SETTINGS })
  let dispose: (() => void) | undefined

  async function loadSettings(): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api?.getSettings) return
    try {
      settings.value = await api.getSettings()
    } catch {
      // Keep defaults if the main process cannot answer.
    }
  }

  async function updateSettings(patch: Partial<UpdaterSettings>): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api?.setSettings) return
    try {
      const result = await api.setSettings(patch)
      if (result.ok) settings.value = result.settings
    } catch {
      // Leave the UI on the last known-good settings.
    }
  }

  onMounted(() => {
    const api = window.agentTeam?.updater
    if (!api) return
    dispose = api.onStateChanged((next) => { state.value = normalizeUpdateState(next) })
    void api.getState().then((next) => { state.value = normalizeUpdateState(next) }).catch((error: unknown) => {
      state.value = {
        ...state.value,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    })
    void loadSettings()
  })

  onUnmounted(() => dispose?.())

  async function run(action: 'check' | 'download' | 'install'): Promise<void> {
    const api = window.agentTeam?.updater
    if (!api) return
    try {
      const result = await api[action]()
      state.value = normalizeUpdateState(result.state)
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
    settings,
    isBusy: computed(() => ['checking', 'downloading', 'installing'].includes(state.value.status)),
    checkForUpdates: (): Promise<void> => run('check'),
    startDownload: (): Promise<void> => run('download'),
    installUpdate: (): Promise<void> => run('install'),
    loadSettings,
    updateSettings,
  }
}
