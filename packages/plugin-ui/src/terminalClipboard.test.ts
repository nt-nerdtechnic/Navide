import { describe, expect, it } from 'vitest'
import { extractClipboardImage, terminalClipboardChunks } from './terminalClipboard'

describe('terminal clipboard helpers', () => {
  it('normalizes newlines and preserves bracketed multiline framing', () => {
    expect(terminalClipboardChunks('a\nb\r\nc', true)).toEqual(['\x1b[200~a\rb\rc\x1b[201~'])
  })

  it('round-trips Unicode at exact 512 code-unit chunk boundaries', () => {
    const text = '😀'.repeat(513)
    const chunks = terminalClipboardChunks(text, false)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => chunk.length <= 512)).toBe(true)
  })

  it('extracts the first image file and ignores non-image items', () => {
    const image = new File(['png'], 'clip.png', { type: 'image/png' })
    const data = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => image },
      ],
    } as unknown as DataTransfer
    expect(extractClipboardImage(data)).toBe(image)
    expect(extractClipboardImage(null)).toBeNull()
  })
})
