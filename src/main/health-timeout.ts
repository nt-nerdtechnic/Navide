import { readFileSync, writeFileSync } from 'node:fs'

// Health-check timeout (seconds): how long startBackend() waits for /health
// before giving up. User-configurable (Settings UI), persisted in a small
// main-owned JSON file in userData rather than renderer localStorage, because
// main needs the value before any renderer window exists (see index.ts's
// app.whenReady() → startBackend() ordering).

export const DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 45
export const MIN_HEALTH_CHECK_TIMEOUT_SEC = 15
export const MAX_HEALTH_CHECK_TIMEOUT_SEC = 120

export function clampHealthCheckTimeoutSec(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
  return Math.min(MAX_HEALTH_CHECK_TIMEOUT_SEC, Math.max(MIN_HEALTH_CHECK_TIMEOUT_SEC, Math.round(raw)))
}

/** Parse a health-timeout file's text, tolerating missing/corrupt content. */
export function parseHealthCheckTimeoutDoc(text: string | null): number {
  if (!text) return DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
  try {
    const data = JSON.parse(text)
    return clampHealthCheckTimeoutSec(Number(data?.timeoutSec))
  } catch {
    return DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
  }
}

export function readHealthCheckTimeoutSec(filePath: string): number {
  let text: string | null = null
  try { text = readFileSync(filePath, 'utf-8') } catch { /* missing file → default */ }
  return parseHealthCheckTimeoutDoc(text)
}

export function writeHealthCheckTimeoutSec(filePath: string, sec: number): void {
  writeFileSync(filePath, JSON.stringify({ timeoutSec: clampHealthCheckTimeoutSec(sec) }), 'utf-8')
}
