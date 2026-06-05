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
  { key: 'ctrl+g',         command: 'editor.action.gotoLine',       when: 'editorOpen' },
  { key: 'cmd+/',         command: 'editor.action.toggleComment',  when: 'editorTextFocus' },
  { key: 'cmd+shift+k',   command: 'editor.action.deleteLines',    when: 'editorTextFocus' },
  { key: 'cmd+enter',     command: 'editor.action.insertLineAfter', when: 'editorTextFocus' },
  { key: 'cmd+shift+enter', command: 'editor.action.insertLineBefore', when: 'editorTextFocus' },

  { key: 'alt+up',         command: 'editor.action.moveLineUp',       when: 'editorTextFocus' },
  { key: 'alt+down',       command: 'editor.action.moveLineDown',     when: 'editorTextFocus' },
  { key: 'shift+alt+down', command: 'editor.action.duplicateLineDown', when: 'editorTextFocus' },
  { key: 'shift+alt+up',   command: 'editor.action.duplicateLineUp',   when: 'editorTextFocus' },
  { key: 'cmd+shift+l',    command: 'editor.action.selectHighlights',  when: 'editorTextFocus' },
  // macOS US: Cmd+Shift+\ fires e.key='|'; use cmd+shift+| to match correctly
  { key: 'cmd+shift+|',    command: 'editor.action.jumpToBracket',     when: 'editorTextFocus' },
  { key: 'cmd+d',          command: 'editor.action.addSelectionToNextFindMatch', when: 'editorTextFocus' },
  { key: 'cmd+]',          command: 'editor.action.indentLines',        when: 'editorTextFocus' },
  { key: 'cmd+[',          command: 'editor.action.outdentLines',       when: 'editorTextFocus' },
  { key: 'cmd+up',         command: 'editor.action.cursorTop',          when: 'editorTextFocus' },
  { key: 'cmd+down',       command: 'editor.action.cursorBottom',       when: 'editorTextFocus' },

  { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
  { key: 'f1',          command: 'workbench.action.showCommands' },
  { key: 'cmd+k cmd+w', command: 'workbench.action.closeAllEditors' },

  // ── Workbench: sidebar & view ────────────────────────────────────────────────
  { key: 'cmd+b',       command: 'workbench.action.toggleSidebar' },
  { key: 'cmd+shift+e', command: 'workbench.action.focusExplorer' },
  { key: 'cmd+shift+g', command: 'workbench.action.focusSourceControl', when: '!findOpen' },

  // ── Editor tabs ──────────────────────────────────────────────────────────────
  { key: 'ctrl+tab',       command: 'workbench.action.openNextEditor' },
  { key: 'ctrl+shift+tab', command: 'workbench.action.openPreviousEditor' },
]
