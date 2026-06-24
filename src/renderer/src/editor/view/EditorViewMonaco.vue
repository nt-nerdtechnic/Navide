<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import './monacoWorkers'
import * as monaco from 'monaco-editor'
import type { Decoration } from '../types'
import {
  toSnakeCase, toCamelCase, toKebabCase, toPascalCase,
} from '../textTransforms'

// ── Props / Emits ─────────────────────────────────────────────────────────────
const props = withDefaults(defineProps<{
  modelValue: string
  language?: string
  diagnostics?: Array<{
    line: number; col: number; endLine?: number; severity: string; message: string; source?: string
  }>
}>(), {
  language: 'plaintext',
  diagnostics: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'cursor-change': [pos: { line: number; col: number }]
}>()

// ── Internal state ────────────────────────────────────────────────────────────
const containerEl = ref<HTMLDivElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let decorationColl: monaco.editor.IEditorDecorationsCollection | null = null
let inlineDisposer: monaco.IDisposable | null = null
let pendingGhost: string | null = null
let ignoreNextModelChange = false

type MonacoTypescriptApi = {
  CompilerOptions: unknown
  DiagnosticsOptions: unknown
  ScriptTarget: { ESNext: unknown }
  ModuleKind: { ESNext: unknown }
  ModuleResolutionKind: { NodeJs: unknown }
  JsxEmit: { ReactJSX: unknown }
  typescriptDefaults: {
    setCompilerOptions(opts: unknown): void
    setDiagnosticsOptions(opts: unknown): void
    setEagerModelSync(enabled: boolean): void
  }
  javascriptDefaults: {
    setCompilerOptions(opts: unknown): void
    setDiagnosticsOptions(opts: unknown): void
    setEagerModelSync(enabled: boolean): void
  }
}

const monacoTypescript = (monaco.languages as unknown as { typescript: MonacoTypescriptApi }).typescript

// ── TypeScript LSP — configure once ───────────────────────────────────────────
let tsLspConfigured = false
function ensureTsLsp(): void {
  if (tsLspConfigured) return
  tsLspConfigured = true

  const sharedOpts = {
    target: monacoTypescript.ScriptTarget.ESNext,
    module: monacoTypescript.ModuleKind.ESNext,
    moduleResolution: monacoTypescript.ModuleResolutionKind.NodeJs,
    lib: ['es2022', 'dom', 'dom.iterable'],
    strict: false,         // loose — files are opened individually, not as a project
    allowJs: true,
    checkJs: false,
    jsx: monacoTypescript.JsxEmit.ReactJSX,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    noEmit: true,
  }
  monacoTypescript.typescriptDefaults.setCompilerOptions(sharedOpts)
  monacoTypescript.javascriptDefaults.setCompilerOptions(sharedOpts)

  const diagOpts = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // Don't flag missing imports — we only have single-file context
    diagnosticCodesToIgnore: [2792, 2307, 2304, 2305],
  }
  monacoTypescript.typescriptDefaults.setDiagnosticsOptions(diagOpts)
  monacoTypescript.javascriptDefaults.setDiagnosticsOptions(diagOpts)

  // Enable eager model sync so hover / completions respond faster
  monacoTypescript.typescriptDefaults.setEagerModelSync(true)
  monacoTypescript.javascriptDefaults.setEagerModelSync(true)
}

// ── Theme ─────────────────────────────────────────────────────────────────────
// Syntax token colors mirror VS Code Dark+ theme exactly.
function buildMonacoTheme(): monaco.editor.IStandaloneThemeData {
  const s = getComputedStyle(document.documentElement)
  const g = (v: string) => s.getPropertyValue(v).trim() || undefined
  return {
    base: 'vs-dark',
    inherit: true,
    // Token rules override VS Code Dark+ defaults where our theme deviates.
    rules: [
      { token: 'keyword',                  foreground: '569cd6', fontStyle: 'bold' },
      { token: 'keyword.control',          foreground: 'c586c0' },
      { token: 'keyword.operator',         foreground: 'd4d4d4' },
      { token: 'string',                   foreground: 'ce9178' },
      { token: 'string.escape',            foreground: 'd7ba7d' },
      { token: 'comment',                  foreground: '6a9955', fontStyle: 'italic' },
      { token: 'comment.doc',              foreground: '6a9955', fontStyle: 'italic' },
      { token: 'number',                   foreground: 'b5cea8' },
      { token: 'regexp',                   foreground: 'd16969' },
      { token: 'type',                     foreground: '4ec9b0' },
      { token: 'type.identifier',          foreground: '4ec9b0' },
      { token: 'class',                    foreground: '4ec9b0' },
      { token: 'interface',                foreground: '4ec9b0' },
      { token: 'enum',                     foreground: '4ec9b0' },
      { token: 'function',                 foreground: 'dcdcaa' },
      { token: 'method',                   foreground: 'dcdcaa' },
      { token: 'identifier',               foreground: '9cdcfe' },
      { token: 'variable',                 foreground: '9cdcfe' },
      { token: 'variable.readonly',        foreground: '4fc1ff' },
      { token: 'parameter',                foreground: '9cdcfe' },
      { token: 'property',                 foreground: '9cdcfe' },
      { token: 'property.declaration',     foreground: '9cdcfe' },
      { token: 'operator',                 foreground: 'd4d4d4' },
      { token: 'punctuation',              foreground: 'd4d4d4' },
      { token: 'delimiter',                foreground: 'd4d4d4' },
      { token: 'tag',                      foreground: '569cd6' },
      { token: 'tag.html',                 foreground: '569cd6' },
      { token: 'attribute.name',           foreground: '9cdcfe' },
      { token: 'attribute.value',          foreground: 'ce9178' },
      { token: 'constant',                 foreground: '4fc1ff' },
      { token: 'constant.language',        foreground: '569cd6' },
      { token: 'support',                  foreground: 'dcdcaa' },
      { token: 'namespace',                foreground: 'd4d4d4' },
      { token: 'decorator',                foreground: 'dcdcaa' },
      { token: 'annotation',               foreground: 'dcdcaa' },
    ],
    colors: {
      'editor.background':                   g('--bg-base') ?? '#1e1e1e',
      'editor.foreground':                   g('--text-primary') ?? '#d4d4d4',
      'editor.selectionBackground':          g('--bg-selected') ?? '#264f78',
      'editor.inactiveSelectionBackground':  '#3a3d41',
      'editor.lineHighlightBackground':      g('--bg-inset') ?? '#2a2d2e',
      'editor.lineHighlightBorder':          '#00000000',
      'editorLineNumber.foreground':         g('--text-muted') ?? '#858585',
      'editorLineNumber.activeForeground':   g('--text-secondary') ?? '#c6c6c6',
      'editorCursor.foreground':             g('--accent-fg') ?? '#aeafad',
      'editorWhitespace.foreground':         '#3b3b3b',
      'editorIndentGuide.background1':        '#404040',
      'editorIndentGuide.activeBackground1':  '#707070',
      'editorBracketMatch.background':       '#0064001a',
      'editorBracketMatch.border':           '#888888',
      'editorWidget.background':             g('--bg-overlay') ?? '#252526',
      'editorWidget.border':                 g('--border-default') ?? '#454545',
      'editorSuggestWidget.background':      g('--bg-overlay') ?? '#252526',
      'editorSuggestWidget.border':          g('--border-default') ?? '#454545',
      'editorSuggestWidget.selectedBackground': g('--bg-selected') ?? '#094771',
      'editorHoverWidget.background':        g('--bg-overlay') ?? '#252526',
      'editorHoverWidget.border':            g('--border-default') ?? '#454545',
      'editorGutter.background':             g('--bg-base') ?? '#1e1e1e',
      'editorError.foreground':              '#f44747',
      'editorWarning.foreground':            '#cca700',
      'editorInfo.foreground':               '#3794ff',
      'scrollbar.shadow':                    '#000000',
      'scrollbarSlider.background':          (g('--border-muted') ?? '#424242') + '80',
      'scrollbarSlider.hoverBackground':     (g('--border-default') ?? '#5a5a5a') + 'cc',
      'scrollbarSlider.activeBackground':    (g('--border-default') ?? '#5a5a5a') + 'ff',
      'peekViewEditor.background':           '#001f33',
      'peekViewResult.background':           '#252526',
      'peekViewTitle.background':            '#1e1e1e',
    },
  }
}

// ── Language mapping ───────────────────────────────────────────────────────────
function normalizeLanguage(lang: string): string {
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
    java: 'java', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c', cs: 'csharp', php: 'php',
    md: 'markdown', mdx: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'ini',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    vue: 'html', svelte: 'html',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    html: 'html', xml: 'xml', svg: 'xml',
    sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile', Dockerfile: 'dockerfile',
    makefile: 'makefile', Makefile: 'makefile',
    swift: 'swift', kt: 'kotlin', dart: 'dart',
    lua: 'lua', r: 'r', jl: 'julia',
    tf: 'hcl', hcl: 'hcl',
  }
  return map[lang] ?? lang
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  if (!containerEl.value) return

  ensureTsLsp()
  monaco.editor.defineTheme('agent-theme', buildMonacoTheme())

  editor = monaco.editor.create(containerEl.value, {
    value: props.modelValue,
    language: normalizeLanguage(props.language),
    theme: 'agent-theme',
    automaticLayout: true,
    // ── Appearance (VS Code Dark+ parity) ─────────────────────────────────────
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
    fontLigatures: true,
    lineHeight: 20,
    letterSpacing: 0,
    renderWhitespace: 'selection',
    renderLineHighlight: 'line',
    // ── Scrolling ─────────────────────────────────────────────────────────────
    scrollBeyondLastLine: true,
    scrollBeyondLastColumn: 5,
    smoothScrolling: true,
    // ── Gutter ────────────────────────────────────────────────────────────────
    glyphMargin: true,
    folding: true,
    foldingHighlight: true,
    foldingStrategy: 'auto',
    showFoldingControls: 'mouseover',
    lineDecorationsWidth: 6,
    lineNumbersMinChars: 3,
    overviewRulerLanes: 3,
    overviewRulerBorder: false,
    // ── Bracket / indent guides ────────────────────────────────────────────────
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    guides: {
      bracketPairs: true,
      indentation: true,
      highlightActiveIndentation: true,
      bracketPairsHorizontal: 'active',
    },
    matchBrackets: 'always',
    // ── Selection / occurrences ───────────────────────────────────────────────
    selectionHighlight: true,
    occurrencesHighlight: 'singleFile',
    wordBasedSuggestions: 'currentDocument',
    // ── Hover (type info) ─────────────────────────────────────────────────────
    hover: { enabled: true, delay: 300, sticky: true },
    // ── Suggest / intellisense ────────────────────────────────────────────────
    suggest: {
      insertMode: 'replace',
      snippetsPreventQuickSuggestions: false,
      showWords: true,
      showSnippets: true,
      preview: true,
      previewMode: 'prefix',
    },
    quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
    acceptSuggestionOnEnter: 'on',
    tabCompletion: 'on',
    // ── Sticky scroll ─────────────────────────────────────────────────────────
    stickyScroll: { enabled: true, maxLineCount: 5 },
    // ── Other ─────────────────────────────────────────────────────────────────
    wordWrap: 'off',
    codeLens: false,
    contextmenu: true,
    fixedOverflowWidgets: true,
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: true,
    links: true,
    colorDecorators: true,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
    // Inline suggestions (ghost text — Phase 3)
    inlineSuggest: { enabled: true, mode: 'prefix', showToolbar: 'onHover' },
  })

  decorationColl = editor.createDecorationsCollection([])

  // Ghost text via InlineCompletionsProvider
  inlineDisposer = monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions(model, position) {
      if (!pendingGhost || editor?.getModel() !== model) return { items: [] }
      return {
        items: [{
          insertText: pendingGhost,
          range: new monaco.Range(
            position.lineNumber, position.column,
            position.lineNumber, position.column,
          ),
        }],
        enableForwardStability: true,
      }
    },
    disposeInlineCompletions() {},
  })

  // Emit content changes
  editor.onDidChangeModelContent(() => {
    if (ignoreNextModelChange) { ignoreNextModelChange = false; return }
    emit('update:modelValue', editor!.getValue())
  })

  // Emit cursor position changes
  editor.onDidChangeCursorPosition((e) => {
    emit('cursor-change', {
      line: e.position.lineNumber - 1,
      col: e.position.column - 1,
    })
  })

  // Override keybindings that EditorPane handles at window level
  // Cmd+F → EditorPane's own find widget
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {})
  // Cmd+S → EditorPane save handler
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {})
  // Cmd+Alt+F → EditorPane find (replace) handler. (Cmd+H is intentionally NOT
  // overridden so it stays the macOS "Hide application" shortcut.)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {})

  // Apply initial diagnostics
  if (props.diagnostics?.length) applyDiagnostics(props.diagnostics)
})

onBeforeUnmount(() => {
  inlineDisposer?.dispose()
  editor?.dispose()
  editor = null
  decorationColl = null
})

// ── Watchers ──────────────────────────────────────────────────────────────────
watch(() => props.modelValue, (v) => {
  if (!editor || editor.getValue() === v) return
  ignoreNextModelChange = true
  const pos = editor.getPosition()
  editor.setValue(v)
  if (pos) editor.setPosition(pos)
})

watch(() => props.language, (lang) => {
  const model = editor?.getModel()
  if (model) monaco.editor.setModelLanguage(model, normalizeLanguage(lang))
})

watch(() => props.diagnostics, (diags) => {
  applyDiagnostics(diags ?? [])
}, { deep: true })

// ── Diagnostics ───────────────────────────────────────────────────────────────
function applyDiagnostics(
  diags: Array<{ line: number; col: number; endLine?: number; severity: string; message: string; source?: string }>
): void {
  const model = editor?.getModel()
  if (!model) return
  const severityMap: Record<string, monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
  }
  monaco.editor.setModelMarkers(model, 'diagnostics', diags.map((d) => ({
    startLineNumber: d.line + 1,
    startColumn: d.col + 1,
    endLineNumber: (d.endLine ?? d.line) + 1,
    endColumn: model.getLineLength((d.endLine ?? d.line) + 1) + 1,
    severity: severityMap[d.severity] ?? monaco.MarkerSeverity.Info,
    message: d.message,
    source: d.source,
  })))
}

// ── Decoration helpers ────────────────────────────────────────────────────────
function setDecorations(decs: Decoration[]): void {
  if (!decorationColl) return
  const items: monaco.editor.IModelDeltaDecoration[] = decs.map((d) => {
    const classMap: Record<string, string> = {
      'highlight': d.className ?? 'ev-dec-highlight',
      'line-add': 'ev-dec-line-add',
      'line-del': 'ev-dec-line-del',
      'inline-add': 'ev-dec-inline-add',
      'inline-del': 'ev-dec-inline-del',
    }
    const cls = classMap[d.type] ?? 'ev-dec-highlight'
    const isLine = d.type === 'line-add' || d.type === 'line-del'
    return {
      range: new monaco.Range(
        d.range.start.line + 1, d.range.start.col + 1,
        d.range.end.line + 1, d.range.end.col + 1,
      ),
      options: {
        isWholeLine: isLine,
        className: cls,
        inlineClassName: isLine ? undefined : cls,
        overviewRuler: isLine ? { color: d.type === 'line-add' ? '#4ec94e' : '#f44747', position: monaco.editor.OverviewRulerLane.Left } : undefined,
      },
    }
  })
  decorationColl.set(items)
}

// ── Text transform helper ─────────────────────────────────────────────────────
function transformSelection(fn: (text: string) => string): void {
  const sel = editor?.getSelection()
  const model = editor?.getModel()
  if (!sel || !model) return
  const text = model.getValueInRange(sel)
  editor!.executeEdits('transform', [{ range: sel, text: fn(text) }])
}

// ── Exposed API ───────────────────────────────────────────────────────────────
// Core
function getValue(): string { return editor?.getValue() ?? '' }
function setValue(v: string): void { editor?.setValue(v) }
function focus(): void { editor?.focus() }
function getCursor(): { line: number; col: number } {
  const pos = editor?.getPosition()
  return { line: (pos?.lineNumber ?? 1) - 1, col: (pos?.column ?? 1) - 1 }
}
function getCursorLine(): number { return (editor?.getPosition()?.lineNumber ?? 1) - 1 }

// Selection
function getSelectionText(): string {
  const sel = editor?.getSelection()
  if (!sel || sel.isEmpty()) return ''
  return editor?.getModel()?.getValueInRange(sel) ?? ''
}
function getSelectionRange(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
  const sel = editor?.getSelection()
  if (!sel || sel.isEmpty()) return null
  return {
    startLine: sel.startLineNumber - 1, startCol: sel.startColumn - 1,
    endLine: sel.endLineNumber - 1, endCol: sel.endColumn - 1,
  }
}
function setSelection(from: { line: number; col: number }, to: { line: number; col: number }): void {
  editor?.setSelection(new monaco.Range(from.line + 1, from.col + 1, to.line + 1, to.col + 1))
}
function selectAll(): void { editor?.trigger('', 'selectAll', null) }
function selectLine(): void { editor?.trigger('', 'expandLineSelection', null) }
function selectCurrentWord(): void { editor?.trigger('', 'editor.action.addSelectionToNextFindMatch', null) }
function selectNextOccurrence(): void { editor?.trigger('', 'editor.action.addSelectionToNextFindMatch', null) }
function expandSelection(): void { editor?.trigger('', 'editor.action.smartSelect.expand', null) }
function shrinkSelection(): void { editor?.trigger('', 'editor.action.smartSelect.shrink', null) }
function insertCursorAbove(): void { editor?.trigger('', 'editor.action.insertCursorAbove', null) }
function insertCursorBelow(): void { editor?.trigger('', 'editor.action.insertCursorBelow', null) }
function addCursorsToLineEnds(): void { editor?.trigger('', 'editor.action.insertCursorAtEndOfEachLineSelected', null) }

// Navigation
function revealLine(line: number): void { editor?.revealLineInCenterIfOutsideViewport(line + 1) }
function revealPosition(line: number, col: number): void {
  editor?.revealPositionInCenterIfOutsideViewport({ lineNumber: line + 1, column: col + 1 })
}
function cursorTop(): void { editor?.trigger('', 'cursorTop', null) }
function cursorBottom(): void { editor?.trigger('', 'cursorBottom', null) }
function cursorTopSelect(): void { editor?.trigger('', 'cursorTopSelect', null) }
function cursorBottomSelect(): void { editor?.trigger('', 'cursorBottomSelect', null) }
function cursorWordLeft(): void { editor?.trigger('', 'cursorWordLeft', null) }
function cursorWordRight(): void { editor?.trigger('', 'cursorWordRight', null) }
function cursorWordLeftSelect(): void { editor?.trigger('', 'cursorWordLeftSelect', null) }
function cursorWordRightSelect(): void { editor?.trigger('', 'cursorWordRightSelect', null) }
function cursorLineStart(): void { editor?.trigger('', 'cursorHome', null) }
function cursorLineEnd(): void { editor?.trigger('', 'cursorEnd', null) }
function cursorLineStartSelect(): void { editor?.trigger('', 'cursorHomeSelect', null) }
function cursorLineEndSelect(): void { editor?.trigger('', 'cursorEndSelect', null) }
function scrollLineUp(): void { editor?.trigger('', 'scrollLineUp', null) }
function scrollLineDown(): void { editor?.trigger('', 'scrollLineDown', null) }
function jumpToBracket(): void { editor?.trigger('', 'editor.action.jumpToBracket', null) }
function selectToBracket(): void { editor?.trigger('', 'editor.action.selectToBracket', null) }

// Edit operations
function insertText(text: string): void { editor?.trigger('keyboard', 'type', { text }) }
function applyEditExternal(range: { start: { line: number; col: number }; end: { line: number; col: number } }, newText: string): void {
  const model = editor?.getModel()
  if (!model) return
  ignoreNextModelChange = true
  model.pushEditOperations([], [{
    range: new monaco.Range(range.start.line + 1, range.start.col + 1, range.end.line + 1, range.end.col + 1),
    text: newText,
  }], () => null)
  emit('update:modelValue', model.getValue())
}
function undo(): void { editor?.trigger('', 'undo', null) }
function redo(): void { editor?.trigger('', 'redo', null) }
function deleteLine(): void { editor?.trigger('', 'editor.action.deleteLines', null) }
function insertLineBelow(): void { editor?.trigger('', 'editor.action.insertLineAfter', null) }
function insertLineAbove(): void { editor?.trigger('', 'editor.action.insertLineBefore', null) }
function deleteWordLeft(): void { editor?.trigger('', 'deleteWordLeft', null) }
function deleteWordRight(): void { editor?.trigger('', 'deleteWordRight', null) }
function deleteLineLeft(): void { editor?.trigger('', 'deleteAllLeft', null) }
function deleteLineRight(): void { editor?.trigger('', 'deleteAllRight', null) }
function moveLineUp(): void { editor?.trigger('', 'editor.action.moveLinesUpAction', null) }
function moveLineDown(): void { editor?.trigger('', 'editor.action.moveLinesDownAction', null) }
function duplicateLineDown(): void { editor?.trigger('', 'editor.action.copyLinesDownAction', null) }
function duplicateLineUp(): void { editor?.trigger('', 'editor.action.copyLinesUpAction', null) }

// Indent / comment
function indentLine(): void { editor?.trigger('', 'editor.action.indentLines', null) }
function dedentLine(): void { editor?.trigger('', 'editor.action.outdentLines', null) }
function toggleLineComment(): void { editor?.trigger('', 'editor.action.commentLine', null) }
function addLineComment(): void { editor?.trigger('', 'editor.action.addCommentLine', null) }
function removeLineComment(): void { editor?.trigger('', 'editor.action.removeCommentLine', null) }
function toggleBlockComment(): void { editor?.trigger('', 'editor.action.blockComment', null) }
function joinLines(): void { editor?.trigger('', 'editor.action.joinLines', null) }
function trimTrailingWhitespace(): void { editor?.trigger('', 'editor.action.trimTrailingWhitespace', null) }

// Format
function formatDocument(): void { editor?.trigger('', 'editor.action.formatDocument', null) }
function formatSelection(): void { editor?.trigger('', 'editor.action.formatSelection', null) }

// Fold
function foldAt(_line: number): void { editor?.trigger('', 'editor.fold', null) }
function unfoldAt(_line: number): void { editor?.trigger('', 'editor.unfold', null) }
function toggleFoldAt(_line: number): void { editor?.trigger('', 'editor.toggleFold', null) }
function foldAll(): void { editor?.trigger('', 'editor.foldAll', null) }
function unfoldAll(): void { editor?.trigger('', 'editor.unfoldAll', null) }
function foldToLevel(level: number): void { editor?.trigger('', `editor.foldLevel${Math.min(level, 7)}`, null) }
function foldRecursively(line?: number): void {
  if (line !== undefined) editor?.setPosition({ lineNumber: line + 1, column: 1 })
  editor?.trigger('', 'editor.foldRecursively', null)
}
function unfoldRecursively(line?: number): void {
  if (line !== undefined) editor?.setPosition({ lineNumber: line + 1, column: 1 })
  editor?.trigger('', 'editor.unfoldRecursively', null)
}

// Text transforms
function transformToUppercase(): void { editor?.trigger('', 'editor.action.transformToUppercase', null) }
function transformToLowercase(): void { editor?.trigger('', 'editor.action.transformToLowercase', null) }
function transformToTitleCase(): void { editor?.trigger('', 'editor.action.transformToTitlecase', null) }
function transformToSnakeCase(): void { transformSelection(toSnakeCase) }
function transformToCamelCase(): void { transformSelection(toCamelCase) }
function transformToKebabCase(): void { transformSelection(toKebabCase) }
function transformToPascalCase(): void { transformSelection(toPascalCase) }
function transformToBase64(): void {
  transformSelection((t) => btoa(unescape(encodeURIComponent(t))))
}
function transformFromBase64(): void {
  transformSelection((t) => { try { return decodeURIComponent(escape(atob(t.trim()))) } catch { return t } })
}
function transformToUrlEncoded(): void { transformSelection(encodeURIComponent) }
function transformFromUrlEncoded(): void {
  transformSelection((t) => { try { return decodeURIComponent(t) } catch { return t } })
}

// Sort / dedupe / reverse
function sortLinesAscending(): void { editor?.trigger('', 'editor.action.sortLinesAscending', null) }
function sortLinesDescending(): void { editor?.trigger('', 'editor.action.sortLinesDescending', null) }
function reverseLines(): void {
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty()) return
  const start = sel.startLineNumber; const end = sel.endLineNumber
  const lines = Array.from({ length: end - start + 1 }, (_, i) => model.getLineContent(start + i))
  const reversed = lines.reverse().join('\n')
  editor!.executeEdits('reverseLines', [{
    range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
    text: reversed,
  }])
}
function removeDuplicateLines(): void {
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty()) return
  const start = sel.startLineNumber; const end = sel.endLineNumber
  const lines = Array.from({ length: end - start + 1 }, (_, i) => model.getLineContent(start + i))
  const seen = new Set<string>()
  const deduped = lines.filter((l) => { if (seen.has(l)) return false; seen.add(l); return true })
  editor!.executeEdits('removeDuplicates', [{
    range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
    text: deduped.join('\n'),
  }])
}
function transpose(): void {
  const model = editor?.getModel()
  const pos = editor?.getPosition()
  if (!model || !pos) return
  const line = model.getLineContent(pos.lineNumber)
  const col = pos.column - 1
  if (col < 1 || col >= line.length) return
  const swapped = line.slice(0, col - 1) + line[col] + line[col - 1] + line.slice(col + 1)
  editor!.executeEdits('transpose', [{
    range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1),
    text: swapped,
  }])
}

// Indentation conversion
function indentationToSpaces(): void {
  editor?.updateOptions({ insertSpaces: true })
  editor?.trigger('', 'editor.action.indentationToSpaces', null)
}
function indentationToTabs(): void {
  editor?.updateOptions({ insertSpaces: false })
  editor?.trigger('', 'editor.action.indentationToTabs', null)
}

// Link
function openLinkAtCursor(): void { editor?.trigger('', 'editor.action.openLink', null) }

// Zoom
function zoomIn(): void {
  const cur = editor?.getOption(monaco.editor.EditorOption.fontSize) ?? 13
  editor?.updateOptions({ fontSize: Math.min(cur + 1, 32) })
}
function zoomOut(): void {
  const cur = editor?.getOption(monaco.editor.EditorOption.fontSize) ?? 13
  editor?.updateOptions({ fontSize: Math.max(cur - 1, 8) })
}
function zoomReset(): void { editor?.updateOptions({ fontSize: 13 }) }

// Line numbers
function toggleLineNumbers(): void {
  const cur = editor?.getOption(monaco.editor.EditorOption.lineNumbers)
  const show = String(cur) !== 'on'
  editor?.updateOptions({ lineNumbers: show ? 'on' : 'off' })
}

// Tab / space settings
function setTabSize(size: number): void { editor?.getModel()?.updateOptions({ tabSize: size }) }
function setUseSpaces(use: boolean): void { editor?.getModel()?.updateOptions({ insertSpaces: use }) }
function getTabSize(): number { return editor?.getModel()?.getOptions().tabSize ?? 2 }
function getUseSpaces(): boolean { return editor?.getModel()?.getOptions().insertSpaces ?? true }

// Word info
function getWordAtCursor(): string {
  const pos = editor?.getPosition()
  const model = editor?.getModel()
  if (!pos || !model) return ''
  return model.getWordAtPosition(pos)?.word ?? ''
}

// Ghost text (Phase 3 — InlineCompletionsProvider)
function setGhost(text: string | null): void {
  pendingGhost = text
  if (text) editor?.trigger('', 'editor.action.inlineSuggest.trigger', null)
  else editor?.trigger('', 'editor.action.inlineSuggest.hide', null)
}
function acceptGhost(): void {
  editor?.trigger('', 'editor.action.inlineSuggest.commit', null)
  pendingGhost = null
}

defineExpose({
  getValue, setValue, focus, getCursor, getCursorLine,
  getSelectionText, getSelectionRange, setSelection,
  selectAll, selectLine, selectCurrentWord, selectNextOccurrence,
  expandSelection, shrinkSelection,
  insertCursorAbove, insertCursorBelow, addCursorsToLineEnds,
  revealLine, revealPosition,
  cursorTop, cursorBottom, cursorTopSelect, cursorBottomSelect,
  cursorWordLeft, cursorWordRight, cursorWordLeftSelect, cursorWordRightSelect,
  cursorLineStart, cursorLineEnd, cursorLineStartSelect, cursorLineEndSelect,
  scrollLineUp, scrollLineDown,
  jumpToBracket, selectToBracket,
  insertText, applyEditExternal,
  undo, redo,
  deleteLine, insertLineBelow, insertLineAbove,
  deleteWordLeft, deleteWordRight, deleteLineLeft, deleteLineRight,
  moveLineUp, moveLineDown, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine,
  toggleLineComment, addLineComment, removeLineComment, toggleBlockComment,
  joinLines, trimTrailingWhitespace,
  formatDocument, formatSelection,
  foldAt, unfoldAt, toggleFoldAt, foldAll, unfoldAll, foldToLevel, foldRecursively, unfoldRecursively,
  transformToUppercase, transformToLowercase, transformToTitleCase,
  transformToSnakeCase, transformToCamelCase, transformToKebabCase, transformToPascalCase,
  transformToBase64, transformFromBase64, transformToUrlEncoded, transformFromUrlEncoded,
  sortLinesAscending, sortLinesDescending, reverseLines, removeDuplicateLines,
  transpose, indentationToSpaces, indentationToTabs,
  openLinkAtCursor,
  zoomIn, zoomOut, zoomReset, toggleLineNumbers,
  setTabSize, setUseSpaces, getTabSize, getUseSpaces,
  getWordAtCursor,
  setDecorations, setGhost, acceptGhost,
})
</script>

<template>
  <div ref="containerEl" class="editor-view-monaco" />
</template>

<style>
/* Monaco decoration classes */
.ev-dec-highlight { background: rgba(255, 213, 60, 0.3); border-radius: 2px; }
.ev-dec-current { background: rgba(255, 140, 0, 0.5); border-radius: 2px; }
.ev-dec-line-add { background: rgba(78, 201, 78, 0.15); }
.ev-dec-line-del { background: rgba(244, 71, 71, 0.15); }
.ev-dec-inline-add { background: rgba(78, 201, 78, 0.3); }
.ev-dec-inline-del { background: rgba(244, 71, 71, 0.3); text-decoration: line-through; }
</style>

<style scoped>
.editor-view-monaco {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
