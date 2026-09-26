import { createTerminalFilePicker } from '@navide/plugin-ui/file-picker'
import type { HostFilePickerBridge } from '../../../../shared/filePicker'

// This bootstrap is deliberately independent of Host App, IDE, terminal,
// plugin runtime and backend clients. Its preload exposes only picker IPC.
const bridge = (window as unknown as { navideFilePicker: HostFilePickerBridge }).navideFilePicker
document.getElementById('app')?.replaceChildren()
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

bridge.ready(init => {
  document.documentElement.dataset.theme = init.theme
  const picker = createTerminalFilePicker({
    async query(query) {
      const rows = await bridge.search(init.invocationId, query)
      return rows.map(row => {
        const separator = row.path.lastIndexOf('/')
        return { abs: row.id, name: row.path.slice(separator + 1), dir: row.path.slice(0, separator) || '/' }
      })
    },
    collapsePath: dir => dir === init.homePath ? '~' : dir.startsWith(`${init.homePath}/`) ? `~${dir.slice(init.homePath.length)}` : dir,
    onPick(item, _line, event) {
      // The only authority-bearing action is an actual event in this Host
      // renderer. Candidate strings and ordinary plugin IPC cannot select.
      if (event.isTrusted) bridge.select(init.invocationId, item.abs)
      else bridge.cancel(init.invocationId)
    },
    onClose(reason) {
      if (reason === 'cancel') bridge.cancel(init.invocationId)
    },
  })
  picker.open({ initialQuery: init.query })
  window.addEventListener('beforeunload', () => picker.close(), { once: true })
})
