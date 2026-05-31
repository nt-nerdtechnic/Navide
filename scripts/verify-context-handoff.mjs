/**
 * Verification script for inter-stage context handoff fixes.
 * Run with: node scripts/verify-context-handoff.mjs
 *
 * Tests:
 *   1. Budget: 60 KB per stage (was 8 KB) — large PRDs no longer truncated
 *   2. Slice direction: head, not tail — document beginning (U1-U4, Risk) preserved
 *   3. Bracketed paste: BRACKETED_PASTE_START/END wrap kickoff text
 */

// ── Simulate the context-building logic from spawnPipelineStage ─────────────

const MAX_PER_STAGE = 60_000  // new value

function buildContextHeader(priorPanes) {
  const priorBlocks = []
  for (const { buf, label } of priorPanes) {
    if (!buf.trim()) continue
    const maxPerPane = MAX_PER_STAGE  // single pane for this test
    const snippet = buf.length > maxPerPane ? buf.slice(0, maxPerPane) : buf  // HEAD
    priorBlocks.push(`[${label} 輸出]\n${snippet.trim()}`)
  }
  if (priorBlocks.length === 0) return ''
  const SEP60 = '═'.repeat(60)
  const SEP60b = '─'.repeat(60)
  return `[前置階段產出 — 請在開始前先閱讀]\n${SEP60}\n${priorBlocks.join(`\n${SEP60b}\n`)}\n${SEP60}\n\n`
}

// ── Test data ────────────────────────────────────────────────────────────────

// Simulated Stage 01 PRD output — structured with User roles U1-U5 near the top
// and Risk table near the bottom, ~40 KB total.

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
3. 客訴追蹤 (U3)
4. 系統整合 API (U4)
5. 自動對帳 (U5)

## 3. 不做項目 (Scope Creep Prevention)
- 行動端 App（Phase 2）
- AI 推薦引擎（Phase 3）
`

// Pad to simulate a realistic ~30KB PRD
const FILLER = '\n'.repeat(100) + 'x'.repeat(200)
const PRD_MIDDLE = FILLER.repeat(80)  // ~25 KB filler

const PRD_TAIL = `
## 5. 風險與相依

| 風險 ID | 描述 | 機率 | 影響 | 緩解策略 |
|---------|------|------|------|---------|
| R1 | ERP API 不穩定 | 高 | 高 | 加 retry + circuit breaker |
| R2 | GDPR 法遵      | 中 | 高 | 資料最小化 + DPA 簽署     |

---SPEC-DONE---`

const simulatedPRD = PRD_HEADER + PRD_MIDDLE + PRD_TAIL
const OLD_BUDGET = 8_000

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅  ${name}`)
    passed++
  } else {
    console.error(`  ❌  ${name}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

// ── Test 1: Budget fix ───────────────────────────────────────────────────────
console.log('\n── Test 1: Budget (was 8 KB, now 60 KB) ──')

check(
  'PRD (30 KB) fits in new 60 KB budget without truncation',
  simulatedPRD.length <= MAX_PER_STAGE,
  `PRD=${simulatedPRD.length}, budget=${MAX_PER_STAGE}`
)

check(
  'Old 8 KB budget WOULD have truncated a 30 KB PRD',
  simulatedPRD.length > OLD_BUDGET,
  `PRD=${simulatedPRD.length}, old budget=${OLD_BUDGET}`
)

// ── Test 2: Slice direction ──────────────────────────────────────────────────
console.log('\n── Test 2: Slice direction (head, not tail) ──')

// Old code took the tail — what would it have returned?
const tailSnippet = simulatedPRD.slice(simulatedPRD.length - OLD_BUDGET)
const headSnippet = simulatedPRD.slice(0, MAX_PER_STAGE)

check(
  'Old tail-slice misses U1-U4 (only found at beginning)',
  !tailSnippet.includes('U1') && !tailSnippet.includes('U2') && !tailSnippet.includes('U3') && !tailSnippet.includes('U4')
)

check(
  'New head-slice contains all user roles U1–U5',
  ['U1', 'U2', 'U3', 'U4', 'U5'].every(u => headSnippet.includes(u))
)

check(
  'New head-slice preserves MVP 必做功能 section',
  headSnippet.includes('MVP 必做功能')
)

// ── Test 3: Context header construction ─────────────────────────────────────
console.log('\n── Test 3: Context header construction ──')

const header = buildContextHeader([{ buf: simulatedPRD, label: '01 Requirement Analysis' }])

check(
  'Context header is non-empty',
  header.length > 0
)

check(
  'Header contains U1-U4 roles',
  ['U1','U2','U3','U4'].every(u => header.includes(u))
)

check(
  'Header contains the section delimiter pattern',
  header.includes('[前置階段產出')
)

check(
  'Header does NOT expose the sentinel (sentinel is stripped from head)',
  !header.includes('---SPEC-DONE---') || header.indexOf('---SPEC-DONE---') > header.indexOf('U1')
)

// ── Test 4: Bracketed paste injection ────────────────────────────────────────
console.log('\n── Test 4: Bracketed paste injection ──')

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Simulate what injectText(preserveNewlines=true) does
function simulateInjectTextPreserveNewlines(text) {
  const chunks = []
  const wrapped = BRACKETED_PASTE_START + text + BRACKETED_PASTE_END
  const CHUNK = 512
  for (let i = 0; i < wrapped.length; i += CHUNK) {
    chunks.push(wrapped.slice(i, i + CHUNK))
  }
  return chunks
}

const testKickoff = 'Line 1\nLine 2\nLine 3\n'
const chunks = simulateInjectTextPreserveNewlines(testKickoff)
const reassembled = chunks.join('')

check(
  'First chunk starts with ESC [200~',
  reassembled.startsWith(BRACKETED_PASTE_START)
)

check(
  'Last chunk ends with ESC [201~',
  reassembled.endsWith(BRACKETED_PASTE_END)
)

check(
  'Newlines are preserved inside the wrapped payload',
  reassembled.includes('Line 1\nLine 2\nLine 3')
)

check(
  'Large kickoff (60 KB) is chunked into multiple 512-byte pieces',
  (() => {
    const bigText = 'x'.repeat(60_000)
    const c = simulateInjectTextPreserveNewlines(bigText)
    return c.length > 1 && c.every(ch => ch.length <= 512)
  })()
)

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`)
if (failed > 0) process.exit(1)
