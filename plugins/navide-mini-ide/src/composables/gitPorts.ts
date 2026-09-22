import { createPluginGitTransport } from '../git-composition'
import type { useBackend } from './useBackend'

export function createMiniIdeGitTransport(backend: ReturnType<typeof useBackend>) {
  return createPluginGitTransport({ status: backend.status, request: backend.send, subscribe: backend.on })
}
