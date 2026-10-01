import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'

/**
 * OS sandbox for third-party package backends.
 *
 * A third-party backend is someone else's native code, so it never runs
 * directly: it runs under the platform sandbox built here, or not at all.
 * There is no unsandboxed fallback - a platform without a usable sandbox
 * reports `available: false` and the Host refuses to start the child.
 *
 * What each platform contains (see the third-party-plugin-backend plan):
 * - macOS (verified): Seatbelt via `sandbox-exec`, deny-by-default. The child
 *   reads its own package and private data directory, writes only the data
 *   directory, has no network (not even loopback), no user home, no Keychain.
 *   Children it spawns inherit the same sandbox.
 * - Linux (unverified on real hosts): bubblewrap with every namespace
 *   unshared, including the network. Only the system `bwrap` is used, and only
 *   when a probe proves unprivileged namespaces work on this host.
 * - Windows: deferred to v1.1 (AppContainer needs a native helper), so it is
 *   always unavailable.
 * Neither sandbox limits CPU or memory; the resource watchdog does that.
 */

export type BackendSandboxKind = 'seatbelt' | 'bubblewrap'

export interface BackendSandboxPaths {
  /** Canonical, Host-owned package directory (read-only for the child). */
  packageDir: string
  /** Canonical private data directory (the only writable location). */
  dataDir: string
  /** Executable inside packageDir. */
  entryFile: string
  /** The user's real home; its sensitive entries are hidden even from stat. */
  homeDir?: string
}

export type BackendSandboxResolution =
  | { available: true; kind: BackendSandboxKind; command: string; args: string[] }
  | { available: false; reason: string }

export interface BackendSandboxProbe {
  platform: NodeJS.Platform
  /** Absolute path of a usable `sandbox-exec`, or null. */
  sandboxExec(): string | null
  /** Absolute path of a system `bwrap` that passed a namespace probe, or null. */
  bubblewrap(): string | null
}

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap']

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedBubblewrap: string | null | undefined

/** Default probe for the running Host. The bwrap probe runs once per process. */
export function createHostSandboxProbe(platform: NodeJS.Platform = process.platform): BackendSandboxProbe {
  return {
    platform,
    sandboxExec: () => (platform === 'darwin' && isExecutable(SANDBOX_EXEC_PATH) ? SANDBOX_EXEC_PATH : null),
    bubblewrap: () => {
      if (platform !== 'linux') return null
      if (cachedBubblewrap !== undefined) return cachedBubblewrap
      cachedBubblewrap = null
      for (const candidate of BWRAP_CANDIDATES) {
        if (!isExecutable(candidate)) continue
        // Ubuntu 23.10+ restricts unprivileged user namespaces through
        // AppArmor; only an actual run proves this bwrap can create them.
        const probe = spawnSync(
          candidate,
          ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', 'true'],
          { stdio: 'ignore', timeout: 5_000 },
        )
        if (probe.status === 0) {
          cachedBubblewrap = candidate
          break
        }
      }
      return cachedBubblewrap
    },
  }
}

/** Reject paths the profile/argument encoders cannot represent safely. */
function assertSandboxPath(path: string): void {
  if (!path.startsWith('/') || /[\0-\x1f\x7f]/.test(path)) {
    throw new Error('sandbox path must be absolute and free of control characters')
  }
}

function sbplString(value: string): string {
  assertSandboxPath(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Home locations whose existence and metadata the backend must not see.
 * `bsd.sb` grants file-read-metadata everywhere; denying it under all of /Users
 * or /private/tmp makes a real PyInstaller backend exit 255 at start (measured
 * 2026-10-01), so only these known-sensitive locations are hidden. */
export const SENSITIVE_HOME_ENTRIES = [
  '.ssh', '.aws', '.gnupg', '.config', '.kube', '.docker', '.netrc', '.claude', '.codex',
  'Library/Keychains', 'Documents', 'Downloads',
] as const

function sensitiveMetadataDenial(homeDir: string | undefined): string[] {
  if (!homeDir) return []
  const targets = SENSITIVE_HOME_ENTRIES.map((entry) => `(subpath ${sbplString(`${homeDir}/${entry}`)})`)
  return [`(deny file-read-metadata ${targets.join(' ')})`]
}

/**
 * Seatbelt profile for one backend. Measured against a real PyInstaller
 * one-file backend: it needs fork, exec of its own package (it re-executes
 * itself), executable mapping of its package and extraction directory, and
 * SysV semaphores for its loader sync. Exec is limited to the package so every
 * process in the sandbox runs an image from it, which is how the Host finds
 * processes that escaped the tree (see pluginBackendResourceWatchdog.ts).
 * `bsd.sb` supplies the minimal system library and sysctl access; it grants
 * no network, user files or Keychain services.
 */
export function buildSeatbeltProfile(
  paths: Pick<BackendSandboxPaths, 'packageDir' | 'dataDir' | 'homeDir'>,
): string {
  const pkg = sbplString(paths.packageDir)
  const data = sbplString(paths.dataDir)
  return [
    '(version 1)',
    '(deny default)',
    '(import "bsd.sb")',
    ...sensitiveMetadataDenial(paths.homeDir),
    '(allow process-fork)',
    `(allow process-exec (subpath ${pkg}))`,
    `(allow file-read* (subpath ${pkg}) (subpath ${data}))`,
    `(allow file-write* (subpath ${data}))`,
    `(allow file-map-executable (subpath ${pkg}) (subpath ${data}))`,
    '(allow ipc-sysv-sem)',
    '',
  ].join('\n')
}

/** bubblewrap argument vector (everything before the entry file). */
export function buildBubblewrapArgs(paths: BackendSandboxPaths): string[] {
  assertSandboxPath(paths.packageDir)
  assertSandboxPath(paths.dataDir)
  assertSandboxPath(paths.entryFile)
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', paths.packageDir, paths.packageDir,
    '--bind', paths.dataDir, paths.dataDir,
    '--chdir', paths.dataDir,
  ]
}

export function resolveBackendSandbox(
  paths: BackendSandboxPaths,
  probe: BackendSandboxProbe,
): BackendSandboxResolution {
  // Platform first: an unsupported platform is reported as such, never as a
  // path problem (Windows paths are not POSIX paths and need not be).
  if (probe.platform === 'win32') {
    return { available: false, reason: 'third-party backends are not supported on Windows yet' }
  }
  if (probe.platform !== 'darwin' && probe.platform !== 'linux') {
    return { available: false, reason: `no backend sandbox for platform ${probe.platform}` }
  }
  try {
    assertSandboxPath(paths.packageDir)
    assertSandboxPath(paths.dataDir)
    assertSandboxPath(paths.entryFile)
  } catch (error) {
    return { available: false, reason: (error as Error).message }
  }
  if (probe.platform === 'darwin') {
    const sandboxExec = probe.sandboxExec()
    if (!sandboxExec) return { available: false, reason: 'macOS sandbox-exec is unavailable' }
    return {
      available: true,
      kind: 'seatbelt',
      command: sandboxExec,
      args: ['-p', buildSeatbeltProfile(paths), paths.entryFile],
    }
  }
  const bwrap = probe.bubblewrap()
  if (!bwrap) {
    return {
      available: false,
      reason: 'bubblewrap is not installed or unprivileged user namespaces are disabled',
    }
  }
  return { available: true, kind: 'bubblewrap', command: bwrap, args: [...buildBubblewrapArgs(paths), '--', paths.entryFile] }
}

/** Environment every sandboxed child sees: the Host map with its home and
 * temporary directories pointed at the private data directory. */
export function sandboxedEnvironment(
  base: Readonly<Record<string, string>> | NodeJS.ProcessEnv | undefined,
  dataDir: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (typeof value === 'string') env[key] = value
  }
  const tmp = `${dataDir}/tmp`
  return {
    ...env,
    HOME: dataDir,
    TMPDIR: `${tmp}/`,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: `${dataDir}/cache`,
    XDG_CONFIG_HOME: `${dataDir}/config`,
    XDG_DATA_HOME: `${dataDir}/share`,
  }
}

/** Build the supervisor `spawnProcess` replacement for one resolved sandbox.
 * The supervisor's own entry argument must be the sandboxed entry; anything
 * else means the activation changed under us and is refused. */
export function sandboxedSpawnProcess(
  resolution: Extract<BackendSandboxResolution, { available: true }>,
  paths: BackendSandboxPaths,
  spawnImpl: typeof spawn = spawn,
): (entryFile: string, options: SpawnOptions) => ChildProcessWithoutNullStreams {
  return (entryFile, options) => {
    let canonicalEntry: string
    try {
      canonicalEntry = realpathSync(entryFile)
    } catch {
      canonicalEntry = ''
    }
    if (canonicalEntry !== paths.entryFile) {
      throw new Error('sandboxed backend entry does not match the admitted entry')
    }
    return spawnImpl(resolution.command, resolution.args, {
      ...options,
      shell: false,
      cwd: paths.dataDir,
      env: sandboxedEnvironment(options.env, paths.dataDir),
    }) as ChildProcessWithoutNullStreams
  }
}
