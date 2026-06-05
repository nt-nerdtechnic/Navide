import type { KeybindingRule } from './types'

// Default keybinding rules.
// - Commands with no registered handler are no-ops: executeCommand returns false,
//   stopPropagation is NOT called, so existing element handlers still fire.
// - This makes all rules safe to define upfront even before Phase C wires handlers.
export const defaults: KeybindingRule[] = [
  // ── Workbench ────────────────────────────────────────────────────────────
  { key: 'cmd+shift+f', command: 'workbench.action.findInFiles' },
  { key: 'cmd+,',       command: 'workbench.action.openSettings' },
  { key: 'cmd+w',       command: 'workbench.action.closeActiveEditor', when: 'editorOpen && !modalOpen' },
  { key: 'cmd+shift+s', command: 'workbench.action.saveAll',             when: 'editorOpen' },
  { key: 'escape',      command: 'workbench.action.closeModal', when: 'modalOpen' },

  // ── Editor ───────────────────────────────────────────────────────────────
  { key: 'cmd+s', command: 'editor.action.save',          when: 'editorOpen && !terminalFocus' },
  // cmd+k is a chord prefix; cmd+k cmd+k is the double-chord for inline rewrite
  // (single cmd+k is blocked by chord mode in editorTextFocus context)
  { key: 'cmd+k cmd+k',    command: 'editor.action.inlineRewrite', when: 'editorTextFocus' },
  { key: 'ctrl+shift+i',   command: 'editor.action.inlineRewrite', when: 'editorTextFocus' },
  { key: 'cmd+i',   command: 'editor.action.triggerGhost',  when: 'editorTextFocus' },
  { key: 'ctrl+space', command: 'editor.action.triggerGhost', when: 'editorTextFocus' },
  { key: 'cmd+f', command: 'editor.action.openFind',      when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+h', command: 'editor.action.openReplace',  when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+g', command: 'editor.action.nextMatch',     when: 'findOpen' },
  { key: 'cmd+shift+g', command: 'editor.action.prevMatch', when: 'findOpen' },
  { key: 'cmd+l', command: 'editor.action.gotoLine',      when: 'editorOpen' },
  { key: 'cmd+z',       command: 'editor.action.undo',    when: 'editorTextFocus' },
  { key: 'cmd+shift+z', command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+y',       command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+a',       command: 'editor.action.selectAll', when: 'editorTextFocus' },
  { key: 'ctrl+l',      command: 'editor.action.selectLine', when: 'editorTextFocus' },
  { key: 'ctrl+g',         command: 'editor.action.gotoLine',       when: 'editorOpen' },
  { key: 'cmd+/',         command: 'editor.action.toggleComment',  when: 'editorTextFocus' },
  { key: 'cmd+alt+/',     command: 'editor.action.blockComment',   when: 'editorTextFocus' },
  { key: 'shift+alt+a',  command: 'editor.action.blockComment',   when: 'editorTextFocus' },
  { key: 'cmd+shift+k',   command: 'editor.action.deleteLines',    when: 'editorTextFocus' },
  { key: 'alt+backspace', command: 'editor.action.deleteWordLeft',  when: 'editorTextFocus' },
  { key: 'alt+delete',    command: 'editor.action.deleteWordRight', when: 'editorTextFocus' },
  { key: 'cmd+backspace', command: 'editor.action.deleteAllLeft',  when: 'editorTextFocus' },
  { key: 'cmd+delete',    command: 'editor.action.deleteAllRight', when: 'editorTextFocus' },
  { key: 'cmd+enter',     command: 'editor.action.insertLineAfter', when: 'editorTextFocus' },
  { key: 'cmd+shift+enter', command: 'editor.action.insertLineBefore', when: 'editorTextFocus' },

  { key: 'alt+up',         command: 'editor.action.moveLineUp',       when: 'editorTextFocus' },
  { key: 'alt+down',       command: 'editor.action.moveLineDown',     when: 'editorTextFocus' },
  { key: 'shift+alt+down', command: 'editor.action.duplicateLineDown', when: 'editorTextFocus' },
  { key: 'shift+alt+up',   command: 'editor.action.duplicateLineUp',   when: 'editorTextFocus' },
  { key: 'cmd+shift+l',    command: 'editor.action.selectHighlights',  when: 'editorTextFocus' },
  { key: 'cmd+f2',         command: 'editor.action.selectHighlights',  when: 'editorTextFocus' },
  // macOS US: Cmd+Shift+\ fires e.key='|'; use cmd+shift+| to match correctly
  { key: 'cmd+shift+|',    command: 'editor.action.jumpToBracket',     when: 'editorTextFocus' },
  { key: 'cmd+d',          command: 'editor.action.addSelectionToNextFindMatch', when: 'editorTextFocus' },
  { key: 'cmd+]',          command: 'editor.action.indentLines',        when: 'editorTextFocus' },
  { key: 'cmd+[',          command: 'editor.action.outdentLines',       when: 'editorTextFocus' },
  { key: 'cmd+up',         command: 'editor.action.cursorTop',          when: 'editorTextFocus' },
  { key: 'cmd+down',       command: 'editor.action.cursorBottom',       when: 'editorTextFocus' },
  { key: 'ctrl+up',        command: 'editor.action.scrollLineUp',       when: 'editorTextFocus' },
  { key: 'ctrl+down',      command: 'editor.action.scrollLineDown',     when: 'editorTextFocus' },

  { key: 'cmd+k cmd+c', command: 'editor.action.addLineComment',         when: 'editorTextFocus' },
  { key: 'cmd+k cmd+u', command: 'editor.action.removeLineComment',      when: 'editorTextFocus' },
  { key: 'cmd+k cmd+x', command: 'editor.action.trimTrailingWhitespace', when: 'editorTextFocus' },
  { key: 'shift+alt+f',      command: 'editor.action.formatDocument',      when: 'editorTextFocus' },
  { key: 'cmd+k cmd+f',     command: 'editor.action.formatSelection',     when: 'editorTextFocus' },
  { key: 'shift+alt+right', command: 'editor.action.smartSelect.expand',  when: 'editorTextFocus' },
  { key: 'shift+alt+left',  command: 'editor.action.smartSelect.shrink',  when: 'editorTextFocus' },
  { key: 'cmd+k cmd+m', command: 'workbench.action.changeLanguageMode',    when: 'editorOpen' },
  { key: 'cmd+k cmd+p', command: 'workbench.action.copyFilePath',          when: 'editorOpen' },
  { key: 'cmd+k cmd+r',  command: 'workbench.action.revealInExplorer',  when: 'editorOpen' },
  { key: 'shift+alt+r', command: 'workbench.action.revealFileInOS',      when: 'editorOpen' },
  { key: 'cmd+k cmd+s', command: 'workbench.action.openKeyboardShortcuts' },
  { key: 'cmd+k cmd+t', command: 'workbench.action.selectTheme' },
  { key: 'cmd+k cmd+z', command: 'workbench.action.toggleZenMode' },
  { key: 'cmd+k cmd+o', command: 'workbench.action.openFolder' },
  { key: 'cmd+k cmd+e', command: 'workbench.action.focusActiveEditorGroup', when: 'editorOpen' },
  { key: 'cmd+=',       command: 'editor.action.fontZoomIn',    when: 'editorOpen' },
  { key: 'cmd+-',       command: 'editor.action.fontZoomOut',   when: 'editorOpen' },
  { key: 'cmd+0',       command: 'editor.action.fontZoomReset', when: 'editorOpen' },
  { key: 'f3',          command: 'editor.action.nextMatch',          when: 'findOpen' },
  { key: 'shift+f3',    command: 'editor.action.prevMatch',          when: 'findOpen' },

  { key: 'cmd+o',       command: 'workbench.action.openFile' },
  { key: 'cmd+n',       command: 'workbench.action.newFile' },
  { key: 'cmd+shift+n', command: 'workbench.action.newWindow' },
  { key: 'cmd+shift+o', command: 'workbench.action.gotoSymbol', when: 'editorOpen' },
  { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
  { key: 'f1',          command: 'workbench.action.showCommands' },
  { key: 'cmd+k cmd+w', command: 'workbench.action.closeAllEditors' },
  { key: 'cmd+p',       command: 'workbench.action.quickOpen' },
  { key: 'cmd+shift+t', command: 'workbench.action.reopenClosedEditor' },

  // ── Workbench: sidebar & view ────────────────────────────────────────────────
  { key: 'cmd+b',       command: 'workbench.action.toggleSidebar' },
  { key: 'cmd+shift+e', command: 'workbench.action.focusExplorer' },
  { key: 'cmd+shift+g', command: 'workbench.action.focusSourceControl', when: '!findOpen' },

  // ── Editor tabs ──────────────────────────────────────────────────────────────
  { key: 'ctrl+tab',       command: 'workbench.action.openNextEditor' },
  { key: 'ctrl+shift+tab', command: 'workbench.action.openPreviousEditor' },
  { key: 'cmd+shift+]', command: 'workbench.action.moveEditorRightInGroup', when: 'editorOpen' },
  { key: 'cmd+shift+[', command: 'workbench.action.moveEditorLeftInGroup',  when: 'editorOpen' },
  { key: 'cmd+1', command: 'workbench.action.openEditorAtIndex1', when: 'editorOpen' },
  { key: 'cmd+2', command: 'workbench.action.openEditorAtIndex2', when: 'editorOpen' },
  { key: 'cmd+3', command: 'workbench.action.openEditorAtIndex3', when: 'editorOpen' },
  { key: 'cmd+4', command: 'workbench.action.openEditorAtIndex4', when: 'editorOpen' },
  { key: 'cmd+5', command: 'workbench.action.openEditorAtIndex5', when: 'editorOpen' },
  { key: 'cmd+6', command: 'workbench.action.openEditorAtIndex6', when: 'editorOpen' },
  { key: 'cmd+7', command: 'workbench.action.openEditorAtIndex7', when: 'editorOpen' },
  { key: 'cmd+8', command: 'workbench.action.openEditorAtIndex8', when: 'editorOpen' },
  { key: 'cmd+9', command: 'workbench.action.openEditorAtIndex9', when: 'editorOpen' },

  // ── Navigation history ────────────────────────────────────────────────────────
  { key: 'ctrl+-',       command: 'workbench.action.navigateBack',    when: 'editorOpen' },
  { key: 'ctrl+shift+-', command: 'workbench.action.navigateForward', when: 'editorOpen' },

  // ── AI Chat ──────────────────────────────────────────────────────────────────
  { key: 'cmd+shift+a', command: 'workbench.action.toggleAIChat' },

  // ── Replace in files / editor utilities ──────────────────────────────────────
  { key: 'cmd+shift+h', command: 'workbench.action.findInFilesReplace' },
  { key: 'ctrl+t',      command: 'editor.action.transpose',           when: 'editorTextFocus' },
  { key: 'ctrl+j',      command: 'editor.action.joinLines',           when: 'editorTextFocus' },

  // ── Copy paths ────────────────────────────────────────────────────────────────
  { key: 'cmd+shift+alt+c', command: 'workbench.action.copyRelativeFilePath', when: 'editorOpen' },

  // ── Navigation ────────────────────────────────────────────────────────────────
  { key: 'cmd+k cmd+q', command: 'editor.action.navigateToLastEditLocation', when: 'editorOpen' },
  { key: 'cmd+k cmd+d', command: 'editor.action.moveSelectionToNextFindMatch', when: 'editorTextFocus' },
  { key: 'f12',         command: 'editor.action.openFileAtCursor',             when: 'editorTextFocus' },
]
