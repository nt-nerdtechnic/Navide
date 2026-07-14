// Request/reply relay behind ipcMain.handle('cli:get-pane-buffer'), extracted
// so it can be unit-tested without an Electron runtime (same pattern as
// backend-broadcast.ts). The editor window asks for a CLI pane's cleaned
// scrollback; panes live in the main window(s), so the main process fans the
// request out to every main-window webContents with a correlation id and
// resolves with the first successful reply.

export const CLI_BUFFER_REQUEST_CHANNEL = 'cli:get-pane-buffer:request'
export const CLI_BUFFER_REPLY_CHANNEL = 'cli:get-pane-buffer:reply'

export interface CliPaneBufferResult {
  label?: string
  agentKey?: string
  sessionId?: string | null
  sessionHomeId?: string
  workspacePath?: string
  conversationLogPath?: string
  buffer?: string
  error?: 'unavailable' | 'timeout' | 'not-found'
}

/** webContents-shaped send target (kept structural for tests). */
export interface CliBufferRelayTarget {
  send(channel: string, requestId: string, paneId: string): void
}

interface PendingRequest {
  resolve: (result: CliPaneBufferResult) => void
  /** Windows that have not replied yet — all replying not-found ⇒ not-found. */
  remaining: number
  timer: ReturnType<typeof setTimeout>
}

export class CliBufferRelay {
  private pending = new Map<string, PendingRequest>()
  private seq = 0

  /** Fan the request out to `targets`; resolves with the first non-error
   *  reply, `not-found` once every window answered without the pane,
   *  `unavailable` when there is no window to ask, or `timeout`. */
  request(
    targets: CliBufferRelayTarget[],
    paneId: string,
    timeoutMs = 3000
  ): Promise<CliPaneBufferResult> {
    if (targets.length === 0) return Promise.resolve({ error: 'unavailable' })
    const requestId = `cli-buf-${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ error: 'timeout' })
      }, timeoutMs)
      this.pending.set(requestId, { resolve, remaining: targets.length, timer })
      for (const target of targets) target.send(CLI_BUFFER_REQUEST_CHANNEL, requestId, paneId)
    })
  }

  /** Feed a renderer reply back in (wired to CLI_BUFFER_REPLY_CHANNEL). */
  handleReply(requestId: string, result: CliPaneBufferResult): void {
    const entry = this.pending.get(requestId)
    if (!entry) return // already resolved or timed out
    if (!result.error) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve(result)
      return
    }
    entry.remaining -= 1
    if (entry.remaining <= 0) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve({ error: 'not-found' })
    }
  }
}
