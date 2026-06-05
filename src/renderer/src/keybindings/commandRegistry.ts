import type { CommandHandler } from './types'

const _commands = new Map<string, CommandHandler>()

export function registerCommand(id: string, handler: CommandHandler): void {
  _commands.set(id, handler)
}

// Returns true if a handler was found and called.
export function executeCommand(id: string, args?: unknown): boolean {
  const handler = _commands.get(id)
  if (!handler) return false
  void handler(args)
  return true
}

export function hasCommand(id: string): boolean {
  return _commands.has(id)
}

// For testing only.
export function _resetRegistry(): void {
  _commands.clear()
}
