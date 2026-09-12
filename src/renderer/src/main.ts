// The terminal-only branch retains this exact Host origin and partition.
// It must not evaluate App/EditorWindowApp or their renderer bootstrap.
if (new URLSearchParams(window.location.search).get('file_picker') === '1') {
  void import('./platform/file-picker/filePicker')
} else if (new URLSearchParams(window.location.search).get('terminal_owner') === '1') {
  void import('../plugins/mini-ide/terminalOwner')
} else {
  void import('./hostMount')
}
