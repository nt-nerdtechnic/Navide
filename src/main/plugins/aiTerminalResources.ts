import { app, BrowserWindow, clipboard, Menu, type WebContents } from 'electron'
import { join } from 'node:path'
import { saveClipboardImage } from '../dropped-file-store'
import { buildTerminalContextMenuTemplate } from '../context-menu'
import { setTerminalSelection, forgetTerminalSelection } from '../terminal-selection-cache'

const selectionOwners = new Set<number>()

/** Fixed native terminal helpers. The manager supplies the authenticated
 * instance's WebContents and a live session/policy check; no renderer-provided
 * window id, storage path or process id is accepted. */
export async function executeAiTerminalResource(
  address: string,
  args: Record<string, unknown>,
  contents: WebContents,
  canDispatch: () => boolean,
): Promise<unknown> {
  if (!canDispatch() || contents.isDestroyed()) throw new Error('Terminal resource request denied')
  if (address === 'aiCli.saveClipboardImage') {
    const path = await saveClipboardImage(
      Uint8Array.from(args.bytes as number[]), String(args.mediaType), join(app.getPath('userData'), 'dropped-files'),
    )
    return { path }
  }
  const selection = String(args.selection)
  if (address === 'aiCli.reportTerminalSelection') {
    setTerminalSelection(contents.id, selection)
    if (!selectionOwners.has(contents.id)) {
      const id = contents.id
      selectionOwners.add(id)
      contents.once('destroyed', () => { selectionOwners.delete(id); forgetTerminalSelection(id) })
    }
    return {}
  }
  if (address === 'aiCli.showTerminalContextMenu') {
    const template = buildTerminalContextMenuTemplate(selection, {
      copy: text => { if (canDispatch()) clipboard.writeText(text) },
      paste: () => { if (canDispatch() && !contents.isDestroyed()) contents.paste() },
    })
    const window = BrowserWindow.fromWebContents(contents)
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
    return {}
  }
  throw new Error('Unknown terminal resource operation')
}
