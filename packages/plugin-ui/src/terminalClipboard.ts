/** Same PTY paste framing as the existing terminal renderer. Chunk boundaries
 * preserve Unicode surrogate pairs and never add a submit key. */
export function terminalClipboardChunks(text: string, bracketed: boolean): string[] {
  const normalized = text.replace(/\r?\n/g, '\r')
  const payload = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
  const chunks: string[] = []
  let index = 0
  while (index < payload.length) {
    let end = Math.min(index + 512, payload.length)
    const code = payload.charCodeAt(end - 1)
    if (end < payload.length && code >= 0xd800 && code <= 0xdbff) end--
    chunks.push(payload.slice(index, end))
    index = end
  }
  return chunks
}

export function extractClipboardImage(data: DataTransfer | null): File | null {
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}
