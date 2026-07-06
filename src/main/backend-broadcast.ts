// Pure dispatch logic for broadcastBackendChanged(), extracted so it can be
// unit-tested without an Electron runtime (same pattern as window-registry.ts,
// see vitest.config.ts's "electron-free main-process modules" comment).
//
// Only the focused window(s) get a backend:changed push immediately; a
// backgrounded window instead gets the latest payload queued and delivered
// once it regains focus — otherwise a single backend blip flashes
// "reconnecting" in every open window at once.

export class BackendBroadcastTracker<T> {
  private pending = new Map<number, T>()

  /** Decide whether a window should get `payload` immediately, or have it queued. */
  dispatch(winId: number, focused: boolean, payload: T): { immediate: boolean } {
    if (focused) {
      this.pending.delete(winId)
      return { immediate: true }
    }
    this.pending.set(winId, payload)
    return { immediate: false }
  }

  /** Pop the pending payload for a window that just regained focus, if any. */
  takePending(winId: number): T | undefined {
    const payload = this.pending.get(winId)
    this.pending.delete(winId)
    return payload
  }

  /** Drop a window's pending entry (e.g. on close). */
  forget(winId: number): void {
    this.pending.delete(winId)
  }
}
