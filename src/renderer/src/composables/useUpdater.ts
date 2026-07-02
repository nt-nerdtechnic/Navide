import { ref, onMounted } from 'vue'

export function useUpdater() {
  const updateAvailable = ref<string | null>(null)  // version string when available
  const downloadProgress = ref<number | null>(null)  // 0-100 during download
  const updateReady = ref<string | null>(null)       // version string when downloaded

  onMounted(() => {
    const api = window.agentTeam?.updater
    if (!api) return
    api.onUpdateAvailable((info) => { updateAvailable.value = info.version })
    api.onDownloadProgress((info) => { downloadProgress.value = info.percent })
    api.onUpdateDownloaded((info) => {
      updateReady.value = info.version
      downloadProgress.value = null
    })
  })

  function startDownload(): void { void window.agentTeam?.updater?.download() }
  function installUpdate(): void { window.agentTeam?.updater?.install() }

  return { updateAvailable, downloadProgress, updateReady, startDownload, installUpdate }
}
