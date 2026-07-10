// One-time per-workspace migration parser for the legacy AI-chat localStorage
// blobs (`ai-chat-threads:<ws>`, and the even older `ai-chat-history:<ws>`
// single-conversation format). Used by AIChatPane when the backend
// chat-threads.json document is still empty. Pure so it is unit-testable
// outside the giant component.

interface LegacyChatMessage {
  role: string
  content: string
  streaming?: boolean
}

export interface LegacyChatThread {
  id: string
  title: string
  messages: LegacyChatMessage[]
  updatedAt: number
}

/** Parse the legacy localStorage chat persistence for one workspace.
 *
 *  - `threadsRaw` (the multi-thread format) wins when present: parsed and
 *    capped at `maxThreads`, mirroring the old loader.
 *  - Otherwise `historyRaw` (single message list) is wrapped into one thread,
 *    dropping in-flight streaming messages, titled after the first user
 *    message — the same conversion the old loader performed.
 *  - Returns null when there is nothing usable to migrate (absent or corrupt).
 */
export function parseLegacyThreads(
  threadsRaw: string | null,
  historyRaw: string | null,
  maxThreads: number
): LegacyChatThread[] | null {
  if (threadsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(threadsRaw)
      if (Array.isArray(parsed)) return (parsed as LegacyChatThread[]).slice(0, maxThreads)
    } catch {
      /* corrupt — nothing to migrate */
    }
    return null
  }
  if (historyRaw === null) return null
  try {
    const parsed: unknown = JSON.parse(historyRaw)
    if (!Array.isArray(parsed)) return null
    const msgs = (parsed as LegacyChatMessage[]).filter((m) => !m?.streaming)
    if (msgs.length === 0) return null
    const firstUser = msgs.find((m) => m.role === 'user')
    return [
      {
        id: crypto.randomUUID(),
        title: firstUser ? firstUser.content.slice(0, 40) : 'Chat history',
        messages: msgs,
        updatedAt: Date.now(),
      },
    ]
  } catch {
    return null
  }
}
