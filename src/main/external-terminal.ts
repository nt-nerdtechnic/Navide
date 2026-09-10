/**
 * Open the user's terminal and run a command in it, visibly.
 *
 * Some installs cannot run inline: a `sudo` prompt or an OAuth flow needs a
 * real TTY the user can see and type into. The onboarding wizard marks those
 * `needs_terminal` and hands the command here.
 *
 * Until this module existed the only implementation was AppleScript driving
 * Terminal.app, so on Linux every one of those installs — all fourteen agent
 * CLIs and Ollama — failed with `spawn osascript ENOENT`. The wizard did show
 * the command so it could be pasted by hand, which is why nobody noticed.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import { isLinux, isMac } from '../shared/osplat'

export interface OpenTerminalResult {
  ok: boolean
  error?: string
}

/**
 * Terminal emulators tried in order on Linux.
 *
 * Every entry takes the command as argv after its own separator, so the
 * command reaches `bash -c` verbatim with no quoting layer of ours in between.
 * `x-terminal-emulator` goes first: it is Debian's alternatives symlink to
 * whatever the user picked, which beats guessing their desktop environment.
 */
const LINUX_TERMINALS: ReadonlyArray<{
  bin: string
  argv: (script: string) => string[]
}> = [
  { bin: 'x-terminal-emulator', argv: (s) => ['-e', 'bash', '-c', s] },
  { bin: 'gnome-terminal', argv: (s) => ['--', 'bash', '-c', s] },
  { bin: 'konsole', argv: (s) => ['-e', 'bash', '-c', s] },
  { bin: 'xterm', argv: (s) => ['-e', 'bash', '-c', s] },
]

/** Where a binary lives on PATH, or null. Node has no `which`. */
export function findOnPath(
  bin: string,
  path: string | undefined = process.env.PATH
): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here; keep looking
    }
  }
  return null
}

function openWithTerminalApp(command: string): Promise<OpenTerminalResult> {
  // Terminal.app's `do script` opens a window, runs the line, and leaves the
  // shell open afterwards so the user can read what happened.
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Terminal" to do script "${escaped}"\ntell application "Terminal" to activate`
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }))
    proc.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `osascript exited ${code}` })
    )
  })
}

function launch(bin: string, argv: string[]): Promise<OpenTerminalResult> {
  return new Promise((resolve) => {
    // Detached and unref'd: the terminal outlives this request, and the app
    // must not wait on it — an install that sits at a sudo prompt for a
    // minute would otherwise hold the IPC reply for a minute.
    const child = spawn(bin, argv, { detached: true, stdio: 'ignore' })
    child.on('error', (err) => resolve({ ok: false, error: String(err) }))
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

async function openWithLinuxTerminal(
  command: string,
  path: string | undefined
): Promise<OpenTerminalResult> {
  // `; exec bash` mirrors Terminal.app: the window stays open with a shell
  // once the command finishes, so its output (or its sudo prompt) is not
  // gone the instant it returns.
  const script = `${command}; exec bash`
  const tried: string[] = []
  for (const terminal of LINUX_TERMINALS) {
    tried.push(terminal.bin)
    const bin = findOnPath(terminal.bin, path)
    if (!bin) continue
    const result = await launch(bin, terminal.argv(script))
    if (result.ok) return result
    // Present on PATH but would not start — try the next one rather than
    // reporting a broken emulator as "no terminal".
  }
  return {
    ok: false,
    error: `no terminal emulator found (tried ${tried.join(', ')})`,
  }
}

/**
 * Run `command` in a visible terminal window on this platform.
 *
 * Resolves `ok: false` with a reason rather than throwing: the caller shows
 * the command alongside the error so the user can still paste it themselves.
 *
 * `path` is where terminal emulators are looked for; it defaults to this
 * process's PATH and is a parameter so a test can point it at a directory of
 * stand-ins instead of the machine it happens to run on.
 */
export function openInExternalTerminal(
  command: string,
  path: string | undefined = process.env.PATH
): Promise<OpenTerminalResult> {
  if (isMac()) return openWithTerminalApp(command)
  if (isLinux()) return openWithLinuxTerminal(command, path)
  return Promise.resolve({
    ok: false,
    error: 'opening an external terminal is not supported on this platform yet',
  })
}
