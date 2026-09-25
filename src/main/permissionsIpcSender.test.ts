import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// index.ts cannot be imported in a unit test (it boots Electron), so the
// sender checks are read from source, as trustConfirmActions.test.ts does.
const source = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

function handlerBody(channel: string): string {
  const start = source.indexOf(`'${channel}'`)
  expect(start, `a handler for ${channel} should exist`).toBeGreaterThan(-1)
  const next = source.indexOf('ipcMain.handle(', start)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('macOS permission IPC is only reachable from an app window', () => {
  // A request can raise a system prompt and open-settings opens System
  // Settings: a plugin webview or an embedded frame must not be able to.
  for (const channel of ['permissions:status', 'permissions:request', 'permissions:open-settings']) {
    it(channel, () => {
      expect(handlerBody(channel)).toContain('if (!isAppWindowSender(event)) return UNTRUSTED_SENDER')
    })
  }
})
