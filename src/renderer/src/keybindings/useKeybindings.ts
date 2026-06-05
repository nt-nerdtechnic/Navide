import { onMounted, onUnmounted } from 'vue'
import type { KeybindingRule } from './types'
import { defaults } from './defaults'
import { KeyResolver } from './keyResolver'
import { executeCommand, registerCommand } from './commandRegistry'
import { setContext, getContext } from './contextService'

export type { KeybindingRule }
export { registerCommand, executeCommand, setContext, getContext }

let _userRules: KeybindingRule[] = []
let _resolver = new KeyResolver(defaults)
let _refCount = 0

function buildResolver(): void {
  _resolver = new KeyResolver([...defaults, ..._userRules])
}

function handleKeydown(e: KeyboardEvent): void {
  const rule = _resolver.resolve(e, getContext())
  if (!rule) return
  if (executeCommand(rule.command, rule.args)) {
    e.stopPropagation()
    e.preventDefault()
  }
}

async function loadUserRulesFromIPC(): Promise<void> {
  const api = (window as Window & { agentTeam?: { readKeybindings?: () => Promise<{ ok: boolean; content?: string }> } }).agentTeam
  if (!api?.readKeybindings) return
  try {
    const result = await api.readKeybindings()
    if (result?.ok && result.content) {
      const parsed = JSON.parse(result.content)
      if (Array.isArray(parsed)) setUserRules(parsed as KeybindingRule[])
    }
  } catch { /* ignore parse or IPC errors */ }
}

// Call in root App setup() to install the capture-phase window listener.
// Individual components may also call useKeybindings() purely to registerCommand/setContext —
// the listener is shared; only the first mount actually attaches it.
export function useKeybindings() {
  onMounted(() => {
    if (_refCount === 0) {
      window.addEventListener('keydown', handleKeydown, { capture: true })
      void loadUserRulesFromIPC()
    }
    _refCount++
  })

  onUnmounted(() => {
    _refCount--
    if (_refCount === 0) {
      window.removeEventListener('keydown', handleKeydown, { capture: true })
      _resolver.resetChord()
    }
  })

  return { registerCommand, executeCommand, setContext, getContext }
}

// Load user-defined overrides (e.g. from userData/keybindings.json via IPC).
// Later rules take priority over defaults (Phase D wires this to IPC).
export function setUserRules(rules: KeybindingRule[]): void {
  _userRules = rules
  buildResolver()
}
