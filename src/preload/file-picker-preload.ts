import { contextBridge, ipcRenderer } from 'electron'
import type { HostFilePickerBridge, HostFilePickerInit } from '../shared/filePicker'

const bridge: HostFilePickerBridge = {
  ready(listener) {
    ipcRenderer.once('file-picker:init', (_event, init: HostFilePickerInit) => listener(init))
    ipcRenderer.send('file-picker:ready')
  },
  search: (invocationId, query) => ipcRenderer.invoke('file-picker:search', invocationId, query),
  select: (invocationId, rowId) => ipcRenderer.send('file-picker:select', invocationId, rowId),
  cancel: invocationId => ipcRenderer.send('file-picker:cancel', invocationId),
}
contextBridge.exposeInMainWorld('navideFilePicker', bridge)
