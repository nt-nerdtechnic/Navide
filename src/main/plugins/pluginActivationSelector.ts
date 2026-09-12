import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isPluginTargetCompatible } from './pluginTarget'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { parseHostTrustJsonObject } from './pluginTrustJson'
import { PLUGIN_ACTIVATION_DIR } from './pluginInstallPaths'

export interface PluginPackageSelection {
  packageVersion: string
  target: string
  artifactDigest: string
}

export interface PluginActivationSelectorRecord {
  schemaVersion: 1
  pluginId: string
  active?: PluginPackageSelection
  candidate?: PluginPackageSelection
  /** Explicit full-shell confirmation, retained only until candidate promotion. */
  candidateFullShellConfirmed?: true
  previous?: PluginPackageSelection
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('\\')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectorPath(root: string, pluginId: string): string {
  return join(root, PLUGIN_ACTIVATION_DIR, `${pluginId}.json`)
}

/** Canonical immutable package location. Candidate/active/previous are roles
 * selected in the lifecycle record, never directory names that move package
 * bytes between states. */
export function immutablePluginPackageDir(
  root: string,
  pluginId: string,
  packageVersion: string,
  target: string,
): string {
  if (!isValidManifestV2PluginId(pluginId) || !validVersion(packageVersion) || !isPluginTargetCompatible(target)) {
    throw new Error('invalid immutable plugin package identity')
  }
  return join(root, pluginId, packageVersion, target, 'package')
}

function validatePackage(value: unknown): PluginPackageSelection | undefined {
  if (value === undefined) return undefined
  if (
    !isObject(value) ||
    Object.keys(value).length !== 3 ||
    !validVersion(value.packageVersion) ||
    !isPluginTargetCompatible(value.target) ||
    !validDigest(value.artifactDigest)
  ) throw new Error('invalid plugin lifecycle package selector')
  return {
    packageVersion: value.packageVersion,
    target: value.target,
    artifactDigest: value.artifactDigest,
  }
}

function validateRecord(expectedPluginId: string, value: unknown): PluginActivationSelectorRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || value.pluginId !== expectedPluginId) {
    throw new Error('invalid plugin lifecycle selector')
  }
  const keys = Object.keys(value)
  if (
    !keys.includes('schemaVersion') ||
    !keys.includes('pluginId') ||
    keys.some((key) => ![
      'schemaVersion',
      'pluginId',
      'active',
      'candidate',
      'candidateFullShellConfirmed',
      'previous',
    ].includes(key)) ||
    (value.candidateFullShellConfirmed !== undefined && value.candidateFullShellConfirmed !== true) ||
    (value.candidateFullShellConfirmed === true && value.candidate === undefined)
  ) {
    throw new Error('invalid plugin lifecycle selector')
  }
  const active = validatePackage(value.active)
  const candidate = validatePackage(value.candidate)
  const previous = validatePackage(value.previous)
  return {
    schemaVersion: 1,
    pluginId: expectedPluginId,
    ...(active ? { active } : {}),
    ...(candidate ? { candidate } : {}),
    ...(value.candidateFullShellConfirmed === true ? { candidateFullShellConfirmed: true } : {}),
    ...(previous ? { previous } : {}),
  }
}

function writeAtomic(path: string, record: PluginActivationSelectorRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    const file = openSync(temporary, 'r')
    try { fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    const parent = openSync(dirname(path), 'r')
    try { fsyncSync(parent) } finally { closeSync(parent) }
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** The one durable lifecycle source of truth. Its projection selects the
 * package, router, and storage tiers together; no parallel selector exists. */
export class PluginActivationSelector {
  constructor(private readonly root: string) {}

  read(pluginId: string): PluginActivationSelectorRecord | null {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    const path = selectorPath(this.root, pluginId)
    if (!existsSync(path)) return null
    return validateRecord(pluginId, parseHostTrustJsonObject(readFileSync(path, 'utf8'), 'plugin lifecycle selector'))
  }

  /** Read valid Host-owned records for renderer inventory projection only.
   * Callers still independently verify package trust before activation. */
  list(): PluginActivationSelectorRecord[] {
    const directory = join(this.root, PLUGIN_ACTIVATION_DIR)
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    const records: PluginActivationSelectorRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const pluginId = name.slice(0, -'.json'.length)
      if (!isValidManifestV2PluginId(pluginId)) continue
      try {
        const record = this.read(pluginId)
        if (record) records.push(record)
      } catch {
        // A corrupt selector is never a candidate for presentation or activation.
      }
    }
    return records
  }

  packageDir(pluginId: string, selection: PluginPackageSelection): string {
    return immutablePluginPackageDir(this.root, pluginId, selection.packageVersion, selection.target)
  }

  stageCandidate(
    pluginId: string,
    candidate: PluginPackageSelection,
    options: { fullShellConfirmed?: boolean } = {},
  ): PluginActivationSelectorRecord {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    const candidateSelection = validatePackage(candidate)
    if (!candidateSelection) throw new Error('candidate package is required')
    const current = this.read(pluginId)
    if (current?.candidate && JSON.stringify(current.candidate) !== JSON.stringify(candidateSelection)) {
      throw new Error(`plugin ${pluginId} already has a staged candidate`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      ...(current?.active ? { active: current.active } : {}),
      candidate: candidateSelection,
      ...(options.fullShellConfirmed ? { candidateFullShellConfirmed: true as const } : {}),
      ...(current?.previous ? { previous: current.previous } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Atomically promote the staged package identity. The preceding active
   * identity becomes previous; package files and snapshots are retained. */
  activateCandidate(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.candidate) throw new Error(`plugin ${pluginId} has no staged candidate`)
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.candidate,
      ...(current.active ? { previous: current.active } : current.previous ? { previous: current.previous } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Explicit user removal is the only lifecycle path that clears its record. */
  clear(pluginId: string): void {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    try {
      unlinkSync(selectorPath(this.root, pluginId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
