import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
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
  const projectRoot = app.getAppPath()

  const proc = spawn(
    'uv',
    ['--project', 'backend', 'run', 'python', '-m', 'agent_team_backend', '--port', String(port), '--log-level', 'debug'],
    {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

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
