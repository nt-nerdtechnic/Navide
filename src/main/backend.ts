import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { app } from 'electron'
import {
  defaultShell,
  isWindows,
  loginPathFallbacks,
  loginShellFlags,
  needsLoginShellPath,
} from '../shared/osplat'
import { registerPendingBackend, releasePendingBackend } from './backend-pending'
import { killProcessTree } from './process-tree'
import {
  writeBackendPluginActivationCatalog,
  type BackendPluginActivationCatalogFile,
} from './plugins/pluginBackendActivationCatalog'

/**
 * The key that tells a person's own window apart from an agent driving the same
 * socket through MCP.
 *
 * Regenerated per backend, held only here and in the backend's memory: never a
 * file, never an environment variable. Those are the two places a CLI agent on
 * this machine reads without effort — `cat` and `ps -E` — and the whole point of
 * this key is to be out of reach of code that can already open the local
 * socket. See backend/agent_team_backend/confirm_token.py for what that buys
 * and, just as importantly, what it does not.
 */
let confirmKey = ''

/** How long a minted confirmation stays usable. Must match TOKEN_TTL_S. */
const CONFIRM_TTL_MS = 30_000

export function handConfirmKey(proc: ChildProcess): void {
  confirmKey = randomBytes(32).toString('hex')
  // One line, then the pipe closes: the backend reads exactly this much, and a
  // stdin left open would be a channel neither side has a use for -- except on
  // Windows, where it is the only way to ask for a graceful stop (see
  // stopBackendProcess): no SIGTERM exists there, so the pipe stays open and
  // carries a `shutdown` line later.
  proc.stdin?.write(`${confirmKey}\n`)
  if (!isWindows()) proc.stdin?.end()
}

/**
 * Mint a one-time confirmation for one trust-changing action.
 *
 * Bound to the action, to the device it names, and to a subject where the
 * device is not the whole story (the canonical policy text, a knock's key, a
 * member id) — so a token minted to approve one machine cannot be spent to
 * block another, and one minted for one rule set cannot sign a different one.
 * The backend's confirm_token module lists what is and is not bound. Returns
 * null before a backend
 * has been started, which is the honest answer: there is nothing to confirm to.
 */
export function mintTrustConfirmation(
  action: string,
  deviceId: string,
  subject = '',
): { nonce: string; expires: string; mac: string } | null {
  if (!confirmKey) return null
  const nonce = randomUUID()
  const expires = String((Date.now() + CONFIRM_TTL_MS) / 1000)
  const payload = ['navide/trust-confirm/v2', nonce, expires, action, deviceId, subject].join('\u0000')
  return { nonce, expires, mac: createHmac('sha256', confirmKey).update(payload).digest('hex') }
}


export interface BackendHandle {
  host: string
  port: number
  shell: string
  /** Main-process-only bearer used to register the Host WebSocket session. */
  hostSessionToken: string
  /** Where the backend keeps its state — and its ws token. Recorded here
   *  rather than recomputed by callers because dev and packaged resolve it
   *  differently, and two copies of that rule would drift. */
  dataDir: string
  proc: ChildProcess
  stop: () => Promise<void>
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        reject(new Error('failed to allocate port'))
      }
    })
  })
}

/**
 * The name PATH goes by in `env`.
 *
 * Windows spells it `Path` (and its `process.env` proxy answers any casing,
 * but a spread copy of it is a plain object that does not), so the key has to
 * be found rather than assumed or a second `PATH` gets written next to the
 * one the child actually reads.
 */
export function pathEnvKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** `head` ahead of whatever `existing` already listed, deduplicated. */
export function mergePathList(head: string[], existing: string | undefined): string {
  const tail = (existing ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...head, ...tail])].join(delimiter)
}

/** Ask the user's login shell for its full PATH (captures nvm/fnm/volta etc.).
 *  Returns { shell, path }. Path is null if the shell doesn't respond. */
function getLoginShellEnv(): Promise<{ shell: string; path: string | null }> {
  return new Promise((resolve) => {
    const shell = defaultShell(process.env)
    // Installers add PATH entries to the interactive rc file (~/.zshrc,
    // ~/.bashrc), which a plain login shell (-l) skips — see loginShellFlags
    // for which shells get -i. Marker-wrap the output so shell-config
    // chatter on stdout can't pollute the parsed PATH.
    const flags = loginShellFlags(shell)
    const args = [...flags, 'printf "__NAVIDE_PATH__%s\\n" "$PATH"']
    // Generous timeout: a heavy ~/.zshrc (nvm etc.) on a busy machine has been
    // measured at 13s+; timing out silently drops every zshrc PATH entry, which
    // surfaces later as "executable not found (claude)" on CLI spawn.
    execFile(shell, args, { timeout: 15_000 }, (err, stdout) => {
      if (err) { resolve({ shell, path: null }); return }
      const marked = stdout.split('\n').filter((l) => l.startsWith('__NAVIDE_PATH__'))
      const p = (marked.at(-1) ?? '').slice('__NAVIDE_PATH__'.length).trim()
      resolve({ shell, path: p.length > 0 ? p : null })
    })
  })
}

// PATH as resolved for spawned children (login-shell probe merged with the
// process PATH). Cached at backend start so other main-process spawners —
// external editors, see editors.ts — don't pay the probe again.
let resolvedUserPath: string | null = null

/** The PATH to give processes main spawns. Falls back to the process PATH
 *  when the backend has not started yet (or the probe failed). */
export function getResolvedUserPath(): string {
  return resolvedUserPath ?? process.env.PATH ?? ''
}

/** Mirror a backend log line to our own stdio, best-effort.
 *
 *  The stream we inherited can go away while the app lives on — closing the
 *  terminal that launched a dev run leaves a dead pipe behind — and a write to
 *  it fails asynchronously with EIO. Swallow that: losing a log line is not a
 *  reason to take the app down with an uncaught exception. */
export function forwardBackendLog(stream: NodeJS.WriteStream, chunk: Buffer): void {
  try {
    stream.write(`[backend] ${chunk.toString()}`, () => {
      /* async write failure — the stream is gone, nothing to do */
    })
  } catch {
    /* synchronous failure (already-destroyed stream) — same story */
  }
}

let stdioGuarded = false

/** Keep a dead stdio pipe from killing the app.
 *
 *  A broken pipe surfaces as an 'error' event on the stream itself, which
 *  Node turns into an uncaught exception when nothing listens. The write
 *  callback in forwardBackendLog does NOT cover this: the event fires on its
 *  own, independently of any one write. Observed as an EIO crash dialog after
 *  the terminal that launched a dev run went away. */
export function guardStdioStreams(): void {
  if (stdioGuarded) return
  stdioGuarded = true
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
}

export function bindBackendPluginActivationCatalog(
  base: NodeJS.ProcessEnv,
  catalog: BackendPluginActivationCatalogFile
): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.AGENT_TEAM_PLUGINS_DIR
  env.AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG = catalog.path
  env.AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG_SHA256 = catalog.sha256
  return env
}

/**
 * Stop the backend handle and everything beneath it.
 *
 * Resolves within the grace period no matter what. If the process already
 * exited before the listener attached (e.g. the backend crashed, which is why
 * the UI was stuck "connecting…"), 'exit' never fires again — so the timeout
 * must resolve unconditionally, or app quit hangs forever. 5s: the backend's
 * shutdown sweep (kill_all — one ps snapshot + 1s grace + watcher/MCP
 * teardown) must finish, or every PTY child is orphaned; 2s cut it off on
 * many-pane workspaces. Past the grace period the sweep did not happen, so
 * this has to reach the whole tree by name: SIGKILL is not forwarded by the
 * bootloader, and killing the handle alone would leave the real backend
 * holding the port with its PTY children reparented to init.
 *
 * Windows has no SIGTERM: `proc.kill` there is TerminateProcess on the
 * bootloader alone, which ends it instantly, fires 'exit', and leaves the real
 * backend and its PTY children running with nobody left to sweep them. The
 * cooperative channel there is stdin: a `shutdown` line makes the backend run
 * uvicorn's exit (and so the PTY sweep) exactly as a SIGTERM would; a Windows
 * stop cannot be graceful today. What it can be is complete: take the tree
 * down by pid immediately and let 'exit' settle the promise.
 */
export function stopBackendProcess(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      if (proc.exitCode === null) killProcessTree(proc.pid, 'SIGKILL')
      resolve()
    }, 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    if (isWindows()) {
      // Ask first: the backend turns this line into uvicorn's cooperative
      // exit, which runs the PTY sweep a SIGTERM would. The 5s timer above
      // still tree-kills whatever is left.
      proc.stdin?.write('shutdown\n')
      proc.stdin?.end()
      return
    }
    proc.kill('SIGTERM')
  })
}

export async function startBackend(
  healthCheckTimeoutMs = 45_000,
  approvedPluginCatalog?: BackendPluginActivationCatalogFile
): Promise<BackendHandle> {
  guardStdioStreams()
  const port = await findFreePort()
  const host = '127.0.0.1'
  const hostSessionToken = randomBytes(32).toString('base64url')

  // Electron strips PATH on macOS when launched from Finder/Dock.
  // Use a login shell to recover the full user PATH (nvm, fnm, volta, brew…).
  const catalog =
    approvedPluginCatalog ??
    writeBackendPluginActivationCatalog(
      join(app.getPath('userData'), 'plugins', '.navide-backend-activation.json'),
      { schemaVersion: 1, packages: [] }
    )
  const env = bindBackendPluginActivationCatalog(process.env, catalog)
  env.NAVIDE_BACKEND_HOST_TOKEN = hostSessionToken
  // The login-shell dance below runs on every platform that launches the app
  // with a session PATH rather than the shell's — macOS from Finder, Linux
  // from the .desktop entry. It used to be macOS-only, which left a Linux
  // launcher start unable to find the very tools the onboarding wizard had
  // just installed into ~/.local/bin. The initial value used to be a
  // hard-coded `/bin/zsh`, a path that does not exist on Windows and is not
  // the default on most Linux installs.
  let userShell = defaultShell(process.env)
  const pathKey = pathEnvKey(env)
  if (needsLoginShellPath()) {
    const { shell, path: loginPath } = await getLoginShellEnv()
    userShell = shell
    if (loginPath) {
      // Merge: login shell PATH first so user-installed tools take precedence,
      // then any paths the current process already has (rare but harmless).
      env[pathKey] = mergePathList(loginPath.split(delimiter), env[pathKey])
    } else {
      // Fallback: the platform's own conventional tool locations, which the
      // session PATH omits. ~/.local/bin is where Claude Code's installer
      // puts `claude` on both platforms, and where uv lands on Linux.
      env[pathKey] = mergePathList(loginPathFallbacks(homedir()), env[pathKey])
    }
  }
  resolvedUserPath = env[pathKey] ?? null

  // External Manifest v2 packages are never discovered by directory scan.
  // Python consumes only the exact-byte Host-approved catalog bound above;
  // bundled v1 plugins remain an explicit backend-owned compatibility path.

  let proc: ChildProcess
  if (app.isPackaged) {
    // PyInstaller names the frozen backend after the spec, plus the platform's
    // executable suffix. Without `.exe` the packaged Windows app looks for a
    // file that is not there and never starts its backend at all.
    const binaryPath = join(
      process.resourcesPath,
      'bin',
      isWindows() ? 'agent_team_backend.exe' : 'agent_team_backend'
    )
    proc = spawn(binaryPath, ['--port', String(port), '--log-level', 'info'], {
      env,
      // stdin hands over the trust-confirmation key and is closed right after
      // on POSIX; on Windows it stays open to carry the `shutdown` line. See
      // handConfirmKey and stopBackendProcess.
      stdio: ['pipe', 'pipe', 'pipe'],
      // The frozen backend is a console-subsystem exe; without this Windows
      // pops a console window for it behind the app. No-op elsewhere.
      windowsHide: true
    })
  } else {
    // Dev runs alongside the packaged app, which owns the default state dir.
    // Point this backend at a separate dir so the two don't fight over the
    // shared SQLite / session files / backend-port (honour a pre-set value).
    if (!env.AGENT_TEAM_DATA_DIR) {
      env.AGENT_TEAM_DATA_DIR = join(app.getPath('appData'), 'Agent-Team-dev')
    }
    const projectRoot = app.getAppPath()
    proc = spawn(
      'uv',
      ['--project', 'backend', 'run', 'python', '-m', 'agent_team_backend', '--port', String(port), '--log-level', 'debug'],
      {
        cwd: projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
  }

  // From here until the start finishes, shutdown owns this child: nothing else
  // holds a reference to it yet, and quitting mid-start would otherwise leave it
  // running after the app is gone.
  if (!registerPendingBackend(proc)) {
    throw new Error('backend start abandoned: the app is quitting')
  }

  handConfirmKey(proc)

  proc.stdout?.on('data', (chunk: Buffer) => forwardBackendLog(process.stdout, chunk))
  proc.stderr?.on('data', (chunk: Buffer) => forwardBackendLog(process.stderr, chunk))

  const handle: BackendHandle = {
    host,
    port,
    shell: userShell,
    hostSessionToken,
    dataDir: env.AGENT_TEAM_DATA_DIR ?? join(app.getPath('appData'), 'Agent-Team'),
    proc,
    stop: () => stopBackendProcess(proc)
  }

  try {
    // Packaged (unsigned/non-notarized) builds can be held up for many seconds
    // by macOS Gatekeeper scanning the bundled binary on first launch after
    // download — 15s was too tight and surfaced as "backend failed to start"
    // even though the process would have come up given more time. Now
    // configurable via Settings (default 45s) — see src/main/health-timeout.ts.
    await waitForHealth(host, port, healthCheckTimeoutMs)
  } catch (err) {
    // Health never came up — kill the orphaned child so it can't linger and
    // contend over the shared ~/.agent-team state on the next start attempt.
    // The process that holds that state is the bootloader's child, not the
    // handle, so this has to take the tree down rather than just the handle.
    killProcessTree(proc.pid, 'SIGKILL')
    throw err
  } finally {
    // Settled either way: the handle below owns the process now, or it is dead.
    // Shutdown has nothing left to abandon here.
    releasePendingBackend(proc)
  }
  return handle
}


/**
 * The credential the backend requires on /ws, or '' if it is not there yet.
 *
 * Read from disk on every call rather than cached: the backend mints a new one
 * each run, and an auto-restart replaces the file under a main process that
 * never stopped. A cached token would survive that and every window would be
 * refused with no obvious cause.
 */
export function readWsToken(handle: BackendHandle): string {
  try {
    return readFileSync(join(handle.dataDir, 'backend-ws-token'), 'utf8').trim()
  } catch {
    // Absent means the backend has not written it yet, or is an older build.
    // Callers pass '' through and the backend answers for itself.
    return ''
  }
}

export async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/health`)
      if (res.ok) return
      lastErr = new Error(`/health responded ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`)
}
