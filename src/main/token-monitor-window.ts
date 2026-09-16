import { createStandaloneWindowOpener, type StandaloneWindowOptions } from './standalone-window'

/** One machine-wide monitor, independent of workspace window lifetimes. */
export function createTokenMonitorWindowOpener(options: StandaloneWindowOptions): () => void {
  return createStandaloneWindowOpener(
    { window: 'token-monitor', title: 'Token Monitor', width: 1200, height: 800, minWidth: 760, minHeight: 480 },
    options
  )
}
