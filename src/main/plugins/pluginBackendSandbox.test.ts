import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildBubblewrapArgs,
  buildSeatbeltProfile,
  createHostSandboxProbe,
  resolveBackendSandbox,
  sandboxedEnvironment,
  sandboxedSpawnProcess,
  SANDBOX_EXEC_PATH,
  type BackendSandboxProbe,
} from './pluginBackendSandbox'

const PATHS = {
  packageDir: '/plugins/acme.files/1.0.0',
  dataDir: '/data/acme.files',
  entryFile: '/plugins/acme.files/1.0.0/backend/acme-files',
}

function probe(overrides: Partial<BackendSandboxProbe>): BackendSandboxProbe {
  return { platform: 'darwin', sandboxExec: () => null, bubblewrap: () => null, ...overrides }
}

describe('resolveBackendSandbox', () => {
  it('lets the sandbox exec only its own package, and hides sensitive home metadata', () => {
    const profile = buildSeatbeltProfile({ ...PATHS, homeDir: '/Users/me' })
    expect(profile).toContain(`(allow process-exec (subpath "${PATHS.packageDir}"))`)
    expect(profile).not.toMatch(new RegExp(`process-exec[^\\n]*${PATHS.dataDir}`))
    expect(profile).toContain('(deny file-read-metadata (subpath "/Users/me/.ssh")')
    expect(profile).toContain('(subpath "/Users/me/Library/Keychains")')
    // The deny comes before the package/data allowances, which win for them.
    expect(profile.indexOf('deny file-read-metadata')).toBeLessThan(profile.indexOf('allow file-read*'))
    expect(buildSeatbeltProfile(PATHS)).not.toContain('file-read-metadata')
  })

  it('uses Seatbelt on macOS with a deny-by-default profile', () => {
    const resolved = resolveBackendSandbox(PATHS, probe({ sandboxExec: () => SANDBOX_EXEC_PATH }))
    expect(resolved).toMatchObject({ available: true, kind: 'seatbelt', command: SANDBOX_EXEC_PATH })
    if (!resolved.available) throw new Error('unreachable')
    expect(resolved.args[0]).toBe('-p')
    expect(resolved.args[2]).toBe(PATHS.entryFile)
    const profile = resolved.args[1]
    expect(profile).toContain('(deny default)')
    expect(profile).not.toMatch(/network/)
    expect(profile).toContain(`(allow file-write* (subpath "${PATHS.dataDir}"))`)
    expect(profile).not.toContain(`file-write* (subpath "${PATHS.packageDir}")`)
  })

  it('refuses to run on macOS without sandbox-exec', () => {
    expect(resolveBackendSandbox(PATHS, probe({}))).toEqual({
      available: false,
      reason: 'macOS sandbox-exec is unavailable',
    })
  })

  // Linux and Windows paths are unit-tested with mocked probes only; they have
  // not been run on a real Linux or Windows host (unverified).
  it('[unverified on Linux] uses bubblewrap with every namespace, including the network, unshared', () => {
    const resolved = resolveBackendSandbox(PATHS, probe({ platform: 'linux', bubblewrap: () => '/usr/bin/bwrap' }))
    expect(resolved).toMatchObject({ available: true, kind: 'bubblewrap', command: '/usr/bin/bwrap' })
    if (!resolved.available) throw new Error('unreachable')
    expect(resolved.args).toContain('--unshare-all')
    expect(resolved.args).toContain('--die-with-parent')
    expect(resolved.args).not.toContain('--share-net')
    expect(resolved.args.slice(-2)).toEqual(['--', PATHS.entryFile])
    // The package is bound read-only; only the data directory is writable.
    const args = buildBubblewrapArgs(PATHS)
    expect(args.join(' ')).toContain(`--ro-bind ${PATHS.packageDir} ${PATHS.packageDir}`)
    expect(args.join(' ')).toContain(`--bind ${PATHS.dataDir} ${PATHS.dataDir}`)
  })

  it('[unverified on Linux] refuses when bubblewrap or user namespaces are unavailable', () => {
    expect(resolveBackendSandbox(PATHS, probe({ platform: 'linux' }))).toMatchObject({ available: false })
  })

  it('[unverified on Windows] is always unavailable on Windows (deferred to v1.1)', () => {
    const resolved = resolveBackendSandbox(PATHS, probe({
      platform: 'win32',
      sandboxExec: () => SANDBOX_EXEC_PATH,
      bubblewrap: () => '/usr/bin/bwrap',
    }))
    expect(resolved).toEqual({ available: false, reason: 'third-party backends are not supported on Windows yet' })
  })

  it('refuses relative or control-character paths instead of encoding them', () => {
    const sandboxExec = () => SANDBOX_EXEC_PATH
    expect(resolveBackendSandbox({ ...PATHS, dataDir: 'data' }, probe({ sandboxExec }))).toMatchObject({ available: false })
    expect(resolveBackendSandbox({ ...PATHS, dataDir: '/data\n(allow default)' }, probe({ sandboxExec })))
      .toMatchObject({ available: false })
  })

  it('escapes quotes and backslashes in Seatbelt strings', () => {
    const profile = buildSeatbeltProfile({ packageDir: '/p/a"b\\c', dataDir: '/d' })
    expect(profile).toContain('(subpath "/p/a\\"b\\\\c")')
  })

  it('[unverified on Linux] probes bwrap only on Linux', () => {
    expect(createHostSandboxProbe('darwin').bubblewrap()).toBeNull()
    expect(createHostSandboxProbe('win32').sandboxExec()).toBeNull()
  })
})

describe('sandboxed spawn', () => {
  it('points home and temporary directories at the data directory', () => {
    const env = sandboxedEnvironment({ PATH: '/usr/bin', HOME: '/Users/real' }, '/data/x')
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/data/x', TMPDIR: '/data/x/tmp/', TEMP: '/data/x/tmp' })
  })

  it('refuses an entry other than the admitted one', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-entry-')))
    try {
      writeFileSync(join(root, 'entry'), '')
      writeFileSync(join(root, 'other'), '')
      const spawnImpl = vi.fn()
      const spawnProcess = sandboxedSpawnProcess(
        { available: true, kind: 'seatbelt', command: SANDBOX_EXEC_PATH, args: [] },
        { packageDir: root, dataDir: root, entryFile: join(root, 'entry') },
        spawnImpl as never,
      )
      expect(() => spawnProcess(join(root, 'other'), {})).toThrow('does not match')
      expect(spawnImpl).not.toHaveBeenCalled()
      spawnProcess(join(root, 'entry'), { env: { A: '1' } })
      expect(spawnImpl).toHaveBeenCalledWith(SANDBOX_EXEC_PATH, [], expect.objectContaining({
        shell: false,
        cwd: root,
        env: expect.objectContaining({ A: '1', HOME: root }),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const PROBE_SOURCE = fileURLToPath(new URL('./test-fixtures/sandbox-escape-probe.c', import.meta.url))
const hasCc = process.platform !== 'win32' && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0

interface EscapeRun {
  root: string
  results: Record<string, string>
  dispose(): Promise<void>
}

/** Compile the escape probe into a throwaway package, run it through the real
 * sandbox for this platform, and collect one result per check. */
async function runEscapeProbe(platform: NodeJS.Platform): Promise<EscapeRun> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-escape-')))
  const packageDir = join(root, 'package')
  const dataDir = join(root, 'data')
  const outsideDir = join(root, 'outside')
  const homeDir = join(root, 'home')
  for (const dir of [packageDir, join(dataDir, 'tmp'), outsideDir, join(homeDir, '.ssh')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(homeDir, '.ssh', 'id_ed25519'), 'key')
  writeFileSync(join(homeDir, 'visible.txt'), 'visible')
  const entryFile = join(packageDir, 'probe')
  const compiled = spawnSync('cc', ['-O0', '-o', entryFile, PROBE_SOURCE], { encoding: 'utf8' })
  if (compiled.status !== 0) throw new Error(`probe did not compile: ${compiled.stderr}`)
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')

  const server: Server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const paths = { packageDir, dataDir, entryFile, homeDir }
  const resolved = resolveBackendSandbox(paths, createHostSandboxProbe(platform))
  if (!resolved.available) throw new Error(resolved.reason)
  const child = sandboxedSpawnProcess(resolved, paths)(entryFile, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      PROBE_SELF: entryFile,
      PROBE_DATA: dataDir,
      PROBE_SECRET: join(outsideDir, 'secret.txt'),
      PROBE_OUTSIDE: join(outsideDir, 'written.txt'),
      PROBE_REAL_HOME: homedir(),
      PROBE_PORT: String(port),
      PROBE_SENSITIVE: join(homeDir, '.ssh', 'id_ed25519'),
      PROBE_HOME_OTHER: join(homeDir, 'visible.txt'),
      PROBE_DATA_COPY: join(dataDir, 'copy-of-probe'),
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)))
  if (code !== 0) throw new Error(`probe exited ${code}: ${stderr}`)
  const results = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('=') as [string, string]))
  return {
    root,
    results,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const canRunSeatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC_PATH) && hasCc

describe.runIf(canRunSeatbelt)('macOS Seatbelt escape suite (live)', () => {
  let run: EscapeRun

  beforeAll(async () => {
    run = await runEscapeProbe('darwin')
  }, 60_000)

  afterAll(async () => {
    await run?.dispose()
  })

  it('keeps the backend working inside its own package and data directory', () => {
    expect(run.results.read_package).toBe('ok')
    expect(run.results.write_data).toBe('ok')
    expect(run.results.exec_self).toBe('ok')
  })

  it('denies reading files outside the package and data directory', () => {
    expect(run.results.read_secret).toMatch(/^denied:/)
    expect(run.results.list_real_home).toMatch(/^denied:/)
  })

  it('denies writing outside the data directory', () => {
    expect(run.results.write_outside).toMatch(/^denied:/)
    expect(existsSync(join(run.root, 'outside', 'written.txt'))).toBe(false)
  })

  it('denies every network connection, including loopback and DNS', () => {
    expect(run.results.connect_loopback).toMatch(/^denied:/)
    expect(run.results.connect_internet).toMatch(/^denied:/)
    expect(run.results.resolve_dns).toMatch(/^denied:/)
  })

  it('denies executing system binaries such as /bin/sh', () => {
    expect(run.results.exec_shell).toMatch(/^denied:/)
  })

  it('denies executing anything written to the data directory', () => {
    expect(run.results.exec_data_copy).toMatch(/^denied:/)
  })

  it('hides even the metadata of sensitive home entries', () => {
    expect(run.results.stat_sensitive).toMatch(/^denied:/)
    // Known limitation: other paths stay stat-able (bsd.sb grants metadata
    // reads; denying them under /Users breaks PyInstaller - see the profile).
    expect(run.results.stat_home_other).toBe('ok')
  })
})

// Linux runs live only where bubblewrap is installed. CI pins what it expects
// through NAVIDE_EXPECT_BWRAP ('available' | 'unavailable') so a host that
// cannot run bwrap is a failure there instead of a silent skip.
const linuxBubblewrap = process.platform === 'linux' ? createHostSandboxProbe('linux').bubblewrap() : null
const expectedBubblewrap = process.env.NAVIDE_EXPECT_BWRAP

describe.runIf(process.platform === 'linux')('Linux bubblewrap availability (live)', () => {
  it('matches the CI expectation for this host', () => {
    if (expectedBubblewrap === 'available') expect(linuxBubblewrap).not.toBeNull()
    if (expectedBubblewrap === 'unavailable') expect(linuxBubblewrap).toBeNull()
  })

  it.runIf(linuxBubblewrap === null)('refuses cleanly with a clear reason, never runs unsandboxed', () => {
    const resolved = resolveBackendSandbox(
      { packageDir: '/opt/p', dataDir: '/opt/d', entryFile: '/opt/p/backend' },
      createHostSandboxProbe('linux'),
    )
    expect(resolved).toEqual({
      available: false,
      reason: 'bubblewrap is not installed or unprivileged user namespaces are disabled',
    })
  })
})

describe.runIf(linuxBubblewrap !== null && hasCc)('Linux bubblewrap escape suite (live)', () => {
  let run: EscapeRun

  beforeAll(async () => {
    run = await runEscapeProbe('linux')
  }, 60_000)

  afterAll(async () => {
    await run?.dispose()
  })

  it('keeps the backend working inside its own package and data directory', () => {
    expect(run.results.read_package).toBe('ok')
    expect(run.results.write_data).toBe('ok')
    expect(run.results.exec_self).toBe('ok')
  })

  it('hides files outside the package and data directory', () => {
    expect(run.results.read_secret).toMatch(/^denied:/)
    expect(run.results.list_real_home).toMatch(/^denied:/)
  })

  it('denies writing outside the data directory', () => {
    expect(run.results.write_outside).toMatch(/^denied:/)
    expect(existsSync(join(run.root, 'outside', 'written.txt'))).toBe(false)
  })

  it('has no network, including loopback and DNS', () => {
    expect(run.results.connect_loopback).toMatch(/^denied:/)
    expect(run.results.connect_internet).toMatch(/^denied:/)
    expect(run.results.resolve_dns).toMatch(/^denied:/)
  })

  // bubblewrap exposes /usr read-only, so system binaries such as /bin/sh can
  // run - inside the same namespaces, with the same file view and no network.
  // Unlike Seatbelt it does not restrict exec; this records that difference.
  it('records that system binaries can run inside the namespaces', () => {
    expect(run.results.exec_shell).toMatch(/^(ok|denied:\d+)$/)
  })
})
