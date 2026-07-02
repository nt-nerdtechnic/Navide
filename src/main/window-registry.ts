import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Crash-restore registry: continuously persists which workspace windows are
// open so an unexpected exit (crash, kill -9, power loss) can be detected on
// the next launch and offered for restore. A clean quit marks `cleanExit`;
// a crash never gets the chance — that asymmetry IS the detector.
//
// Only app-level window state lives here. Per-workspace pane state (and CLI
// session resume) is already persisted in each workspace's .agent-team/
// project.json and restored by the renderer when the workspace loads — this
// registry only needs to get the windows back on screen.

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowEntry {
  workspace_path: string
  bounds?: WindowBounds
}

export interface RegistryDoc {
  version: 1
  cleanExit: boolean
  windows: WindowEntry[]
}

/** Parse a registry file's text, tolerating missing/corrupt content. */
export function parseRegistryDoc(text: string | null): RegistryDoc {
  const empty: RegistryDoc = { version: 1, cleanExit: true, windows: [] }
  if (!text) return empty
  try {
    const data = JSON.parse(text)
    if (typeof data !== 'object' || data === null || !Array.isArray(data.windows)) return empty
    const windows: WindowEntry[] = data.windows
      .filter((w: unknown): w is WindowEntry =>
        typeof w === 'object' && w !== null && typeof (w as WindowEntry).workspace_path === 'string'
        && (w as WindowEntry).workspace_path.length > 0)
      .map((w: WindowEntry) => ({ workspace_path: w.workspace_path, ...(w.bounds ? { bounds: w.bounds } : {}) }))
    return { version: 1, cleanExit: data.cleanExit === true, windows }
  } catch {
    return empty
  }
}

/** The windows to offer for restore, or null when the last exit was clean
 *  (or nothing restorable was open). */
export function pendingFromDoc(doc: RegistryDoc): WindowEntry[] | null {
  if (doc.cleanExit) return null
  return doc.windows.length ? doc.windows : null
}

export class WindowRegistry {
  private entries = new Map<number, WindowEntry>()
  private cleanExit = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  // Accepts a path PROVIDER so the location can be resolved lazily: the dev
  // build re-points userData (…-dev suffix) after this module is imported, so
  // capturing app.getPath('userData') at construction would hit the wrong dir.
  constructor(private filePathOrFn: string | (() => string)) {}

  private get filePath(): string {
    return typeof this.filePathOrFn === 'function' ? this.filePathOrFn() : this.filePathOrFn
  }

  /** Read the previous run's doc, compute its restorable windows, then reset
   *  the file to this run's (empty, dirty) state. Call once at startup, after
   *  the single-instance lock is held. */
  readPendingAndReset(): WindowEntry[] | null {
    let text: string | null = null
    try { text = readFileSync(this.filePath, 'utf-8') } catch { /* first run */ }
    const pending = pendingFromDoc(parseRegistryDoc(text))
    this.persistNow()
    return pending
  }

  /** Record/replace the workspace for a window; empty path (back to Welcome)
   *  removes the entry — a workspace-less window isn't worth restoring. */
  setWorkspace(winId: number, workspacePath: string): void {
    if (!workspacePath) {
      this.entries.delete(winId)
    } else {
      const prev = this.entries.get(winId)
      this.entries.set(winId, { workspace_path: workspacePath, ...(prev?.bounds ? { bounds: prev.bounds } : {}) })
    }
    this.persistNow()
  }

  setBounds(winId: number, bounds: WindowBounds): void {
    const entry = this.entries.get(winId)
    if (!entry) return // Welcome window — not tracked
    entry.bounds = bounds
    this.persistDebounced()
  }

  remove(winId: number): void {
    if (!this.entries.delete(winId)) return
    this.persistNow()
  }

  /** Mark this run as a clean exit. Synchronous — called from before-quit. */
  markCleanExit(): void {
    this.cleanExit = true
    this.persistNow()
  }

  private doc(): RegistryDoc {
    return { version: 1, cleanExit: this.cleanExit, windows: [...this.entries.values()] }
  }

  private persistNow(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Atomic: write a sibling tmp file then rename over the target, so a
      // crash mid-write can't leave a truncated doc (parse falls back anyway).
      const tmp = join(dirname(this.filePath), '.open-windows.json.tmp')
      writeFileSync(tmp, JSON.stringify(this.doc(), null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch {
      // Best-effort: a failed persist only costs restore fidelity, never the app.
    }
  }

  // Bounds updates fire on every move/resize tick — coalesce them.
  private persistDebounced(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistNow() }, 500)
  }
}
