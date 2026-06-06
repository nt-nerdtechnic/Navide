import { spawn, type ChildProcess } from 'node:child_process'
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

export async function startBackend(): Promise<BackendHandle> {
  const port = await findFreePort()
  const host = '127.0.0.1'

  // Electron strips PATH on macOS; restore common tool locations so the backend
  // can reach git, tmux, claude, etc. via subprocess.
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    const common = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/bin', '/bin']
    const existing = (env.PATH ?? '').split(':').filter(Boolean)
    env.PATH = [...new Set([...common, ...existing])].join(':')
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
