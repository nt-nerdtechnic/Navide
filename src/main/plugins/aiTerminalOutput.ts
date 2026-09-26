import { TextDecoder, TextEncoder } from 'node:util'

/** Public AI CLI events are text, while the backend sends raw PTY bytes.
 * Preserve UTF-8 decoder state across micro-batches without sharing it across
 * instance/session authority boundaries. */
export class AiTerminalOutputDecoder {
  private readonly decoders = new Map<string, {
    instanceId: string
    decoder: InstanceType<typeof TextDecoder>
  }>()

  decode(instanceId: string, sessionId: string, data: unknown): string {
    if (!(data instanceof Uint8Array) && typeof data !== 'string') return ''
    let entry = this.decoders.get(sessionId)
    if (!entry || entry.instanceId !== instanceId) {
      entry = { instanceId, decoder: new TextDecoder() }
      this.decoders.set(sessionId, entry)
    }
    return entry.decoder.decode(typeof data === 'string' ? new TextEncoder().encode(data) : data, { stream: true })
  }

  finish(instanceId: string, sessionId: string): string {
    const entry = this.decoders.get(sessionId)
    this.decoders.delete(sessionId)
    return entry?.instanceId === instanceId ? entry.decoder.decode() : ''
  }

  dropSession(sessionId: string): void { this.decoders.delete(sessionId) }
  dropInstance(instanceId: string): void {
    for (const [sessionId, entry] of this.decoders) {
      if (entry.instanceId === instanceId) this.decoders.delete(sessionId)
    }
  }
}
