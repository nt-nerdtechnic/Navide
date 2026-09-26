/** Only durable miniIDE layout and search options move to Plugin Storage.
 * Terminal font, selected agent, PTY, scrollback and tab/session state keep
 * their existing owners. Legacy values remain intact for recovery. */
export const MINI_IDE_STORAGE_KEYS = [
  'ide-sidebar-width',
  'ide-ai-panel-width',
  'agentTeam.search.opts',
] as const

export type MiniIdeStorageKey = typeof MINI_IDE_STORAGE_KEYS[number]
