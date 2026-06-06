import { describe, it, expect } from 'vitest'

const MAX_PER_STAGE = 60_000
const OLD_BUDGET = 8_000

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

function buildContextHeader(priorPanes: { buf: string; label: string }[]): string {
  const blocks: string[] = []
  for (const { buf, label } of priorPanes) {
    if (!buf.trim()) continue
    const snippet = buf.length > MAX_PER_STAGE ? buf.slice(0, MAX_PER_STAGE) : buf
    blocks.push(`[${label} 輸出]\n${snippet.trim()}`)
  }
  if (blocks.length === 0) return ''
  const SEP60  = '═'.repeat(60)
  const SEP60b = '─'.repeat(60)
  return `[前置階段產出 — 請在開始前先閱讀]\n${SEP60}\n${blocks.join(`\n${SEP60b}\n`)}\n${SEP60}\n\n`
}

function simulateInjectTextPreserveNewlines(text: string): string[] {
  const wrapped = BRACKETED_PASTE_START + text + BRACKETED_PASTE_END
  const CHUNK = 512
  const chunks: string[] = []
  for (let i = 0; i < wrapped.length; i += CHUNK) {
    chunks.push(wrapped.slice(i, i + CHUNK))
  }
  return chunks
}

// Simulated ~30 KB PRD with structured content near the top
const PRD_HEADER = `[Stage 01 · Requirement Analysis]
=== MVP PRD Draft ===

## 1. 目標使用者與營運痛點

| ID | 角色      | 痛點描述                        |
|----|-----------|-------------------------------|
| U1 | 業務員    | 無法即時掌握客戶狀態            |
| U2 | 主管      | 報表需手動彙整，耗時半天         |
| U3 | 客服人員  | 客訴單追蹤困難，漏單率高         |
| U4 | IT 管理員 | 老系統整合複雜                  |
| U5 | 財務      | 對帳流程依賴 Excel              |

## 2. MVP 必做功能

1. 客戶管理模組 (U1/U2)
2. 報表自動化 (U2)
`
const PRD_MIDDLE = ('\n'.repeat(100) + 'x'.repeat(200)).repeat(80) // ~25 KB filler
const PRD_TAIL   = `\n## 5. 風險與相依\n| R1 | ERP API 不穩定 |\n---SPEC-DONE---`
const simulatedPRD = PRD_HEADER + PRD_MIDDLE + PRD_TAIL

describe('inter-stage context handoff', () => {
  describe('budget (was 8 KB, now 60 KB)', () => {
    it('30 KB PRD fits in 60 KB budget without truncation', () => {
      expect(simulatedPRD.length).toBeLessThanOrEqual(MAX_PER_STAGE)
    })

    it('old 8 KB budget would have truncated a 30 KB PRD', () => {
      expect(simulatedPRD.length).toBeGreaterThan(OLD_BUDGET)
    })
  })

  describe('slice direction (head, not tail)', () => {
    it('old tail-slice misses U1-U4 (content only near the beginning)', () => {
      const tail = simulatedPRD.slice(simulatedPRD.length - OLD_BUDGET)
      expect(tail).not.toContain('U1')
      expect(tail).not.toContain('U2')
      expect(tail).not.toContain('U3')
      expect(tail).not.toContain('U4')
    })

    it('new head-slice preserves all user roles U1-U5', () => {
      const head = simulatedPRD.slice(0, MAX_PER_STAGE)
      for (const u of ['U1', 'U2', 'U3', 'U4', 'U5']) {
        expect(head).toContain(u)
      }
    })

    it('new head-slice preserves MVP 必做功能 section', () => {
      const head = simulatedPRD.slice(0, MAX_PER_STAGE)
      expect(head).toContain('MVP 必做功能')
    })
  })

  describe('context header construction', () => {
    const header = buildContextHeader([{ buf: simulatedPRD, label: '01 Requirement Analysis' }])

    it('header is non-empty', () => {
      expect(header.length).toBeGreaterThan(0)
    })

    it('header contains U1-U4 roles', () => {
      for (const u of ['U1', 'U2', 'U3', 'U4']) {
        expect(header).toContain(u)
      }
    })

    it('header contains the section delimiter pattern', () => {
      expect(header).toContain('[前置階段產出')
    })

    it('sentinel does not appear before U1 in the header', () => {
      const sentinelIdx = header.indexOf('---SPEC-DONE---')
      const u1Idx = header.indexOf('U1')
      // sentinel either absent or appears after U1
      expect(sentinelIdx === -1 || sentinelIdx > u1Idx).toBe(true)
    })
  })

  describe('bracketed paste injection', () => {
    const testKickoff = 'Line 1\nLine 2\nLine 3\n'
    const chunks = simulateInjectTextPreserveNewlines(testKickoff)
    const reassembled = chunks.join('')

    it('reassembled payload starts with ESC [200~', () => {
      expect(reassembled.startsWith(BRACKETED_PASTE_START)).toBe(true)
    })

    it('reassembled payload ends with ESC [201~', () => {
      expect(reassembled.endsWith(BRACKETED_PASTE_END)).toBe(true)
    })

    it('newlines are preserved inside the wrapped payload', () => {
      expect(reassembled).toContain('Line 1\nLine 2\nLine 3')
    })

    it('60 KB kickoff is split into multiple 512-byte chunks', () => {
      const bigChunks = simulateInjectTextPreserveNewlines('x'.repeat(60_000))
      expect(bigChunks.length).toBeGreaterThan(1)
      expect(bigChunks.every(c => c.length <= 512)).toBe(true)
    })
  })
})
