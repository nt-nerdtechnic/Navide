/**
 * The one place the desktop side asks which operating system this is.
 *
 * Named to match the backend's `osplat` package, and for the same reason:
 * every other module imports a capability from here and uses it
 * unconditionally, so adding a platform means adding an arm here rather than
 * finding every `process.platform` check that needs a third branch.
 *
 * This module is imported from main, preload and renderer, which is why it
 * cannot simply read `process.platform`: under `contextIsolation` the renderer
 * has no `process` at all. Main and preload get the real value; the renderer
 * gets whatever preload published on the bridge, and falls back to Linux —
 * the least special-cased of the three — if it is asked before that lands.
 */

export type PlatformId = 'darwin' | 'win32' | 'linux'

let injected: PlatformId | null = null

/**
 * Tell this module which platform it is on.
 *
 * Preload calls this with the real value so the renderer never has to guess,
 * and tests call it to exercise a platform they are not running on.
 */
export function setPlatformId(id: PlatformId): void {
  injected = id
}

/** Normalise anything Node might report into the three arms we branch on. */
export function normalizePlatformId(raw: unknown): PlatformId {
  if (raw === 'darwin' || raw === 'win32') return raw
  // Every other POSIX (linux, freebsd, ...) behaves like Linux for everything
  // this application does: X11/Wayland window controls, XDG paths, POSIX
  // signals. Collapsing them keeps the branch count at three.
  return 'linux'
}

export function platformId(): PlatformId {
  if (injected) return injected
  const fromNode = (globalThis as { process?: { platform?: string } }).process?.platform
  if (typeof fromNode === 'string' && fromNode.length > 0) {
    return normalizePlatformId(fromNode)
  }
  const fromBridge = (globalThis as { agentTeam?: { platform?: string } }).agentTeam?.platform
  if (typeof fromBridge === 'string' && fromBridge.length > 0) {
    return normalizePlatformId(fromBridge)
  }
  return 'linux'
}

export const isMac = (): boolean => platformId() === 'darwin'
export const isWindows = (): boolean => platformId() === 'win32'
export const isLinux = (): boolean => platformId() === 'linux'

/**
 * Whether this platform draws its own window controls into the title bar.
 *
 * macOS draws the traffic lights itself over a `titleBarStyle: 'hidden'`
 * window, and Windows can be asked to draw its own set through
 * `titleBarOverlay`. Linux has neither — a frameless window there is exactly
 * that, so without our own buttons the window cannot be minimised, maximised
 * or closed at all.
 */
export const needsDrawnWindowControls = (): boolean => !isMac()

/**
 * The shell to hand a terminal when the environment does not name one.
 *
 * `$SHELL` is set for any login session on macOS and Linux, so the fallback
 * only matters for a process started outside one. On Windows it is normally
 * unset, and the POSIX default that used to be hard-coded here named a path
 * that does not exist on that platform at all.
 */
/**
 * Whether this platform launches the app with a PATH that may be missing the
 * user's own tool directories, so the backend has to ask a login shell.
 *
 * A Finder- or desktop-launcher-started process inherits the session
 * environment, not the shell's: on macOS that omits Homebrew and
 * `~/.local/bin`; on Linux it omits whatever `~/.profile` and `~/.bashrc`
 * add, which is exactly where pnpm's and uv's installers put their binaries.
 * The Linux `.desktop` entry this app ships makes that launch path the
 * normal one rather than an edge case. Windows resolves tools through the
 * registry-backed PATH and has no login-shell equivalent to ask.
 */
export const needsLoginShellPath = (): boolean => !isWindows()

/**
 * Flags that make `shell` load the user's PATH additions before running `-c`.
 *
 * `-l` sources the login files. Installers, though, append to the
 * *interactive* rc file — `~/.zshrc`, `~/.bashrc` — which a plain login shell
 * skips, so those two also get `-i`. The output is marker-wrapped by the
 * caller, so interactive chatter on stdout cannot pollute the parsed PATH.
 *
 * bash gets `-i` only off macOS: the macOS default is zsh, and the rare
 * macOS bash user keeps the behaviour that shipped there.
 */
export function loginShellFlags(shell: string): string[] {
  const interactive = shell.endsWith('zsh') || (!isMac() && shell.endsWith('bash'))
  return interactive ? ['-il', '-c'] : ['-l', '-c']
}

/**
 * Where user-installed tools live when the login-shell probe fails.
 *
 * Prepended to PATH so a tool installed to one of these is found even when
 * the shell would not answer (a heavy rc file timing out, an exotic shell).
 * Each list is the platform's own convention: Homebrew's prefixes on macOS;
 * on Linux the XDG-adjacent dirs the pnpm and uv installers use, plus snap's
 * bin which most distributions do not put on the session PATH.
 */
export function loginPathFallbacks(home: string): string[] {
  const local = `${home}/.local/bin`
  switch (platformId()) {
    case 'darwin':
      return [local, '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
    case 'linux':
      return [local, `${home}/.local/share/pnpm`, '/usr/local/bin', '/snap/bin']
    default:
      return []
  }
}

export function defaultShell(env: Record<string, string | undefined> = {}): string {
  const declared = env.SHELL
  if (declared && declared.length > 0) return declared
  switch (platformId()) {
    case 'darwin':
      return '/bin/zsh'
    case 'win32':
      // Windows PowerShell, which every supported Windows ships; resolution is
      // by name so PATH decides, the same way `$SHELL` would. Deliberately not
      // `COMSPEC`: that names cmd.exe, whose command syntax is nothing like
      // what the spawn paths assume, and it is set on every Windows session so
      // honouring it would have made cmd.exe the effective default.
      return 'powershell.exe'
    default:
      // bash is not guaranteed on a minimal Linux install, but it is what
      // every distribution we would ship to has, and `sh` loses the
      // interactive features the CLI panes rely on.
      return '/bin/bash'
  }
}

/** The file name of `shell`, whichever separator its path uses. */
function shellBasename(shell: string): string {
  return shell.split(/[\\/]/).pop()?.toLowerCase() ?? ''
}

/**
 * The argv that runs one command inside the user's shell and leaves the
 * shell open afterwards — how every CLI pane is started.
 *
 * POSIX: `-l` so the login files load, plus `-i` for zsh because installers
 * append to `~/.zshrc`, which a plain login shell skips. Windows PowerShell
 * has neither flag: `-NoExit -Command` is the equivalent, and `-NoLogo`
 * keeps the banner out of the pane. cmd.exe's `/k` is its `-NoExit`. Any
 * other shell on Windows (Git's bash.exe, for one) takes the POSIX flags.
 */
export function shellCommandArgv(shell: string, command: string): string[] {
  if (isWindows()) {
    const name = shellBasename(shell)
    if (name === 'powershell.exe' || name === 'powershell' || name === 'pwsh.exe' || name === 'pwsh') {
      return [shell, '-NoLogo', '-NoExit', '-Command', command]
    }
    if (name === 'cmd.exe' || name === 'cmd') return [shell, '/k', command]
  }
  return [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', command]
}
