import { MessageChannelMain, type MessagePortMain, type WebFrameMain } from 'electron'

export type PluginFrameBindingIdentity = {
  artifactId: string
  contributionKey: string
  entryUrl: string
  instanceId: string
  packageId: string
  packageVersion: string
  receiverGeneration: string
  receiverWebContentsId: number
  workspacePath: string
}

export type PluginFrameBinding = PluginFrameBindingIdentity & {
  documentGeneration: number | null
  frameTreeNodeId: number | null
  id: string
  state: 'reserved' | 'bound-blank' | 'provider-loading' | 'active' | 'revoked'
}

export type PluginFrameAdmission = {
  binding: PluginFrameBinding
  port: MessagePortMain
}

function copy(binding: PluginFrameBinding): PluginFrameBinding {
  return { ...binding }
}

/**
 * Owns frame/document identity only. Callers can reserve and revoke bindings,
 * but only an exact Electron frame can advance a reservation to active.
 */
export class PluginFrameBindingRegistry {
  private readonly bindings = new Map<string, PluginFrameBinding & { port: MessagePortMain | null }>()
  private nextId = 0

  reserve(identity: PluginFrameBindingIdentity): PluginFrameBinding {
    const id = `frame-${++this.nextId}`
    const binding = { ...identity, documentGeneration: null, frameTreeNodeId: null, id, port: null, state: 'reserved' as const }
    this.bindings.set(id, binding)
    return copy(binding)
  }

  bindBlank(id: string, frame: WebFrameMain): PluginFrameBinding | null {
    const binding = this.bindings.get(id)
    if (!binding || binding.state !== 'reserved' || frame.detached || frame.frameTreeNodeId === undefined) return null
    binding.frameTreeNodeId = frame.frameTreeNodeId
    binding.state = 'bound-blank'
    return copy(binding)
  }

  beginNavigation(id: string, frame: WebFrameMain, url: string): PluginFrameBinding | null {
    const binding = this.bindings.get(id)
    if (!binding || binding.state !== 'bound-blank' || frame.detached || frame.frameTreeNodeId !== binding.frameTreeNodeId || url !== binding.entryUrl) return null
    binding.state = 'provider-loading'
    return copy(binding)
  }

  admit(
    frame: WebFrameMain,
    receiverWebContentsId: number,
    documentNonce: string,
    onMessage: (binding: PluginFrameBinding, message: unknown) => void,
  ): PluginFrameAdmission | null {
    if (!documentNonce || frame.detached || frame.frameTreeNodeId === undefined) return null
    const binding = [...this.bindings.values()].find((candidate) =>
      candidate.state === 'provider-loading'
      && candidate.frameTreeNodeId === frame.frameTreeNodeId
      && candidate.receiverWebContentsId === receiverWebContentsId,
    )
    if (!binding) return null
    const channel = new MessageChannelMain()
    binding.port?.close()
    binding.port = channel.port1
    binding.documentGeneration = (binding.documentGeneration ?? 0) + 1
    binding.state = 'active'
    binding.port.on('message', (event) => onMessage(copy(binding), event.data))
    binding.port.start()
    return { binding: copy(binding), port: channel.port2 }
  }

  activeForInstance(instanceId: string): PluginFrameBinding | null {
    const binding = [...this.bindings.values()].find((candidate) => candidate.instanceId === instanceId && candidate.state === 'active')
    return binding ? copy(binding) : null
  }

  post(instanceId: string, channel: string, payload: unknown): boolean {
    const binding = [...this.bindings.values()].find((candidate) => candidate.instanceId === instanceId && candidate.state === 'active')
    if (!binding?.port) return false
    binding.port.postMessage({ channel, documentGeneration: binding.documentGeneration, payload })
    return true
  }

  revoke(id: string): void {
    const binding = this.bindings.get(id)
    if (!binding) return
    binding.port?.close()
    binding.port = null
    // Drop the record instead of retaining a 'revoked' terminal state: it can
    // never be admitted again, and keeping one entry per composed frame the Host
    // ever opened would grow this map — and the admit/active scans with it —
    // without bound.
    this.bindings.delete(id)
  }

  revokeInstance(instanceId: string): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.instanceId === instanceId) this.revoke(binding.id)
    }
  }

  /** Live bindings: reserved, bound, loading, or active. Revoked ids are dropped. */
  get size(): number {
    return this.bindings.size
  }
}
