import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WsResponse<T = unknown> = {
  id: string
  type: string
  ok: boolean
  payload: T | null
  error: { code: string; message: string } | null
}

type WsEvent<T = unknown> = {
  id: string
  type: string
  payload: T
}

type BackendClient = {
  send: <T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<WsResponse<T>>
  waitForEvent: <T = unknown>(type: string, predicate: (payload: T) => boolean, timeoutMs?: number) => Promise<T>
  close: () => void
}

async function connectBackend(wsUrl: string): Promise<BackendClient> {
  const ws = new WebSocket(wsUrl)
  const pending = new Map<string, (msg: WsResponse) => void>()
  const listeners: Array<{ type: string; predicate: (payload: unknown) => boolean; resolve: (payload: unknown) => void }> = []

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend websocket open timeout')), 10_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('backend websocket error'))
    }, { once: true })
  })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as WsResponse | WsEvent
    if ('ok' in msg && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
      return
    }
    if (!('payload' in msg)) return
    for (const listener of [...listeners]) {
      if (listener.type === msg.type && listener.predicate(msg.payload)) {
        listeners.splice(listeners.indexOf(listener), 1)
        listener.resolve(msg.payload)
      }
    }
  })

  return {
    send<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<WsResponse<T>> {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`request ${type} timeout`))
        }, timeoutMs)
        pending.set(id, (msg) => {
          clearTimeout(timer)
          if (!msg.ok) {
            reject(new Error(`${type} failed: ${msg.error?.message ?? 'unknown error'}`))
            return
          }
          resolve(msg as WsResponse<T>)
        })
        ws.send(JSON.stringify({ id, type, payload, timestamp: new Date().toISOString() }))
      })
    },
    waitForEvent<T = unknown>(type: string, predicate: (payload: T) => boolean, timeoutMs = 20_000): Promise<T> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.findIndex((item) => item.resolve === resolve)
          if (idx >= 0) listeners.splice(idx, 1)
          reject(new Error(`event ${type} timeout`))
        }, timeoutMs)
        listeners.push({
          type,
          predicate: (payload) => predicate(payload as T),
          resolve: (payload) => {
            clearTimeout(timer)
            resolve(payload as T)
          },
        })
      })
    },
    close() {
      ws.close()
    },
  }
}

function writeFakeCli(binDir: string): { codex: string; antigravity: string } {
  const codex = join(binDir, 'fake-codex')
  const antigravity = join(binDir, 'fake-antigravity')
  writeFileSync(codex, `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const home = process.env.CODEX_HOME
const cwd = process.env.AGENT_TEAM_E2E_WORKSPACE || process.cwd()
const resume = process.env.AGENT_TEAM_E2E_RESUME_ID || 'resume-e2e'
const dir = path.join(home, 'sessions', '2026', '06', '08')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'rollout-' + Date.now() + '-' + resume + '.jsonl')
fs.writeFileSync(file,
  JSON.stringify({ type: 'session_meta', payload: { id: resume, cwd, model: 'e2e' } }) + '\\n' +
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } }) + '\\n'
)
console.log('fake codex wrote ' + file)
setInterval(() => {}, 1000)
`, 'utf-8')
  writeFileSync(antigravity, `#!/usr/bin/env python3
import os
import sqlite3
import sys
import time
from pathlib import Path

sid_idx = sys.argv.index('--session-id') if '--session-id' in sys.argv else -1
session_id = sys.argv[sid_idx + 1] if sid_idx >= 0 else 'antigravity-e2e'
cwd = os.environ.get('AGENT_TEAM_E2E_WORKSPACE', os.getcwd())
marker = os.environ.get('AGENT_TEAM_E2E_SESSION_MARKER', '')
directory = Path.home() / '.gemini' / 'antigravity-cli' / 'conversations'
directory.mkdir(parents=True, exist_ok=True)
file = directory / f'{session_id}.db'
connection = sqlite3.connect(file)
connection.execute(
    'CREATE TABLE trajectory_metadata_blob '
    '(id text DEFAULT "main", data blob, PRIMARY KEY (id))'
)
uri = f'file://{cwd}'.encode()
blob = b'\\x12\\x30' + uri + b'\\x00' + marker.encode()
connection.execute('INSERT INTO trajectory_metadata_blob VALUES (?, ?)', ('main', blob))
connection.commit()
connection.close()
print(f'fake antigravity wrote {file}', flush=True)
while True:
    time.sleep(1)
`, 'utf-8')
  chmodSync(codex, 0o755)
  chmodSync(antigravity, 0o755)
  return { codex, antigravity }
}

test('prebind detects and persists two Codex panes plus one Antigravity pane through Electron backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-prebind-e2e-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const binDir = join(root, 'bin')
  const backendData = join(root, 'backend-data')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(backendData, { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.codex-panes'), { recursive: true })
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), '{}')
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "e2e"\\n')
  // This scenario exercises session attribution, not MCP startup. Keeping the
  // isolated config empty avoids an unrelated npx download and teardown race.
  writeFileSync(join(backendData, 'mcp_servers.json'), '[]\n')
  const fake = writeFakeCli(binDir)

  let app: ElectronApplication | null = null
  let client: BackendClient | null = null
  try {
    app = await electron.launch({
      // Keep this process independent from any developer-run Navide instance;
      // requestSingleInstanceLock is scoped by Electron's user-data directory.
      args: [join(__dirname, '..'), `--user-data-dir=${join(root, 'user-data')}`],
      env: {
        ...process.env,
        HOME: home,
        NODE_ENV: 'production',
        AGENT_TEAM_DATA_DIR: backendData,
      },
    })
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const info = await page.evaluate(async () => {
      const api = (window as unknown as { agentTeam?: { getBackendInfo?: () => Promise<{ status: string; wsUrl?: string }> } }).agentTeam
      const deadline = Date.now() + 40_000
      while (Date.now() < deadline) {
        const current = await api?.getBackendInfo?.()
        if (current?.status === 'ready' && current.wsUrl) return current
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error('backend did not become ready')
    })
    expect(info.wsUrl).toBeTruthy()
    client = await connectBackend(info.wsUrl!)

    await client.send('pipeline.start', {
      workspace_path: workspace,
      task_description: 'session prebind electron e2e',
      total_stages: 1,
      stage_blueprint: [{
        stage_id: '01',
        title: 'Prebind',
        slots: [
          { label: 'Codex A', agent: 'codex', role: 'backend' },
          { label: 'Codex B', agent: 'codex', role: 'backend' },
          { label: 'Antigravity', agent: 'antigravity', role: 'pm' },
        ],
      }],
      pipeline_id: 'e2e-prebind',
    })

    await client.send('pipeline.slot_spawn', { workspace_path: workspace, stage_index: 0, slot_label: 'Codex A', pane_id: 'pane-codex-a', agent: 'codex', role: 'backend', session_home_id: 'home-codex-a' })
    await client.send('pipeline.slot_spawn', { workspace_path: workspace, stage_index: 0, slot_label: 'Codex B', pane_id: 'pane-codex-b', agent: 'codex', role: 'backend', session_home_id: 'home-codex-b' })
    await client.send('pipeline.slot_spawn', { workspace_path: workspace, stage_index: 0, slot_label: 'Antigravity', pane_id: 'pane-antigravity', agent: 'antigravity', role: 'pm' })

    const waitForPaneSession = (paneId: string) =>
      client!.waitForEvent<{ pane_id: string; session_id: string; session_file: string }>(
        'session.detected',
        (payload) => payload.pane_id === paneId,
      ).catch((error: unknown) => {
        throw new Error(`${paneId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    const seen: Record<string, Promise<{ pane_id: string; session_id: string; session_file: string }>> = {
      'pane-codex-a': waitForPaneSession('pane-codex-a'),
      'pane-codex-b': waitForPaneSession('pane-codex-b'),
      'pane-antigravity': waitForPaneSession('pane-antigravity'),
    }

    const createA = await client.send<{ terminal_session_id: string }>('terminal.create', {
      pane_id: 'pane-codex-a',
      agent_key: 'codex',
      command: fake.codex,
      cwd: workspace,
      env: { AGENT_TEAM_E2E_WORKSPACE: workspace, AGENT_TEAM_E2E_RESUME_ID: 'resume-codex-a' },
      metadata: { workspace_path: workspace, stage_id: '01', slot_label: 'Codex A', session_home_id: 'home-codex-a' },
    })
    const createB = await client.send<{ terminal_session_id: string }>('terminal.create', {
      pane_id: 'pane-codex-b',
      agent_key: 'codex',
      command: fake.codex,
      cwd: workspace,
      env: { AGENT_TEAM_E2E_WORKSPACE: workspace, AGENT_TEAM_E2E_RESUME_ID: 'resume-codex-b' },
      metadata: { workspace_path: workspace, stage_id: '01', slot_label: 'Codex B', session_home_id: 'home-codex-b' },
    })
    const createAntigravity = await client.send<{ terminal_session_id: string }>('terminal.create', {
      pane_id: 'pane-antigravity',
      agent_key: 'antigravity',
      command: `${fake.antigravity} --session-id antigravity-e2e-session`,
      cwd: workspace,
      env: {
        AGENT_TEAM_E2E_WORKSPACE: workspace,
        AGENT_TEAM_E2E_SESSION_MARKER: 'at-pane:pane-antigravity',
      },
      metadata: {
        workspace_path: workspace,
        stage_id: '01',
        slot_label: 'Antigravity',
        session_marker: 'at-pane:pane-antigravity',
      },
    })

    const [codexA, codexB, antigravityEvent] = await Promise.all([seen['pane-codex-a'], seen['pane-codex-b'], seen['pane-antigravity']])
    expect(codexA.session_id).toBe('resume-codex-a')
    expect(codexB.session_id).toBe('resume-codex-b')
    expect(antigravityEvent.session_id).toBe('antigravity-e2e-session')
    expect(antigravityEvent.session_file).toContain('/.gemini/antigravity-cli/conversations/antigravity-e2e-session.db')

    await client.send('pipeline.slot_session', { workspace_path: workspace, stage_index: 0, slot_label: 'Codex A', session_id: codexA.session_id })
    await client.send('pipeline.slot_session', { workspace_path: workspace, stage_index: 0, slot_label: 'Codex B', session_id: codexB.session_id })
    await client.send('pipeline.slot_session', { workspace_path: workspace, stage_index: 0, slot_label: 'Antigravity', session_id: antigravityEvent.session_id })

    const projectPath = join(workspace, '.agent-team', 'project.json')
    await expect.poll(() => {
      const project = JSON.parse(readFileSync(projectPath, 'utf-8')) as { panes: Array<{ slot_label: string; session_id: string; session_home_id?: string }> }
      return Object.fromEntries(project.panes.map((pane) => [pane.slot_label, pane.session_id]))
    }).toEqual({
      'Codex A': 'resume-codex-a',
      'Codex B': 'resume-codex-b',
      Antigravity: antigravityEvent.session_id,
    })

    const codexSession = await client.send<{ exists: boolean }>('agent.session_exists', { agent: 'codex', workspace_path: workspace, session_id: 'resume-codex-a' })
    const antigravitySession = await client.send<{ exists: boolean }>('agent.session_exists', { agent: 'antigravity', workspace_path: workspace, session_id: antigravityEvent.session_id })
    expect(codexSession.payload?.exists).toBe(true)
    expect(antigravitySession.payload?.exists).toBe(true)

    await client.send('terminal.kill', { terminal_session_id: createA.payload!.terminal_session_id })
    await client.send('terminal.kill', { terminal_session_id: createB.payload!.terminal_session_id })
    await client.send('terminal.kill', { terminal_session_id: createAntigravity.payload!.terminal_session_id })
    await client.send('codex_home.cleanup', { session_home_id: 'home-codex-a' })
    await client.send('codex_home.cleanup', { session_home_id: 'home-codex-b' })

    expect(existsSync(join(home, '.codex-panes', 'home-codex-a'))).toBe(false)
    expect(existsSync(join(home, '.codex-panes', 'home-codex-b'))).toBe(false)
    expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(true)
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(true)
  } finally {
    client?.close()
    // The confirm-before-quit gate (main's before-quit → native dialog, enabled
    // by default on a fresh user-data dir) would block app.close() forever;
    // auto-confirm the quit instead.
    await app?.evaluate(({ dialog }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any
    })
    await app?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
