import { createTerminalStorageOwner } from '../../src/platform/terminal/lib/terminalStorageOwner'
import type { TerminalStorageOwnerRequest, TerminalStorageOwnerState } from '../../../shared/terminalStorageOwner'

const bridge = (window as unknown as {
  navideTerminalOwner?: { serve(handler: (request: TerminalStorageOwnerRequest) => TerminalStorageOwnerState | null): void }
}).navideTerminalOwner
if (!bridge) throw new Error('Terminal owner is unavailable')
const owner = createTerminalStorageOwner(localStorage)
bridge.serve(request => owner.execute(request))
