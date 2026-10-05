/**
 * Once before-quit lets the native quit proceed, Electron closes every window
 * and cancels the whole quit — silently, with no event — if any one of those
 * closes is prevented (a renderer's beforeunload, or a close participant that
 * showed up after the quit was prepared). The app then keeps running with its
 * quit flags still set. The only sign is that will-quit never comes, so the
 * quit is given a deadline to reach it.
 */
export interface QuitCancelWatchDeps {
  timeoutMs: number
  /** Titles of the windows still open. The quit closes every window, so the
   *  ones that survived are what stopped it. */
  openWindowTitles(): string[]
  onCancelled(openWindowTitles: string[]): void
}

export interface QuitCancelWatch {
  /** before-quit let the native quit proceed. */
  arm(): void
  /** will-quit: the quit got past closing the windows. */
  disarm(): void
}

export function createQuitCancelWatch(deps: QuitCancelWatchDeps): QuitCancelWatch {
  let timer: ReturnType<typeof setTimeout> | null = null
  function disarm(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }
  function arm(): void {
    disarm()
    timer = setTimeout(() => {
      timer = null
      deps.onCancelled(deps.openWindowTitles())
    }, deps.timeoutMs)
  }
  return { arm, disarm }
}
