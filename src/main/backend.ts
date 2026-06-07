import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'

export interface BackendHandle {
  host: string
  port: number
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

/** Ask the user's login shell for its full PATH (captures nvm/fnm/volta etc.).
 *  Returns null if the shell doesn't respond within 3 s. */
function getLoginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? '/bin/zsh'
    execFile(shell, ['-l', '-c', 'echo $PATH'], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      const p = stdout.trim()
      resolve(p.length > 0 ? p : null)
    })
  })
}

export async function startBackend(): Promise<BackendHandle> {
  const port = await findFreePort()
  const host = '127.0.0.1'

  // Electron strips PATH on macOS when launched from Finder/Dock.
  // Use a login shell to recover the full user PATH (nvm, fnm, volta, brew…).
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    const loginPath = await getLoginShellPath()
    if (loginPath) {
      // Merge: login shell PATH first so user-installed tools take precedence,
      // then any paths the current process already has (rare but harmless).
      const existing = (env.PATH ?? '').split(':').filter(Boolean)
      const merged = [...new Set([...loginPath.split(':'), ...existing])]
      env.PATH = merged.join(':')
    } else {
      // Fallback: add common macOS tool locations the system PATH omits.
      const common = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
      const existing = (env.PATH ?? '').split(':').filter(Boolean)
      env.PATH = [...new Set([...common, ...existing])].join(':')
    }
  }

  let proc: ChildProcess
  if (app.isPackaged) {
    const binaryPath = join(process.resourcesPath, 'bin', 'agent_team_backend')
    proc = spawn(binaryPath, ['--port', String(port), '--log-level', 'info'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } else {
    const projectRoot = app.getAppPath()
    proc = spawn(
      'uv',
      ['--project', 'backend', 'run', 'python', '-m', 'agent_team_backend', '--port', String(port), '--log-level', 'debug'],
      {
        cwd: projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[backend] ${chunk.toString()}`)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[backend] ${chunk.toString()}`)
  })

  const handle: BackendHandle = {
    host,
    port,
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
        }, 2000)
      })
  }

  await waitForHealth(host, port, 15_000)
  return handle
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
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
