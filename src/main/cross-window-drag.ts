// Cross-window CLI-pane drop handoff (fallback path). Chromium DOES deliver
// same-app HTML5 drops across BrowserWindow boundaries when they land on an
// accepting drop target (verified 2026-07-24) — those are handled by the
// receiving window like a local drop. This module covers the remaining case:
// a release that no drop target consumed. The drag SOURCE sees dropEffect
// 'none' in its dragend, reports where the pointer was released (screen
// coords), and the main process hands the drop off to whichever window
// contains that point. Pure + electron-free so the hit-test is unit-testable
// (same pattern as cli-buffer-relay.ts).

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

/** A drop candidate plus the identity/ordering fields candidate selection
 *  needs (BrowserWindow.id in production; plain numbers in tests). */
export interface CandidateWindow<T> extends DropCandidate<T> {
  id: number
}

/** Prepare the candidate list for the hit-test: drop the drag-source window
 *  (its own in-window DnD already had the chance to consume the release), then
 *  sort by focus recency so the most-recently-focused window wins where
 *  windows overlap. Focus recency only approximates z-order — Electron has no
 *  cross-platform z-order query — so an overlapped, less-recently-focused
 *  window can lose the hit even when it is visually on top. */
export function selectDropCandidates<T>(
  windows: CandidateWindow<T>[],
  senderId: number | null,
  focusSeq: (id: number) => number
): DropCandidate<T>[] {
  return windows
    .filter((w) => w.id !== senderId)
    .sort((a, b) => focusSeq(b.id) - focusSeq(a.id))
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
