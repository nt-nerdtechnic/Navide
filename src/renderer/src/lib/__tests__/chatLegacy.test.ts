import { describe, it, expect } from 'vitest'
import { parseLegacyThreads } from '../chatLegacy'

const MAX = 20

describe('parseLegacyThreads', () => {
  it('parses the multi-thread format and caps at maxThreads', () => {
    const threads = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      title: `Thread ${i}`,
      messages: [],
      updatedAt: i,
    }))
    expect(parseLegacyThreads(JSON.stringify(threads), null, MAX)).toEqual(threads)
    expect(parseLegacyThreads(JSON.stringify(threads), null, 2)).toEqual(threads.slice(0, 2))
  })

  it('prefers the threads blob over the history blob', () => {
    const threads = [{ id: 't1', title: 'T', messages: [], updatedAt: 1 }]
    const history = JSON.stringify([{ role: 'user', content: 'ignored' }])
    expect(parseLegacyThreads(JSON.stringify(threads), history, MAX)).toEqual(threads)
  })

  it('wraps the single-conversation history format into one thread', () => {
    const history = [
      { role: 'user', content: 'How do I write a reducer for my shopping cart state?' },
      { role: 'assistant', content: 'Like this…' },
      { role: 'assistant', content: 'partial', streaming: true },
    ]
    const result = parseLegacyThreads(null, JSON.stringify(history), MAX)
    expect(result).toHaveLength(1)
    const thread = result![0]
    // streaming (in-flight) messages are dropped
    expect(thread.messages).toEqual(history.slice(0, 2))
    // titled after the first user message, truncated to 40 chars
    expect(thread.title).toBe('How do I write a reducer for my shopping'.slice(0, 40))
    expect(thread.id).toBeTruthy()
  })

  it('titles a history without user messages as "Chat history"', () => {
    const history = [{ role: 'assistant', content: 'hello' }]
    expect(parseLegacyThreads(null, JSON.stringify(history), MAX)![0].title).toBe('Chat history')
  })

  it('returns null when there is nothing usable', () => {
    expect(parseLegacyThreads(null, null, MAX)).toBeNull()
    expect(parseLegacyThreads('{corrupt', null, MAX)).toBeNull()
    expect(parseLegacyThreads('{"not":"an array"}', null, MAX)).toBeNull()
    expect(parseLegacyThreads(null, '{corrupt', MAX)).toBeNull()
    expect(parseLegacyThreads(null, '[]', MAX)).toBeNull()
    // history with only streaming messages → nothing worth migrating
    expect(
      parseLegacyThreads(null, JSON.stringify([{ role: 'assistant', content: 'x', streaming: true }]), MAX)
    ).toBeNull()
  })
})
