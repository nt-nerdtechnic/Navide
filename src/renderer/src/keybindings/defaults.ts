import type { KeybindingRule } from './types'

// Default keybinding rules.
// - Commands with no registered handler are no-ops: executeCommand returns false,
//   stopPropagation is NOT called, so existing element handlers still fire.
// - This makes all rules safe to define upfront even before Phase C wires handlers.
export const defaults: KeybindingRule[] = [
  // ── Workbench ────────────────────────────────────────────────────────────
  { key: 'cmd+shift+f', command: 'workbench.action.findInFiles' },
  { key: 'cmd+,',       command: 'workbench.action.openSettings' },
  { key: 'cmd+w',       command: 'workbench.action.closeWindow' },
  { key: 'escape',      command: 'workbench.action.closeModal', when: 'modalOpen' },

  // ── Editor ───────────────────────────────────────────────────────────────
  { key: 'cmd+s', command: 'editor.action.save',          when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+k', command: 'editor.action.inlineRewrite', when: 'editorTextFocus' },
  { key: 'cmd+i', command: 'editor.action.triggerGhost',  when: 'editorTextFocus' },
  { key: 'cmd+f', command: 'editor.action.openFind',      when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+g', command: 'editor.action.nextMatch',     when: 'findOpen' },
  { key: 'cmd+shift+g', command: 'editor.action.prevMatch', when: 'findOpen' },
  { key: 'cmd+l', command: 'editor.action.gotoLine',      when: 'editorOpen' },
  { key: 'cmd+z',       command: 'editor.action.undo',    when: 'editorTextFocus' },
  { key: 'cmd+shift+z', command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+y',       command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+a',       command: 'editor.action.selectAll', when: 'editorTextFocus' },
]
