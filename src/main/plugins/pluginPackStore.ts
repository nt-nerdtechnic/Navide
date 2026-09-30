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

// Installed Extension Packs. A pack is never installed as a package: the Host
// installs its members one by one, each verified and confirmed on its own, and
// records here which pack the user installed and which members were installed
// only because of it (D8: uninstalling a pack offers to remove just those).
const PACKS_FILE = '.navide-plugin-packs.json'

export interface InstalledPackRecord {
  id: string
  /** The pack's display name when the Registry listing had one. */
  displayName?: string
  version: string
  members: string[]
  /** Members that were not installed before this pack installed them. */
  installedByPack: string[]
}

interface PersistedPackState {
  schemaVersion: 1
  packs: InstalledPackRecord[]
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0)
}

function readState(path: string): { state: PersistedPackState; valid: boolean } {
  const empty: PersistedPackState = { schemaVersion: 1, packs: [] }
  if (!existsSync(path)) return { state: empty, valid: true }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe pack store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.packs)) throw new Error('invalid state')
    const packs = parsed.packs.map((raw) => {
      const pack = raw as Record<string, unknown>
      if (
        typeof pack?.id !== 'string' ||
        typeof pack.version !== 'string' ||
        !isIdList(pack.members) ||
        !isIdList(pack.installedByPack) ||
        (pack.displayName !== undefined && typeof pack.displayName !== 'string')
      ) {
        throw new Error('invalid pack record')
      }
      return {
        id: pack.id,
        ...(typeof pack.displayName === 'string' ? { displayName: pack.displayName } : {}),
        version: pack.version,
        members: [...pack.members],
        installedByPack: [...pack.installedByPack],
      }
    })
    return { state: { schemaVersion: 1, packs }, valid: true }
  } catch {
    return { state: empty, valid: false }
  }
}

export class PluginPackStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, PACKS_FILE)
  }

  list(): InstalledPackRecord[] {
    const parsed = readState(this.file)
    if (!parsed.valid) console.warn(`[plugins] invalid extension pack records at ${this.file}; ignoring them`)
    return parsed.state.packs
  }

  get(id: string): InstalledPackRecord | null {
    return this.list().find((pack) => pack.id === id) ?? null
  }

  put(record: InstalledPackRecord): void {
    const packs = this.list().filter((pack) => pack.id !== record.id)
    this.write({ schemaVersion: 1, packs: [...packs, record] })
  }

  remove(id: string): InstalledPackRecord | null {
    const packs = this.list()
    const removed = packs.find((pack) => pack.id === id) ?? null
    if (removed) this.write({ schemaVersion: 1, packs: packs.filter((pack) => pack.id !== id) })
    return removed
  }

  private write(state: PersistedPackState): void {
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
