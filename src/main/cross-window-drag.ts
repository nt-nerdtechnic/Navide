// Cross-window CLI-pane drop handoff. HTML5 drag-and-drop events do NOT cross
// BrowserWindow boundaries: a drag started in the main window never produces a
// dragover/drop in the editor window. So the drag SOURCE reports where the
// pointer was released (screen coords, from its own dragend, which does fire),
// and the main process hands the drop off to whichever window contains that
// point. Pure + electron-free so the hit-test is unit-testable (same pattern as
// cli-buffer-relay.ts).

/** Renderer → main: the pointer was released outside the source window. */
export const PANE_DRAG_END_CHANNEL = 'cli:pane-drag-end'
/** Main → renderer: a pane was dropped somewhere inside this window. */
export const EXTERNAL_PANE_DROP_CHANNEL = 'cli:external-pane-drop'

export interface ScreenPoint {
  x: number
  y: number
}

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** A BrowserWindow flattened to what the hit-test needs (structural for tests). */
export interface DropCandidate<T> {
  bounds: WindowRect
  visible: boolean
  minimized: boolean
  window: T
}

/** First candidate whose bounds contain `point`, skipping hidden/minimized
 *  windows. Returns null when the point lands on none of them. */
export function hitTestWindows<T>(point: ScreenPoint, candidates: DropCandidate<T>[]): T | null {
  for (const candidate of candidates) {
    if (!candidate.visible || candidate.minimized) continue
    const { x, y, width, height } = candidate.bounds
    if (point.x >= x && point.x < x + width && point.y >= y && point.y < y + height) {
      return candidate.window
    }
  }
  return null
}
