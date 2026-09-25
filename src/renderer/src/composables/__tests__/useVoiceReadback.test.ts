import { describe, expect, it } from 'vitest'
import { READBACK_MAX_CHARS, READBACK_WINDOW_MS, summarizeForSpeech, useVoiceReadback } from '../useVoiceReadback'

describe('summarizeForSpeech', () => {
  it('drops code blocks, inline code and markdown, keeps the first two sentences', () => {
    const text = [
      '## Done',
      '',
      'I fixed the **login bug** in `auth.ts`. Tests pass now. Next I will refactor.',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')
    expect(summarizeForSpeech(text)).toBe('Done I fixed the login bug in . Tests pass now.')
  })

  it('handles CJK sentence ends and keeps dotted names whole', () => {
    expect(summarizeForSpeech('已完成 v1.2 升級。測試全部通過！接下來處理文件。')).toBe('已完成 v1.2 升級。測試全部通過！')
  })

  it('keeps link labels, drops URLs, list bullets and MSG blocks', () => {
    const text = [
      '---MSG-START--- to: other',
      'internal note',
      '---MSG-END---',
      '- See [the report](https://x.dev/r) for details',
      '- https://example.com/raw',
    ].join('\n')
    expect(summarizeForSpeech(text)).toBe('See the report for details')
  })

  it('caps the length', () => {
    const out = summarizeForSpeech('字'.repeat(500))
    expect(out.length).toBe(READBACK_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty when only code is left', () => {
    expect(summarizeForSpeech('```\nls -la\n```')).toBe('')
  })
})

describe('useVoiceReadback', () => {
  function setup(enabled = true) {
    let clock = 1_000_000
    const spoken: string[] = []
    const rb = useVoiceReadback({
      enabled: () => enabled,
      speak: (t) => spoken.push(t),
      doneLine: (id) => `${id} 已完成`,
      now: () => clock,
    })
    return { rb, spoken, advance: (ms: number) => { clock += ms }, at: () => clock }
  }

  it('speaks only for panes that received a voice message', () => {
    const { rb, spoken } = setup()
    rb.onTurnComplete('p1', 'Hello there.')
    expect(spoken).toEqual([])
    rb.noteVoiceDelivered('p1')
    rb.onTurnComplete('p2', 'Other pane.')
    rb.onTurnComplete('p1', 'All good. Done here. Extra.')
    expect(spoken).toEqual(['All good. Done here.'])
  })

  it('falls back to "<pane> 已完成" when nothing is speakable', () => {
    const { rb, spoken } = setup()
    rb.noteVoiceDelivered('p1')
    rb.onTurnComplete('p1', '```\ncode\n```')
    rb.onTurnComplete('p1', '')
    expect(spoken).toEqual(['p1 已完成', 'p1 已完成'])
  })

  it('stops after the 10 minute window', () => {
    const { rb, spoken, advance } = setup()
    rb.noteVoiceDelivered('p1')
    advance(READBACK_WINDOW_MS + 1)
    rb.onTurnComplete('p1', 'Late.')
    expect(spoken).toEqual([])
  })

  it('skips a replayed turn older than the voice message', () => {
    const { rb, spoken, at } = setup()
    rb.noteVoiceDelivered('p1')
    rb.onTurnComplete('p1', 'Old turn.', at() - 5_000)
    rb.onTurnComplete('p1', 'New turn.', at() + 5_000)
    expect(spoken).toEqual(['New turn.'])
  })

  it('setting off: silent', () => {
    const { rb, spoken } = setup(false)
    rb.noteVoiceDelivered('p1')
    rb.onTurnComplete('p1', 'Hello.')
    expect(spoken).toEqual([])
  })
})
