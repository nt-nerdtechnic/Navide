export interface ParsedKey {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string // normalized lowercase, e.g. 's', 'escape', 'arrowup'
}

export interface KeybindingRule {
  key: string     // e.g. "cmd+s" or chord "ctrl+k ctrl+s"
  command: string // e.g. "editor.action.save"
  when?: string   // e.g. "editorTextFocus && !modalOpen"
  args?: unknown
}

export type CommandHandler = (args?: unknown) => void | Promise<void>
