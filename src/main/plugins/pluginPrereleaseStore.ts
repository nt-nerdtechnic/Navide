import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'

// Per-extension "Get pre-releases" opt-ins (D2: per extension, default off).
// Only the update check and the Marketplace's install candidate read it; a
// missing or unreadable file means every extension stays on stable.
const PRERELEASE_FILE = '.navide-plugin-prereleases.json'

interface PersistedPrereleaseState {
  schemaVersion: 1
  pluginIds: string[]
}

function readState(path: string): { state: PersistedPrereleaseState; valid: boolean } {
  const empty: PersistedPrereleaseState = { schemaVersion: 1, pluginIds: [] }
  if (!existsSync(path)) return { state: empty, valid: true }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe pre-release store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.pluginIds) ||
      state.pluginIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new Error('invalid state')
    }
    return { state: { schemaVersion: 1, pluginIds: [...new Set(state.pluginIds as string[])] }, valid: true }
  } catch {
    return { state: empty, valid: false }
  }
}

export class PluginPrereleaseStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, PRERELEASE_FILE)
  }

  /** Every opted-in plugin id; empty (all stable) when the file is unusable. */
  list(): string[] {
    const parsed = readState(this.file)
    if (!parsed.valid) {
      console.warn(`[plugins] invalid pre-release preferences at ${this.file}; using stable for all`)
    }
    return parsed.state.pluginIds
  }

  has(pluginId: string): boolean {
    return this.list().includes(pluginId)
  }

  set(pluginId: string, enabled: boolean): void {
    if (!pluginId) throw new Error('invalid plugin id')
    const current = readState(this.file).state.pluginIds
    const next = enabled
      ? [...new Set([...current, pluginId])]
      : current.filter((id) => id !== pluginId)
    if (next.length === current.length && next.every((id, i) => id === current[i])) return
    this.write({ schemaVersion: 1, pluginIds: next })
  }

  private write(state: PersistedPrereleaseState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
