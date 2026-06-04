<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import ViewPanel, { type LayoutMode } from './components/ViewPanel.vue'
import TerminalPane from './components/TerminalPane.vue'
import ControlPane, {
  type AgentSpec,
  type ActivePaneView,
  type SpawnPayload,
  type PipelineState,
  type PipelineStatusView,
  type ExistingProjectInfo,
  type AnalyzerStatusView,
  type WorkspaceMode
} from './components/ControlPane.vue'
import QuestionAlert from './components/QuestionAlert.vue'
import CompletionModal from './components/CompletionModal.vue'
import TokenStatsPanel from './components/TokenStatsPanel.vue'
import SettingsModal from './components/SettingsModal.vue'
import Welcome from './components/Welcome.vue'
import { useBackend } from './composables/useBackend'
import { useRoles } from './composables/useRoles'
import { useStages } from './composables/useStages'
import { usePipelines } from './composables/usePipelines'
import { useAnalyzer, type ClassifyResult } from './composables/useAnalyzer'
import type { RoleKey } from './data/roles'
import {
  renderSlotKickoff,
  MANAGER_READY_SENTINEL,
  MANAGER_STAGE_DONE_SENTINEL,
  ASK_START,
  ASK_END,
  REPORT_START,
  REPORT_END,
  DISPATCH_START,
  DISPATCH_END,
  type AgentKey,
  type StageId,
  type StageSlot
} from './data/stages'
import { findConsecutiveQuestionBlocks, findSentinel } from './lib/buffer'
import { allSlotsFinished, turnCompleteDone, type SlotSignal } from './lib/completion'
import { quickClassify } from './lib/quick-classify'
import { buildResumeCommand } from './lib/resume-command'

const backend = useBackend()
const rolesApi = useRoles(backend)
const pipelinesApi = usePipelines(backend)
const stagesApi = useStages(backend, () => pipelinesApi.activePipelineId.value)
const analyzerApi = useAnalyzer(backend)

// --- Workspace-first entry gate (phase-4) ------------------------------------
// The Welcome screen is shown until a workspace is chosen. Selection is kept in
// sessionStorage so a reload (Vite HMR / refresh) stays in the workspace, but a
// full app restart returns to Welcome.
const WS_SELECTED_KEY = 'agentTeam.workspaceSelected'
const WS_PATH_KEY = 'agentTeam.currentWorkspace'
const currentWorkspace = ref<string>(
  (() => {
    try {
      return sessionStorage.getItem(WS_PATH_KEY) ?? ''
    } catch {
      return ''
    }
  })()
)
const workspaceSelected = ref<boolean>(
  (() => {
    try {
      return sessionStorage.getItem(WS_SELECTED_KEY) === '1'
    } catch {
      return false
    }
  })()
)

function onWorkspaceSelected(path: string): void {
  currentWorkspace.value = path
  workspaceSelected.value = true
  try {
    sessionStorage.setItem(WS_PATH_KEY, path)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* sessionStorage unavailable — non-fatal, just won't survive reload */
  }
}

function roleLabel(key: string): string {
  if (!key) return 'No role'
  return rolesApi.find(key)?.label ?? key
}

// skipPermissionFlag: CLI-specific flag that bypasses interactive permission /
// trust prompts so the agent runs unattended. Appended automatically when the
// user enables YOLO mode (default) and hasn't supplied a custom command.
const agentSpecs: AgentSpec[] = [
  {
    agentKey: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'planner + reviewer'
  },
  {
    agentKey: 'codex',
    label: 'Codex',
    defaultCommand: 'codex',
    skipPermissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    hint: 'implementer'
  },
  {
    agentKey: 'gemini',
    label: 'Gemini CLI',
    defaultCommand: 'gemini',
    skipPermissionFlag: '--yolo --skip-trust',
    hint: 'tester + verifier'
  }
]

// Sticky toggles — defaults ON. Saved to localStorage so they survive reloads.
function makeStickyBool(key: string, fallback: boolean) {
  const r = ref<boolean>(
    (() => {
      try {
        const stored = localStorage.getItem(key)
        return stored === null ? fallback : stored === '1'
      } catch {
        return fallback
      }
    })()
  )
  watch(r, (v) => {
    try {
      localStorage.setItem(key, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  })
  return r
}

const yoloEnabled = makeStickyBool('agentTeam.yolo', true)
const autoAnswerEnabled = makeStickyBool('agentTeam.autoAnswer', false)
// Strict completion: when ON, idle/cap timeouts do NOT auto-advance — instead they
// prompt the user (or, if Full auto is also on, an LLM-styled 5-sec auto-advance).
// Drives the third grid column width on .app. TokenStatsPanel persists its
// own expanded/collapsed sticky state to localStorage; this ref mirrors the
// component state via v-model:expanded so the layout knows its width.
const tokenPanelExpanded = ref<boolean>(
  (() => { try { return localStorage.getItem('agentTeam.tokenPanel.expanded') === '1' } catch { return false } })()
)
const rightPanelWidth = ref<number>(
  (() => { try { return parseInt(localStorage.getItem('agentTeam.rightWidth') ?? '300') || 300 } catch { return 300 } })()
)
watch(rightPanelWidth, (v) => { try { localStorage.setItem('agentTeam.rightWidth', String(v)) } catch {} })
const tokenPanelWidth = computed(() => (tokenPanelExpanded.value ? `${rightPanelWidth.value}px` : '36px'))

const leftPanelWidth = ref<number>(
  (() => { try { return parseInt(localStorage.getItem('agentTeam.leftWidth') ?? '360') || 360 } catch { return 360 } })()
)
watch(leftPanelWidth, (v) => { try { localStorage.setItem('agentTeam.leftWidth', String(v)) } catch {} })

type DragTarget = 'left' | 'right'
let _dragTarget: DragTarget | null = null
let _dragStartX = 0
let _dragStartW = 0
const isDragging = ref(false)

function onResizeStart(e: MouseEvent, target: DragTarget): void {
  if (target === 'right' && !tokenPanelExpanded.value) return
  _dragTarget = target
  _dragStartX = e.clientX
  _dragStartW = target === 'left' ? leftPanelWidth.value : rightPanelWidth.value
  isDragging.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  e.preventDefault()
}

function onResizeMove(e: MouseEvent): void {
  if (!_dragTarget) return
  const dx = e.clientX - _dragStartX
  if (_dragTarget === 'left') {
    leftPanelWidth.value = Math.max(240, Math.min(560, _dragStartW + dx))
  } else {
    rightPanelWidth.value = Math.max(180, Math.min(520, _dragStartW - dx))
  }
}

function onResizeEnd(): void {
  _dragTarget = null
  isDragging.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}

function makeStickyStr(key: string, fallback: string) {
  const r = ref<string>(
    (() => {
      try {
        return localStorage.getItem(key) ?? fallback
      } catch {
        return fallback
      }
    })()
  )
  watch(r, (v) => {
    try {
      localStorage.setItem(key, v)
    } catch {
      /* ignore */
    }
  })
  return r
}
const analyzerModel = makeStickyStr('agentTeam.analyzerModel', '')

// When models first load (or after a refresh), if no model has been explicitly
// chosen yet, pin the sticky to the backend's default so the selector is stable
// across restarts rather than showing whichever model comes first in the list.
watch(
  () => analyzerApi.defaultModel.value,
  (def) => {
    if (def && !analyzerModel.value) {
      analyzerModel.value = def
    }
  },
  { immediate: true }
)

function resolveCommand(agentKey: string, override: string): string {
  const spec = agentSpecs.find((s) => s.agentKey === agentKey)
  const trimmed = override.trim()
  // If user supplied an override, trust it verbatim.
  if (trimmed) return trimmed
  const base = spec?.defaultCommand ?? agentKey
  if (yoloEnabled.value && spec?.skipPermissionFlag) {
    return `${base} ${spec.skipPermissionFlag}`
  }
  return base
}

type InjectionStatus = 'pending' | 'scheduled' | 'sent' | 'failed' | 'skipped'
type KickoffStatus = 'none' | 'pending' | 'sent' | 'failed'

interface ActivePane {
  id: string
  agentKey: string
  agentLabel: string
  roleKey: RoleKey
  stageId: StageId
  /** Human-readable slot label, e.g. "Architecture" or "UI/UX".
   *  Empty string for single-agent stages or manually-spawned panes. */
  slotLabel: string
  command: string
  workspacePath: string
  origin: 'manual' | 'pipeline'
  injectionStatus: InjectionStatus
  injectionTimer: number | null
  kickoffStatus: KickoffStatus
  kickoffPrompt: string
  /** When true, scheduleInjection skips role injection and sets injectionStatus='skipped'.
   *  activateStage will inject role + kickoff together at stage activation time. */
  skipRoleInjection?: boolean
  /** Absolute path to this pane's output log file (pipeline panes only). Lets
   *  downstream stages point agents at prior outputs via file path instead of
   *  inlining the whole terminal buffer into the kickoff. */
  outputLogFile?: string
  /** CLI session id used to resume this pane on restart. Known immediately for
   *  Claude (the --session-id we pinned); filled in later for Codex/Gemini once
   *  their CLI-generated id is detected from the session file. */
  pinnedSessionId?: string
  /** Unique marker embedded in this pane's kickoff (Codex/Gemini only) so the
   *  backend can match the right session file to this pane when several
   *  same-vendor panes share a workspace. */
  sessionMarker?: string
}

interface SpawnHistoryEntry {
  paneId: string
  agentKey: string
  agentLabel: string
  roleKey: RoleKey
  roleLabel: string
  command: string
  sessionId?: string
  origin: 'manual' | 'pipeline'
  stageId: StageId
  workspacePath: string
  spawnedAt: string
  removedAt?: string
}

const panes = ref<ActivePane[]>([])
const paneRefs = reactive<Record<string, InstanceType<typeof TerminalPane> | null>>({})
const persistedPaneSessions = new Set<string>()
const spawnHistory = ref<SpawnHistoryEntry[]>([])

function setPaneRef(id: string, el: unknown): void {
  paneRefs[id] = (el as InstanceType<typeof TerminalPane> | null) ?? null
}

const paneViews = ref<ActivePaneView[]>([])

function syncViews(): void {
  paneViews.value = panes.value.map((p) => {
    const ref = paneRefs[p.id]
    return {
      id: p.id,
      agentKey: p.agentKey,
      agentLabel: p.agentLabel,
      roleKey: p.roleKey,
      roleLabel: roleLabel(p.roleKey),
      stageId: p.stageId,
      command: p.command,
      status: (ref?.displayStatus as string | undefined) ?? (ref?.status as string | undefined) ?? 'starting',
      error: ref?.error as string | undefined,
      injectionStatus: p.injectionStatus,
      kickoffStatus: p.kickoffStatus,
      origin: p.origin,
      isCommander: paneIsCommander(p),
      sessionId: p.pinnedSessionId,
      slotLabel: p.slotLabel,
      isMinimized: minimizedPanes.value.has(p.id)
    }
  })
}

window.setInterval(syncViews, 400)
watch(panes, syncViews, { deep: true, immediate: true })

// PTY-friendly paste: wraps text with bracketed-paste escape sequences so
// modern CLIs (Claude Code / Codex / Gemini TUI) accept it as a single paste
// rather than interpreting embedded newlines as submit signals.
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Flatten multi-line prompts so they survive any CLI input mode (raw / cooked
// / bracketed-paste-off-during-init). Embedded newlines would otherwise hit
// the agent's Enter handler and submit fragments. We preserve paragraph
// structure with " — " separators so the model still gets visual hints.
function flattenForInjection(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, ' — ')
    .replace(/\n/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim()
}

// Whitespace-stripped form used to match our injected text against the echoed
// input box. The TUI word-wraps and re-indents the echo, so we drop ALL
// whitespace on both sides and compare the remaining glyphs.
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '')
}
// How many trailing (whitespace-stripped) chars of the payload to look for in
// the echo as the "input box received it" signal. Long enough to be unique,
// short enough to survive minor TUI re-rendering.
const TAIL_MATCH_LEN = 40
// Minimum buffer growth that counts as "the input box echoed something" when
// the tail itself can't be matched (e.g. a TUI that collapses a big paste into
// a "[Pasted text +N lines]" placeholder).
const READY_GROWTH_MIN = 40

async function injectText(
  sessionId: string,
  text: string,
  logLabel?: string,
  preserveNewlines = false
): Promise<boolean> {
  // Log the full injection text to the session's output log file BEFORE
  // chunking so the log file shows one readable block per send.
  if (logLabel) {
    // fire-and-forget — we don't need to await this for correctness
    backend.send('terminal.log_sent', {
      terminal_session_id: sessionId,
      label: logLabel,
      text
    }).catch(() => {/* ignore */})
  }

  // Resolve sessionId → paneId up front so we can watch the pane's cleaned
  // buffer while injecting. No observable pane (manual pane / no ref) → fall
  // back to a fixed gap and fire once.
  const paneId = Object.keys(paneRefs).find((id) => paneRefs[id]?.sessionId === sessionId)
  const cleanBuf = (): string =>
    paneId ? ((paneRefs[paneId]?.cleanBuffer as unknown as string) ?? '') : ''
  const cleanLen = (): number => (paneId ? cleanBuf().length : -1)

  // Send in modest chunks to avoid hitting any tty input-buffer limits and to
  // give the CLI's render loop a chance to keep up.
  const CHUNK = 512
  const payload = preserveNewlines
    // Bracketed-paste so the TUI treats embedded newlines as literal chars
    // instead of Enter keypresses (Claude Code / Codex / Gemini all support it).
    ? BRACKETED_PASTE_START + text + BRACKETED_PASTE_END
    : flattenForInjection(text)
  const sendChunks = async (): Promise<boolean> => {
    for (let i = 0; i < payload.length; i += CHUNK) {
      try {
        await backend.send('terminal.input', {
          terminal_session_id: sessionId,
          data: payload.slice(i, i + CHUNK)
        })
      } catch (err) {
        console.error(`[injectText] content send failed at ${i}/${payload.length}:`, err)
        return false
      }
    }
    return true
  }

  // Tail of OUR text (whitespace-stripped) — the "input box received it" signal.
  const tail = normalizeForMatch(text).slice(-TAIL_MATCH_LEN)

  // Send content, then WAIT for the input box to be ready rather than betting on
  // a fixed gap: poll until the tail shows up in the echo (strong) OR the buffer
  // grows appreciably (covers TUIs that collapse a big paste into a placeholder
  // so the tail never echoes verbatim). Neither within the window ⇒ the bytes
  // never landed (e.g. dropped under back-pressure) ⇒ resend the whole content
  // instead of pressing Enter on an empty box.
  const MAX_CONTENT_SENDS = 3
  const readyTimeout = Math.min(8_000, Math.max(2_500, Math.floor(text.length / 6)))
  let ready = false
  for (let send = 1; send <= MAX_CONTENT_SENDS && !ready; send++) {
    const preLen = cleanLen()
    if (!(await sendChunks())) return false
    if (paneId === undefined || preLen < 0) {
      // Nothing observable — keep the old fixed-gap fallback and fire once.
      await sleep(Math.min(4_000, Math.max(1_500, Math.floor(text.length / 8))))
      ready = true
      break
    }
    const deadline = Date.now() + readyTimeout
    while (Date.now() < deadline) {
      await sleep(200)
      const buf = cleanBuf()
      if (normalizeForMatch(buf).includes(tail) || buf.length - preLen >= READY_GROWTH_MIN) {
        ready = true
        break
      }
    }
    if (!ready && send < MAX_CONTENT_SENDS) {
      console.warn(
        `[injectText] content not echoed within ${readyTimeout}ms ` +
        `(send ${send}/${MAX_CONTENT_SENDS}) — resending content`
      )
    }
  }
  if (!ready) {
    // Content never reached the input box after retries — report honestly so
    // the caller logs a truthful failure instead of a misleading "✓ sent".
    console.error('[injectText] content never appeared in the input box after retries')
    return false
  }

  // Submit. Baseline captured AFTER the box is ready, so growth beyond it means
  // the agent reacted to Enter (not the echo of our paste). No reaction ⇒ the
  // \r didn't take ⇒ resend it.
  const before = cleanLen()
  const MAX_SUBMITS = 3
  for (let attempt = 1; attempt <= MAX_SUBMITS; attempt++) {
    try {
      await backend.send('terminal.input', { terminal_session_id: sessionId, data: '\r' })
    } catch (err) {
      console.error(`[injectText] submit Enter failed (attempt ${attempt}/${MAX_SUBMITS}):`, err)
      return false
    }
    if (paneId === undefined || before < 0) return true
    // Wait for agent to show first reaction (thinking spinner appears quickly).
    await sleep(2_500)
    if (cleanLen() > before) return true
    if (attempt < MAX_SUBMITS) {
      console.warn(
        `[injectText] no reaction 2.5s after Enter (attempt ${attempt}/${MAX_SUBMITS}) — ` +
        'resending Enter'
      )
    }
  }
  // Content was confirmed in the box and Enter was re-sent 3× but the agent
  // never reacted. Report honestly; the caller still arms the stage watcher.
  console.error('[injectText] no agent reaction after 3 Enters — content likely truncated or unsubmitted')
  return false
}

async function injectPane(paneId: string, text: string, logLabel?: string, preserveNewlines = false): Promise<boolean> {
  const ref = paneRefs[paneId]
  if (!ref?.sessionId) return false
  return injectText(ref.sessionId, text, logLabel, preserveNewlines)
}

// Default delay if no startup trust dialog is observed.
const ROLE_PROMPT_DELAY_MS = 4000

// Appended to every role prompt at injection time so agents stay silent
// after receiving the role and wait for the actual task kickoff.
const ROLE_STANDBY_SUFFIX = `

---
【等待任務指令】
收到以上角色設定後，請立即停止，不要做任何事。
在收到正式任務 kickoff 之前：
- 禁止執行任何工具或指令
- 禁止讀取任何檔案
- 禁止產生任何工作成果或輸出
只需回覆「準備就緒，等待任務」，然後保持靜默。`
const KICKOFF_DELAY_MS = 3000
// How long to watch for a startup trust dialog before giving up.
const DISMISS_TIMEOUT_MS = 8000

// Patterns surfacing on first launch of Codex / Claude / Gemini when the CLI
// asks the user to trust the workspace. Matching one means we should send a
// single \r to accept the default option (which is always "yes" / "continue").
const TRUST_DIALOG_PATTERNS: RegExp[] = [
  /Press enter to continue/i,
  /Do you trust the contents/i,
  /Trust the contents of this/i,
  /Yes,\s*continue/i,
  /Trust this folder/i,
  /Allow Claude Code to/i
]

function paneAlive(paneId: string): boolean {
  return panes.value.some((p) => p.id === paneId)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Wait for the agent to:
 *   1. start producing new output (it's processing our injection), then
 *   2. go quiet for `settleMs` (it's finished its current response).
 *
 * Returns 'settled' on success, 'no-activity' if the agent never produced
 * new output within `maxWaitMs`, or 'timeout' if it kept streaming past the
 * deadline. Callers can decide whether to proceed regardless.
 */
async function waitForActivityThenSettle(
  paneId: string,
  settleMs = 2000,
  maxWaitMs = 30_000
): Promise<'settled' | 'no-activity' | 'timeout'> {
  const ref = paneRefs[paneId]
  if (!ref) return 'no-activity'
  const startSize = ((ref.cleanBuffer as unknown as string) ?? '').length
  const deadline = Date.now() + maxWaitMs
  // Phase 1: wait for activity
  let activeSize = startSize
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return 'no-activity'
    await sleep(300)
    const r = paneRefs[paneId]
    if (!r) return 'no-activity'
    const size = ((r.cleanBuffer as unknown as string) ?? '').length
    if (size > startSize) {
      activeSize = size
      break
    }
  }
  if (activeSize === startSize) return 'no-activity'

  // Phase 2: wait for the stream to settle.
  let lastSize = activeSize
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return 'settled'
    await sleep(300)
    const r = paneRefs[paneId]
    if (!r) return 'settled'
    const size = ((r.cleanBuffer as unknown as string) ?? '').length
    if (size === lastSize) {
      if (Date.now() - stableSince >= settleMs) return 'settled'
    } else {
      lastSize = size
      stableSince = Date.now()
    }
  }
  return 'timeout'
}

async function dismissStartupDialog(paneId: string, timeoutMs = DISMISS_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return false
    const ref = paneRefs[paneId]
    if (!ref) return false
    const buf = (ref.cleanBuffer as unknown as string) ?? ''
    if (TRUST_DIALOG_PATTERNS.some((re) => re.test(buf))) {
      if (ref.sessionId) {
        await backend.send('terminal.input', {
          terminal_session_id: ref.sessionId as string,
          data: '\r'
        })
      }
      pipelineLog(`✓ dismissed startup dialog (pane ${paneId.slice(0, 8)})`)
      return true
    }
    await sleep(250)
  }
  return false
}

/**
 * Block until the pane has produced no new output for `requiredQuietMs`.
 * Bounded by `timeoutMs` so we proceed even if the CLI never stops streaming.
 *
 * Used as a more robust "is the CLI ready to accept input?" check than a
 * fixed sleep — different CLIs / first-vs-subsequent-runs take wildly
 * different amounts of time to render their initial UI.
 */
async function waitForQuiet(
  paneId: string,
  requiredQuietMs = 2000,
  timeoutMs = 12000
): Promise<void> {
  const ref = paneRefs[paneId]
  if (!ref) return
  const deadline = Date.now() + timeoutMs
  let lastSize = ((ref.cleanBuffer as unknown as string) ?? '').length
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return
    await sleep(250)
    const r = paneRefs[paneId]
    if (!r) return
    const size = ((r.cleanBuffer as unknown as string) ?? '').length
    if (size === lastSize) {
      if (Date.now() - stableSince >= requiredQuietMs) return
    } else {
      lastSize = size
      stableSince = Date.now()
    }
  }
}

// Global injection semaphore — at most 2 panes may inject simultaneously.
// Without this, all 6+ pre-spawned panes send role prompts at the same moment,
// flooding the WS connection and causing some 512-byte chunks to timeout/drop.
// The agent then receives a truncated role and asks for clarification instead
// of staying in standby, which breaks the Q&A flow and kickoff delivery.
const MAX_CONCURRENT_INJECTIONS = 2
let _activeInjections = 0
const _injectionQueue: Array<() => void> = []

async function acquireInjectionSlot(): Promise<void> {
  if (_activeInjections < MAX_CONCURRENT_INJECTIONS) {
    _activeInjections++
    return
  }
  await new Promise<void>((resolve) => _injectionQueue.push(resolve))
  _activeInjections++
}

function releaseInjectionSlot(): void {
  _activeInjections--
  _injectionQueue.shift()?.()
}

async function persistPaneSession(pane: ActivePane, sessionId: string): Promise<void> {
  const id = sessionId.trim()
  if (!id) return
  const key = `${pane.id}:${id}`
  if (persistedPaneSessions.has(key)) return
  let saved: unknown = null
  if (pane.origin === 'manual') {
    saved = await sendQuiet('manual_pane.session', {
      workspace_path: pane.workspacePath,
      pane_id: pane.id,
      session_id: id,
    })
  } else if (pane.slotLabel && pane.origin === 'pipeline') {
    const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
    if (stageIndex < 0) return
    saved = await sendQuiet('pipeline.slot_session', {
      workspace_path: pane.workspacePath,
      stage_index: stageIndex,
      slot_label: pane.slotLabel,
      session_id: id,
    })
  }
  if (saved) persistedPaneSessions.add(key)
}

function scheduleInjection(pane: ActivePane): void {
  pane.injectionStatus = 'scheduled'
  syncViews()
  const tag = `[pane ${pane.id.slice(0, 8)}]`
  ;(async () => {
    // 1. Try to dismiss a startup trust dialog (best-effort, up to 8s).
    pipelineLog(`${tag} watching for startup dialog (up to ${DISMISS_TIMEOUT_MS / 1000}s)`)
    const dismissed = await dismissStartupDialog(pane.id, DISMISS_TIMEOUT_MS)
    if (!paneAlive(pane.id)) return
    if (!dismissed) {
      pipelineLog(`${tag} no dialog detected — proceeding`)
      // Dump the buffer head so we can diagnose unrecognised CLI startup
      // screens. Trim to ~300 chars and replace whitespace runs for one-line
      // legibility in the log.
      const r = paneRefs[pane.id]
      const buf = ((r?.cleanBuffer as unknown as string) ?? '').slice(0, 300)
      if (buf) {
        pipelineLog(`${tag} buffer head: ${buf.replace(/\s+/g, ' ').trim().slice(0, 280)}`)
      }
    }

    // 2. Fixed settle delay — empirically enough for Claude/Codex/Gemini to
    //    finish rendering their first screen. Shorter after a known dismiss
    //    since the CLI usually transitions to a stable prompt immediately.
    const settleMs = dismissed ? 2500 : ROLE_PROMPT_DELAY_MS
    await sleep(settleMs)
    if (!paneAlive(pane.id)) return

    // 3. Inject role system prompt — unless this is a pre-spawn pane that
    //    will receive role + kickoff together at activation time.
    if (!pane.roleKey) {
      pane.injectionStatus = 'skipped'
      syncViews()
      pipelineLog(`${tag} ⏸ no role selected — skipping role injection`)
      if (pane.origin === 'manual' && pane.agentKey === 'claude' && pane.pinnedSessionId) {
        void persistPaneSession(pane, pane.pinnedSessionId)
      }
      return
    }
    if (pane.skipRoleInjection) {
      pane.injectionStatus = 'skipped'
      syncViews()
      pipelineLog(`${tag} ⏸ role deferred (pre-spawn — will inject at stage activation)`)
      return
    }
    const role = rolesApi.find(pane.roleKey)
    if (!role) {
      pane.injectionStatus = 'failed'
      syncViews()
      pipelineLog(`${tag} ✕ role '${pane.roleKey}' not found in registry`)
      return
    }
    // Embed the session marker in the role prompt too (Codex/Gemini), not just
    // the kickoff — the role is injected at pre-spawn, so the marker lands in
    // the session file (and gets detected) within seconds, instead of waiting
    // for this slot's stage to activate (which for late stages is much later).
    const roleContent = role.system_prompt + ROLE_STANDBY_SUFFIX + sessionMarkerLine(pane.sessionMarker)
    pipelineLog(`${tag} ➜ injecting role '${role.label}' (${roleContent.length} chars)`)
    await acquireInjectionSlot()
    let ok: boolean
    try {
      // bracketed paste (preserveNewlines) — same as kickoff — so the multi-line
      // role prompt isn't sent as a raw keystroke burst that floods the PTY
      // input buffer (EAGAIN drops) and re-renders on every embedded newline.
      ok = await injectPane(pane.id, roleContent, `role:${role.label}`, true)
    } finally {
      releaseInjectionSlot()
    }
    pane.injectionStatus = ok ? 'sent' : 'failed'
    syncViews()
    if (ok && pane.origin === 'manual' && pane.agentKey === 'claude' && pane.pinnedSessionId) {
      void persistPaneSession(pane, pane.pinnedSessionId)
    }
    if (!ok) {
      // Honest record: role injection didn't land (e.g. truncated mid-text).
      // Continue to the kickoff anyway — the agent may still recover, and the
      // watcher backstop covers a genuine no-start.
      pipelineLog(`${tag} ✕ role injection failed (agent didn't react) — continuing to kickoff anyway`)
    } else {
      pipelineLog(`${tag} ✓ role prompt sent`)
    }

    // 4. Inject kickoff prompt (pipeline panes only) — but only AFTER the
    //    agent has acknowledged the role prompt (started responding, then
    //    settled). This prevents the kickoff from being interleaved into
    //    the agent's role-acknowledgement output.
    if (pane.kickoffStatus === 'pending') {
      pipelineLog(`${tag} waiting for agent to acknowledge role (up to 30s)`)
      const result = await waitForActivityThenSettle(pane.id, 2500, 30_000)
      if (!paneAlive(pane.id)) return
      if (result === 'no-activity') {
        pipelineLog(`${tag} ⚠ agent silent after role — sending kickoff anyway`)
      } else if (result === 'timeout') {
        pipelineLog(`${tag} ⚠ agent still streaming — sending kickoff anyway`)
      } else {
        pipelineLog(`${tag} ✓ agent settled — proceeding`)
      }
      pipelineLog(`${tag} ➜ injecting kickoff (${pane.kickoffPrompt.length} chars)`)
      // Use bracketed-paste so newlines in the context header (prior-stage
      // documents) are preserved — without it they become Enter keypresses
      // and fragment the prompt into multiple partial submissions.
      const MAX_KICKOFF_ATTEMPTS = 3
      let ok2 = false
      for (let attempt = 1; attempt <= MAX_KICKOFF_ATTEMPTS; attempt++) {
        ok2 = await injectPane(pane.id, pane.kickoffPrompt, `kickoff:stage-${pane.stageId}`, true)
        if (ok2) break
        if (attempt < MAX_KICKOFF_ATTEMPTS) {
          pipelineLog(`${tag} ✕ kickoff injection failed (attempt ${attempt}/${MAX_KICKOFF_ATTEMPTS}) — retrying in 3s`)
          await sleep(3_000)
          if (!paneAlive(pane.id)) return
        }
      }
      pane.kickoffStatus = ok2 ? 'sent' : 'failed'
      syncViews()
      if (!ok2) {
        pipelineLog(`${tag} ✕ kickoff injection failed after ${MAX_KICKOFF_ATTEMPTS} attempts — arming watcher anyway`)
      } else {
        pipelineLog(`${tag} ✓ kickoff sent`)
      }

      // 5. Arm watcher. For question-interactive stages (P01) capture scanFrom
      //    after kickoff confirmation; for other stages pass undefined so the
      //    watcher uses markBufferPosition() and agentGenerating handles pacing.
      if (pane.origin === 'pipeline') {
        const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
        if (stageIndex >= 0) {
          const stageAllowsQ = stagesApi.stages.value[stageIndex]?.allowQuestions ?? false
          const kickoffScanFrom2 = stageAllowsQ
            ? (paneRefs[pane.id]?.markBufferPosition as () => number | undefined)?.()
            : undefined
          startStageWatcher(stageIndex, pane.id, kickoffScanFrom2)
        }
      }
    }
  })()
}

interface SpawnInternal {
  agentKey: string
  roleKey: RoleKey
  stageId: StageId
  /** Human-readable slot label — set for parallel-stage slots so the context
   *  header for downstream stages can identify which agent produced which output. */
  slotLabel?: string
  commandOverride: string
  workspacePath: string
  origin: 'manual' | 'pipeline'
  kickoffPrompt?: string
  skipRoleInjection?: boolean
  /** True when commandOverride is a `--resume`/`resume` command restoring a
   *  prior session. Suppresses the fresh Claude --session-id and the
   *  Codex/Gemini detection marker — the session id is already known. */
  isResume?: boolean
}

/** Trailing line embedded in a Codex/Gemini kickoff so the backend can match
 *  the resulting CLI session file back to this pane (those CLIs can't pin a
 *  session id at launch). Innocuous to the agent; only the marker text matters.
 *  Empty marker (Claude / manual panes) → no line added. */
function sessionMarkerLine(marker?: string): string {
  return marker ? `\n\n<!-- agent-team-session: ${marker} -->` : ''
}

async function spawnPane(opts: SpawnInternal): Promise<string | null> {
  const spec = agentSpecs.find((s) => s.agentKey === opts.agentKey)
  if (!spec) return null
  let command = resolveCommand(opts.agentKey, opts.commandOverride)
  const id = crypto.randomUUID()
  // For Claude, pin a unique --session-id so backend attribution maps THIS
  // pane's CLI events (turn_complete / agent_active / JSONL) precisely. Without
  // it, panes sharing one workspace are matched by a first-come-claim heuristic
  // that mis-routed a pane's turn_complete to a sibling (the Stage 01 bug).
  let explicitSessionId = ''
  if (opts.agentKey === 'claude' && !opts.isResume && !command.includes('--session-id')) {
    explicitSessionId = crypto.randomUUID()
    command = `${command} --session-id ${explicitSessionId}`
  }
  // Codex/Gemini can't pin a session id at launch, so we embed a unique marker
  // in the first injected text and the backend matches the resulting session
  // file back to this pane by that marker. Skipped on resume because the id is
  // already known.
  const sessionMarker =
    !opts.isResume &&
    (opts.agentKey === 'codex' || opts.agentKey === 'gemini')
      ? `at-pane:${id}`
      : ''
  const pane: ActivePane = {
    id,
    agentKey: opts.agentKey,
    agentLabel: spec.label,
    roleKey: opts.roleKey,
    stageId: opts.stageId,
    slotLabel: opts.slotLabel ?? '',
    command,
    workspacePath: opts.workspacePath,
    origin: opts.origin,
    injectionStatus: 'pending',
    injectionTimer: null,
    kickoffStatus: opts.kickoffPrompt ? 'pending' : 'none',
    kickoffPrompt: opts.kickoffPrompt ?? '',
    skipRoleInjection: opts.skipRoleInjection ?? false,
    pinnedSessionId: explicitSessionId || undefined,
    sessionMarker: sessionMarker || undefined,
  }
  // If this spawn carries its kickoff directly (fallback path), embed the
  // marker now. Pre-spawned panes get it at activateStage injection time.
  if (sessionMarker && pane.kickoffPrompt) {
    pane.kickoffPrompt += sessionMarkerLine(sessionMarker)
  }
  panes.value.push(pane)
  spawnHistory.value.push({
    paneId: id,
    agentKey: pane.agentKey,
    agentLabel: pane.agentLabel,
    roleKey: pane.roleKey,
    roleLabel: roleLabel(pane.roleKey),
    command: pane.command,
    sessionId: pane.pinnedSessionId,
    origin: pane.origin,
    stageId: pane.stageId,
    workspacePath: pane.workspacePath,
    spawnedAt: new Date().toISOString(),
  })
  await nextTick()
  const ref = paneRefs[id]
  if (!ref) return id
  try {
    // Always write the agent conversation to a dedicated log file. Pipeline
    // panes land inside the run sub-folder (runs/YYYYMMDD-HHmmss-task/) so
    // each run is self-contained; manual panes land under a flat manual/
    // folder grouped by date so they're still recoverable.
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const outputLogFile = opts.workspacePath
      ? opts.origin === 'pipeline'
        ? pipeline.runDir
          ? `${opts.workspacePath}/.agent-team/${pipeline.runDir}/stage-${opts.stageId}-${id.slice(0, 8)}.log`
          : `${opts.workspacePath}/.agent-team/stage-${opts.stageId}-${id.slice(0, 8)}.log`
        : `${opts.workspacePath}/.agent-team/manual/${ymd}/${opts.agentKey}-${id.slice(0, 8)}.log`
      : undefined
    pane.outputLogFile = outputLogFile

    await ref.spawn({
      command: ['bash', '-lc', command],
      cwd: opts.workspacePath,
      agentKey: opts.agentKey,
      metadata: {
        roleKey: opts.roleKey,
        stageId: opts.stageId,
        stage_id: opts.stageId,                 // snake_case alias for backend token sink
        origin: opts.origin,
        workspace_path: opts.workspacePath ?? '',
        explicit_session_id: explicitSessionId,  // Claude --session-id → precise pane attribution
        session_marker: sessionMarker,           // Codex/Gemini → marker-based session detection
        slot_label: opts.slotLabel ?? ''         // stable by_pane key survives frontend restarts
      },
      outputLogFile
    })
    if ((ref.status as unknown as string) === 'running') {
      scheduleInjection(pane)
    } else {
      pane.injectionStatus = 'skipped'
    }
  } finally {
    syncViews()
  }
  return id
}

async function onManualSpawn(payload: SpawnPayload): Promise<void> {
  const paneId = await spawnPane({
    agentKey: payload.agentKey,
    roleKey: payload.roleKey,
    stageId: payload.stageId,
    commandOverride: '',
    workspacePath: payload.workspacePath,
    origin: 'manual'
  })
  if (paneId) {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: payload.workspacePath,
      pane_id: paneId,
      agent: payload.agentKey,
      role: payload.roleKey,
      command: '',
      session_id:
        payload.agentKey === 'claude'
          ? ''
          : panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
    })
  }
}


/**
 * User-triggered analysis: ignore cooldown / idle / chars-grown requirements
 * and ask the model right now. Useful when the user can see the agent is
 * asking something but the watcher hasn't fired the analyzer yet (agent
 * still mid-stream / cooldown blocking / buffer too small).
 */
async function onAnalyzeNow(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const ref = paneRefs[paneId]
  if (!ref) return
  ;(ref.recleanBuffer as (() => void) | undefined)?.()
  const watcher = watchers.get(paneId)
  const fromPos = watcher?.scanFrom ?? 0
  const slice = ((ref.cleanBuffer as unknown as string) || '').slice(fromPos)
  if (!slice.trim()) {
    pipelineLog(`Stage ${stage.id} 🧠 nothing to analyze yet`)
    return
  }
  pipelineLog(`Stage ${stage.id} 🧠 manual analyze (${slice.length} chars)`)
  const result = await analyzerApi.classify(slice, analyzerModel.value || undefined, {
    workspacePath: pipeline.workspacePath,
    stageId: stage.id,
    paneId
  })
  if (!result) {
    pipelineLog(`Stage ${stage.id} 🧠 analyzer error`)
    return
  }
  pipelineLog(
    `Stage ${stage.id} 🧠 intent=${result.intent} (${result.total_duration_ms ?? '?'}ms)${
      result.summary ? ` — ${result.summary}` : ''
    }`
  )
  if (watcher) {
    watcher.lastAnalyzedBufferLen = ((ref.cleanBuffer as unknown as string) || '').length
    watcher.analyzerCooldownUntil = Date.now() + 5_000
  }
  handleAnalyzerResult(stageIndex, paneId, stage, result)
}

async function onReinject(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  if (pane.injectionTimer !== null) {
    window.clearTimeout(pane.injectionTimer)
    pane.injectionTimer = null
  }
  const role = rolesApi.find(pane.roleKey)
  if (!role) {
    pane.injectionStatus = pane.roleKey ? 'failed' : 'skipped'
    syncViews()
    return
  }
  pane.injectionStatus = 'scheduled'
  syncViews()
  const ok = await injectPane(paneId, role.system_prompt, `role:${role.label}`)
  pane.injectionStatus = ok ? 'sent' : 'failed'
  if (ok && pane.kickoffPrompt) {
    window.setTimeout(async () => {
      const ok2 = await injectPane(paneId, pane.kickoffPrompt, `kickoff:stage-${pane.stageId}`, true)
      pane.kickoffStatus = ok2 ? 'sent' : 'failed'
      syncViews()
    }, KICKOFF_DELAY_MS)
  }
  syncViews()
}

async function onKill(paneId: string, opts: { markRemoved?: boolean } = { markRemoved: true }): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (pane?.injectionTimer !== null && pane?.injectionTimer !== undefined) {
    window.clearTimeout(pane.injectionTimer)
  }
  let stageIndex = -1
  if (pane) {
    stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
    if (stageIndex >= 0) cancelWatcher(paneId)
  }
  if (activeQuestion.value?.paneId === paneId) activeQuestion.value = null
  const ref = paneRefs[paneId]
  if (ref?.sessionId) {
    try {
      await ref.kill()
    } catch {
      /* ignore */
    }
  }
  if (opts.markRemoved !== false && pane?.origin === 'pipeline' && pane.slotLabel && stageIndex >= 0) {
    await sendQuiet<ProjectPayload>('pipeline.slot_unspawn', {
      workspace_path: pane.workspacePath,
      stage_index: stageIndex,
      slot_label: pane.slotLabel,
    })
  }
  if (opts.markRemoved !== false && pane?.origin === 'manual') {
    await sendQuiet<ProjectPayload>('manual_pane.unspawn', {
      workspace_path: pane.workspacePath,
      pane_id: pane.id,
    })
  }
  const histEntry = spawnHistory.value.find((e) => e.paneId === paneId)
  if (histEntry && !histEntry.removedAt) {
    histEntry.sessionId = pane?.pinnedSessionId ?? histEntry.sessionId
    histEntry.removedAt = new Date().toISOString()
  }
  panes.value = panes.value.filter((p) => p.id !== paneId)
  delete paneRefs[paneId]
  syncViews()
}

async function onInterrupt(paneId: string): Promise<void> {
  const ref = paneRefs[paneId]
  if (!ref?.sessionId) return
  try {
    await ref.interrupt()
  } catch {
    /* ignore */
  }
}

async function onKillAll(): Promise<void> {
  for (const p of [...panes.value]) await onKill(p.id, { markRemoved: false })
}

// ────────────────────────── Pipeline ──────────────────────────

interface GlobalManagerRef {
  /** stage id (e.g. "02") that contains the Manager slot. */
  stageId: string
  /** slot label within that stage (e.g. "Planning"). */
  slotLabel: string
}

interface PipelineRun {
  task: string
  workspacePath: string
  stageIndex: number
  state: PipelineState
  log: string[]
  projectId: string
  projectFile: string
  pipelineLogFile: string
  backendLogFile: string
  /** Relative path from .agent-team/ to current run folder, e.g. "runs/20260528-020041-task" */
  runDir: string
  /** Global pipeline Manager: one slot that stays alive across all stages to
   *  coordinate Workers. null = no global Manager for this run. */
  globalManager: GlobalManagerRef | null
}

const pipeline = reactive<PipelineRun>({
  task: '',
  workspacePath: '',
  stageIndex: -1,
  state: 'idle',
  log: [],
  projectId: '',
  projectFile: '',
  pipelineLogFile: '',
  backendLogFile: '',
  runDir: '',
  globalManager: null
})

const showCompletionModal = ref(false)
const showSettings = ref(false)
const showHistory = ref(false)
const confirmKillAll = ref(false)

function onFocusPane(paneId: string): void {
  focusPaneId.value = paneId
  nextTick(() => {
    const el = document.querySelector(`[data-pane-id="${paneId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

function onReviveAgent(entry: SpawnHistoryEntry): void {
  void onManualSpawn({
    agentKey: entry.agentKey,
    roleKey: entry.roleKey,
    stageId: '',
    workspacePath: entry.workspacePath || currentWorkspace.value,
  })
  showHistory.value = false
}
watch(() => pipeline.state, (newState, oldState) => {
  if (newState === 'completed' && oldState === 'running') {
    showCompletionModal.value = true
  }
})

const pipelineView = computed<PipelineStatusView>(() => ({
  state: pipeline.state,
  stageIndex: Math.max(0, pipeline.stageIndex),
  totalStages: stagesApi.stages.value.length || pipeline.stageIndex + 1,
  task: pipeline.task,
  workspacePath: pipeline.workspacePath,
  log: pipeline.log,
  projectId: pipeline.projectId,
  projectFile: pipeline.projectFile,
  pipelineLogFile: pipeline.pipelineLogFile,
  backendLogFile: pipeline.backendLogFile
}))

interface ProjectSlot {
  label: string
  agent: string
  role: string
  pane_id?: string | null
  spawn_status: string   // 'pending' | 'spawned' | 'removed'
  kickoff_status: string // 'none' | 'sent' | 'failed'
  session_id?: string    // CLI session id for resume-on-restart ('' if unknown)
}

interface ProjectStage {
  stage_id: string
  status: string
  pane_id?: string | null
  slots?: ProjectSlot[]
}

interface ProjectManualPane {
  pane_id: string
  agent: string
  role: string
  command: string
  spawn_status: string
  session_id?: string
}

interface ProjectPayload {
  project: {
    id: string
    name: string
    workspace_path: string
    state?: string
    current_stage_index?: number
    total_stages?: number
    task_description?: string
    stages?: ProjectStage[]
    manual_panes?: ProjectManualPane[]
    updated_at?: string
    layout_mode?: string
    pipeline_id?: string
    run_count?: number
  } | null
  paths: { dir: string; project_file: string; pipeline_log: string; backend_log: string } | null
  resume_index?: number
}

interface SessionExistsPayload {
  exists: boolean
}

function looksLikeResumeCommand(agentKey: string, command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  if (agentKey === 'codex') return /^codex\s+resume\s+\S+/.test(cmd)
  return new RegExp(`^${agentKey}\\s+--resume\\s+\\S+`).test(cmd)
}

async function canResumeSession(
  agentKey: string,
  workspacePath: string,
  sessionId: string
): Promise<boolean> {
  if (!sessionId.trim()) return false
  const resp = await sendQuiet<SessionExistsPayload>('agent.session_exists', {
    agent: agentKey,
    workspace_path: workspacePath,
    session_id: sessionId,
  })
  return resp?.exists === true
}

function applyProjectPaths(p: ProjectPayload | undefined): void {
  if (!p) return
  pipeline.projectId = p.project?.id ?? ''
  pipeline.projectFile = p.paths?.project_file ?? ''
  pipeline.pipelineLogFile = p.paths?.pipeline_log ?? ''
  pipeline.backendLogFile = p.paths?.backend_log ?? ''
  pipeline.runDir = (p.paths as Record<string, string> | null)?.run_dir ?? ''
}

// ─────────── Existing-project peek for Resume banner ───────────

const existingProject = ref<ExistingProjectInfo | null>(null)
const controlPaneRef = ref<InstanceType<typeof ControlPane> | null>(null)

// ─────────── Workspace mode detection (phase-5) ───────────
// Derived from project.peek: drives which ControlPane sections lead (phase-6).
//   no project        → spawn      (fresh / empty folder)
//   state completed   → completed  (pipeline finished — show history / start over)
//   running or has task→ pipeline  (configured pipeline workspace)
//   otherwise         → spawn
const currentMode = ref<WorkspaceMode>('spawn')
let workspaceCheckSeq = 0

function detectMode(payload: ProjectPayload | null): WorkspaceMode {
  const proj = payload?.project
  if (!proj) return 'spawn'
  if (proj.state === 'completed') return 'completed'
  if (proj.state === 'running' || (proj.task_description ?? '').trim()) return 'pipeline'
  return 'spawn'
}

function buildExistingProjectInfo(payload: ProjectPayload | null): ExistingProjectInfo | null {
  if (!payload?.project || !payload.paths) return null
  const proj = payload.project
  const stages = proj.stages ?? []
  const completed = stages.filter((s) => s.status === 'completed').length
  let nextIdx = -1
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].status !== 'completed') {
      nextIdx = i
      break
    }
  }
  if (stages.length === 0) return null
  const validState = (['idle', 'running', 'completed', 'aborted'] as const).includes(
    (proj.state as never) ?? 'idle'
  )
    ? (proj.state as ExistingProjectInfo['state'])
    : 'idle'
  return {
    projectId: proj.id,
    name: proj.name,
    state: validState,
    taskDescription: proj.task_description ?? '',
    currentStageIndex: proj.current_stage_index ?? -1,
    totalStages: proj.total_stages ?? stages.length,
    stagesCompleted: completed,
    nextStageIndex: nextIdx,
    updatedAt: proj.updated_at ?? '',
    projectFile: payload.paths.project_file,
    pipelineId: (proj.pipeline_id as string | undefined) ?? '',
    runCount: (proj.run_count as number | undefined) ?? 0
  }
}

async function onWorkspaceCheck(path: string): Promise<void> {
  const seq = ++workspaceCheckSeq
  if (!path) {
    existingProject.value = null
    currentMode.value = 'spawn'
    pipeline.workspacePath = ''
    return
  }
  const resp = await sendQuiet<ProjectPayload>('project.peek', { workspace_path: path })
  if (seq !== workspaceCheckSeq) return
  if (pipeline.state !== 'running') pipeline.workspacePath = path
  existingProject.value = resp ? buildExistingProjectInfo(resp) : null
  currentMode.value = detectMode(resp)
  applyProjectPaths(resp ?? undefined)
  if (resp?.project) {
    const savedMode = resp.project.layout_mode
    if (savedMode === 'auto' || savedMode === 'grid' || savedMode === 'spotlight' || savedMode === 'fullscreen') {
      layoutMode.value = savedMode
    } else {
      layoutMode.value = 'grid'
    }
    // Decision 8: project.pipeline_id takes priority — sync global active pipeline.
    const savedPipelineId = resp.project.pipeline_id as string | undefined
    if (savedPipelineId && pipelinesApi.pipelines.value.some((p) => p.id === savedPipelineId)) {
      if (savedPipelineId !== pipelinesApi.activePipelineId.value) {
        await pipelinesApi.setActivePipeline(savedPipelineId)
        await stagesApi.refresh()
      }
    }
    await restoreWorkspacePanes(resp, path)
  }
}

/** Re-spawn CLI panes for all slots recorded in project.json.
 *  Called on workspace load so terminal screens appear immediately without
 *  waiting for the user to click Resume.
 *
 *  Slots with a persisted session_id are relaunched with the CLI's resume
 *  command so the agent's prior conversation memory is restored — but nothing
 *  is injected (no role, no kickoff): the pane sits idle with memory loaded
 *  until the user drives it. Slots without an id fall back to a fresh spawn
 *  (role re-injected), the same as before this feature. */
async function restoreWorkspacePanes(payload: ProjectPayload, workspacePath: string): Promise<void> {
  // Don't restore if pipeline is active or paused — panes are already alive.
  if (pipeline.state === 'running' || pipeline.state === 'aborted') return
  const stages = payload.project?.stages ?? []
  const spawned = stages.flatMap((stage, i) =>
    (stage.slots ?? [])
      .filter((sl) => sl.spawn_status === 'spawned')
      .map((sl) => ({ stageIndex: i, stageId: stage.stage_id, slot: sl }))
  )
  const manualPanes = (payload.project?.manual_panes ?? []).filter(
    (p) => p.spawn_status === 'spawned'
  )
  if (spawned.length === 0 && manualPanes.length === 0) return
  const resumable = spawned.filter((s) => (s.slot.session_id ?? '').trim()).length
  const resumableManual = manualPanes.filter((p) => (p.session_id ?? '').trim()).length
  pipelineLog(
    `↩ Restoring ${spawned.length} slot pane(s) and ${manualPanes.length} manual pane(s) — ${resumable + resumableManual} with memory`
  )
  pipeline.workspacePath = workspacePath
  await Promise.all(spawned.map(async ({ stageIndex, stageId, slot }) => {
    const sessionId = (slot.session_id ?? '').trim()
    const spec = agentSpecs.find((s) => s.agentKey === slot.agent)
    const skipFlag = yoloEnabled.value ? (spec?.skipPermissionFlag ?? '') : ''
    const resumeCmd = buildResumeCommand(slot.agent, sessionId, skipFlag)
    const isResume = !!resumeCmd
    const paneId = await spawnPane({
      agentKey: slot.agent as AgentKey,
      roleKey: slot.role,
      stageId: stageId as StageId,
      slotLabel: slot.label,
      commandOverride: resumeCmd, // '' when no session_id → fresh spawn fallback
      workspacePath,
      origin: 'pipeline',
      isResume,
      // Resume restores memory; don't re-inject role/kickoff (decision: load
      // memory only, wait for the user). Fresh fallback keeps prior behaviour.
      skipRoleInjection: isResume,
    })
    if (paneId) {
      await sendQuiet('pipeline.slot_spawn', {
        workspace_path: workspacePath,
        stage_index: stageIndex,
        slot_label: slot.label,
        pane_id: paneId,
        agent: slot.agent,
        role: slot.role,
        session_id: sessionId, // preserve the id across the new pane id
      })
    }
  }))
  await Promise.all(manualPanes.map(async (saved) => {
    const sessionId = (saved.session_id ?? '').trim()
    const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
    const skipFlag = yoloEnabled.value ? (spec?.skipPermissionFlag ?? '') : ''
    const canResume = await canResumeSession(saved.agent, workspacePath, sessionId)
    const resumeCmd = canResume ? buildResumeCommand(saved.agent, sessionId, skipFlag) : ''
    const isResume = !!resumeCmd
    const fallbackCommand = looksLikeResumeCommand(saved.agent, saved.command) ? '' : saved.command
    const paneId = await spawnPane({
      agentKey: saved.agent as AgentKey,
      roleKey: saved.role,
      stageId: '',
      commandOverride: resumeCmd || fallbackCommand || '',
      workspacePath,
      origin: 'manual',
      isResume,
      skipRoleInjection: isResume,
    })
    if (paneId) {
      await sendQuiet<ProjectPayload>('manual_pane.spawn', {
        workspace_path: workspacePath,
        pane_id: paneId,
        previous_pane_id: saved.pane_id,
        agent: saved.agent,
        role: saved.role,
        command: fallbackCommand,
        session_id: canResume ? sessionId : '',
      })
      if (sessionId && !canResume) {
        await sendQuiet('manual_pane.session', {
          workspace_path: workspacePath,
          pane_id: paneId,
          session_id: '',
        })
      }
    }
  }))

  // Backfill removed manual panes into spawnHistory so Agent History shows past sessions.
  // Spawned panes are already added via spawnPane() above; this covers the removed ones.
  const removedManual = (payload.project?.manual_panes ?? []).filter(
    (p) => p.spawn_status === 'removed'
  )
  const existingPaneIds = new Set(spawnHistory.value.map((e) => e.paneId))
  const fallbackTs = payload.project?.updated_at ?? new Date().toISOString()
  const backfilledIds = new Set<string>()
  for (const saved of removedManual) {
    if (existingPaneIds.has(saved.pane_id)) continue
    const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
    spawnHistory.value.push({
      paneId: saved.pane_id,
      agentKey: saved.agent,
      agentLabel: spec?.label ?? saved.agent,
      roleKey: saved.role as RoleKey,
      roleLabel: roleLabel(saved.role),
      command: saved.command ?? '',
      sessionId: (saved.session_id ?? '').trim() || undefined,
      origin: 'manual',
      stageId: '' as StageId,
      workspacePath,
      spawnedAt: fallbackTs,
      removedAt: fallbackTs,
    })
    backfilledIds.add(saved.pane_id)
  }

  // Enrich backfilled entries with real timestamps from history.jsonl.
  // history.snapshot logs every pane event as "[pane <id-prefix>] ..." in summary;
  // we take the first/last ts per prefix to get accurate spawnedAt / removedAt.
  if (backfilledIds.size > 0) {
    try {
      type HistSnap = { events: Array<{ ts: string; summary: string }> }
      const histResp = await sendQuiet<HistSnap>('history.snapshot', { workspace_path: workspacePath })
      const events = histResp?.events
      if (Array.isArray(events)) {
        const paneRe = /\[pane ([a-f0-9]{8})\]/
        const paneTs = new Map<string, { first: string; last: string }>()
        for (const ev of events) {
          const m = paneRe.exec(ev.summary ?? '')
          if (!m) continue
          const prefix = m[1]
          const cur = paneTs.get(prefix)
          if (!cur) paneTs.set(prefix, { first: ev.ts, last: ev.ts })
          else {
            if (ev.ts < cur.first) cur.first = ev.ts
            if (ev.ts > cur.last) cur.last = ev.ts
          }
        }
        for (const entry of spawnHistory.value) {
          if (!backfilledIds.has(entry.paneId)) continue
          const ts = paneTs.get(entry.paneId.slice(0, 8))
          if (!ts) continue
          entry.spawnedAt = ts.first
          entry.removedAt = ts.last
        }
      }
    } catch {
      // non-fatal — fallback timestamps remain
    }
  }
}

async function onRefreshAnalyzer(): Promise<void> {
  pipelineLog('🧠 refreshing analyzer health + model list')
  const h = await analyzerApi.refreshHealth()
  if (h?.ok) {
    await analyzerApi.refreshModels()
    pipelineLog(
      `🧠 ${analyzerApi.models.value.length} model(s) · Ollama ${h.version}`
    )
  } else {
    pipelineLog(`🧠 Ollama unreachable: ${h?.error ?? 'unknown'}`)
  }
}


async function onPipelineRestart(payload: { task: string; workspacePath: string }): Promise<void> {
  // Cancel any running watchers / questions left from a previous attempt
  // before we overwrite project state.
  cancelAllWatchers()
  activeQuestion.value = null
  // Kill any pipeline-origin panes still hanging around so we get a clean grid.
  for (const p of [...panes.value]) {
    if (p.origin === 'pipeline') await onKill(p.id, { markRemoved: false })
  }
  pipelineLog('↺ Start over — wiping previous stages and re-running from 01')
  await onPipelineStart(payload)
}

async function onPipelineResume(): Promise<void> {
  const info = existingProject.value
  if (!info) return
  if (info.nextStageIndex < 0) return
  // Wire the local pipeline state from the existing project, then call the
  // backend's resume endpoint and spawn the resume stage.
  pipeline.task = info.taskDescription
  pipeline.workspacePath = info.projectFile.replace(/\/\.agent-team\/project\.json$/, '')
  pipeline.stageIndex = info.nextStageIndex
  pipeline.state = 'running'
  pipeline.log = []
  pipelineLog(`Resuming pipeline · jumping to Stage ${stagesApi.stages.value[info.nextStageIndex]?.id}`)
  const resp = await sendQuiet<ProjectPayload>('pipeline.resume', {
    workspace_path: pipeline.workspacePath
  })
  applyProjectPaths(resp ?? undefined)
  // Refresh the peek so the banner disappears now that we're running.
  existingProject.value = null
  // Panes were already restored by restoreWorkspacePanes on workspace load.
  // activateStage builds context from prior stages and injects kickoffs.
  await activateStage(info.nextStageIndex)
}

async function sendQuiet<T = unknown>(
  type: string,
  payload: Record<string, unknown>
): Promise<T | null> {
  try {
    const resp = await backend.send<T>(type, payload)
    if (!resp.ok) {
      pipelineLog(`${type} failed: ${resp.error?.message ?? 'unknown'}`)
      return null
    }
    return resp.payload
  } catch (err) {
    pipelineLog(`${type} threw: ${String((err as Error).message ?? err)}`)
    return null
  }
}

/** Fetch framework docs from Context7 via MCP. Returns "" on failure (best-effort). */
async function fetchDocPrefix(stageDocQuery: string): Promise<string> {
  if (!pipeline.task) return ''
  try {
    const resp = await backend.send<{ doc_prefix: string }>(
      'pipeline.fetch_docs',
      {
        task: pipeline.task,
        doc_query: stageDocQuery,
        workspace_path: pipeline.workspacePath ?? '',
        analyzer_model: analyzerModel.value,
      },
      90_000   // 90 s — LLM detect + Context7 cold-start + relevance pass
    )
    if (resp.ok && resp.payload?.doc_prefix) {
      pipelineLog(`📚 注入 ${resp.payload.doc_prefix.length} 字元（LLM強化）`)
      return resp.payload.doc_prefix
    }
  } catch {
    // silent — kickoff still works without docs
  }
  return ''
}

function pipelineLog(line: string): void {
  const ts = new Date().toLocaleTimeString()
  const entry = `[${ts}] ${line}`
  pipeline.log.push(entry)
  if (pipeline.log.length > 200) pipeline.log.splice(0, pipeline.log.length - 200)
  // Persist to the run-specific pipeline log when a workspace is active.
  if (pipeline.workspacePath) {
    backend.send('project.log_event', {
      workspace_path: pipeline.workspacePath,
      event_type: 'orchestrator_log',
      pane_id: '',
      details: { line: entry }
    }).catch(() => { /* ignore */ })
  }
}

/** Spawn all slots for one stage WITHOUT injecting kickoffs.
 *  Each slot gets its role prompt (via watchPaneStartup) then waits at the
 *  interactive prompt. Call activateStage() later to inject the kickoff. */
async function preSpawnStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })
  pipelineLog(`Stage ${stage.id} ⚡ pre-spawn ${stage.slots.length} slot(s) (role only)`)
  await Promise.all(stage.slots.map(async (slot) => {
    pipelineLog(`Stage ${stage.id}/${slot.label} → pre-spawn ${slot.agentKey} as ${slot.roleKey}`)
    const paneId = await spawnPane({
      agentKey: slot.agentKey as AgentKey,
      roleKey: slot.roleKey,
      stageId: stage.id,
      slotLabel: slot.label,
      commandOverride: '',
      workspacePath: pipeline.workspacePath,
      origin: 'pipeline',
      // No kickoffPrompt → kickoffStatus='none' → scheduleInjection stops after role
    })
    if (paneId) {
      await sendQuiet<ProjectPayload>('pipeline.slot_spawn', {
        workspace_path: pipeline.workspacePath,
        stage_index: index,
        slot_label: slot.label,
        pane_id: paneId,
        agent: slot.agentKey,
        role: slot.roleKey,
        // Claude's pinned id is known now; Codex/Gemini stay "" until detected.
        session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
      })
    }
  }))
}

/** Build cross-stage context for ONE slot's kickoff — doc-driven, not inlined.
 *
 *  Replaces the old "paste up to 60KB of prior terminal buffers into every
 *  kickoff" approach (which produced ~68KB kickoffs that broke bracketed-paste
 *  submission and stalled stage hand-off). Now:
 *    • Workers get a short tail-summary (final output is usually at the end) plus
 *      the relative path to each prior output log — kickoff stays small; the
 *      agent reads the file on demand for detail.
 *    • The Manager gets the full roster of every prior output file with an
 *      instruction to read them all — it coordinates, so it needs the whole
 *      history, not just summaries.
 *  Paths are relative to the workspace (the agent's cwd), so the CLI can open
 *  them directly. Uses prevPane.outputLogFile + the live cleanBuffer. */
function buildStageContext(index: number, forManager: boolean): string {
  const WORKER_SUMMARY = 1200
  const blocks: string[] = []
  for (let i = 0; i < index; i++) {
    const prevStage = stagesApi.stages.value[i]
    if (!prevStage) continue
    const prevPanes = panes.value.filter(
      (p) => p.stageId === prevStage.id && p.origin === 'pipeline'
    )
    for (const prevPane of prevPanes) {
      const label = prevPane.slotLabel
        ? `${prevStage.title} · ${prevPane.slotLabel}`
        : prevStage.title
      const relPath =
        prevPane.outputLogFile && pipeline.workspacePath
          ? prevPane.outputLogFile.replace(`${pipeline.workspacePath}/`, '')
          : (prevPane.outputLogFile ?? '')
      if (forManager) {
        blocks.push(`- [${label}] 📄 ${relPath || '(無 log 檔)'}`)
      } else {
        const ref = paneRefs[prevPane.id]
        const buf = ((ref?.cleanBuffer as unknown as string) ?? '').trim()
        if (!buf && !relPath) continue
        const summary =
          buf.length > WORKER_SUMMARY ? `…${buf.slice(-WORKER_SUMMARY)}` : buf || '(無輸出)'
        blocks.push(`- [${label}]\n  摘要：${summary}\n  📄 完整內容：${relPath || '(無 log 檔)'}`)
      }
    }
  }
  if (blocks.length === 0) return ''
  return forManager
    ? `[完整前置歷程 — 你是 Manager，負責協調，請逐一完整讀取下列檔案]\n${'='.repeat(60)}\n${blocks.join('\n')}\n${'='.repeat(60)}\n\n`
    : `[前置階段產出 — 下為摘要，需要細節請讀對應檔案]\n${'='.repeat(60)}\n${blocks.join(`\n${'─'.repeat(60)}\n`)}\n${'='.repeat(60)}\n（開始前請先讀取與你任務相關的檔案）\n\n`
}

/** Inject kickoffs into pre-spawned panes for one stage, then arm watchers.
 *  Builds cross-stage context from prior stages (which now have real output).
 *  Safe to call on a freshly-spawned stage too (same as old spawnPipelineStage). */
async function activateStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return

  // Cross-stage context is now built per-slot inside the loop below (doc-driven:
  // summaries + file paths for workers, full file roster for the Manager).
  const docPrefix = await fetchDocPrefix(stage.docQuery ?? '')

  const managerSlot: StageSlot | null = stageCommanderSlot(stage)
  const otherSlotsRoster = managerSlot
    ? stage.slots
        .filter((s) => s !== managerSlot)
        .map((s) => ({
          label: s.label,
          agentLabel: agentSpecs.find((a) => a.agentKey === s.agentKey)?.label ?? s.agentKey,
          roleLabel: roleLabel(s.roleKey),
        }))
    : []

  pipelineLog(
    `Stage ${stage.id} ▶ activate ${stage.slots.length} slot(s)` +
    (managerSlot ? ` · 🎯 Manager: ${managerSlot.label}` : '')
  )

  // Reset completion tracker in case it was partially consumed
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })

  await Promise.all(stage.slots.map(async (slot) => {
    // Per-slot cross-stage context: workers get summaries + paths, the Manager
    // gets the full prior-output file roster (it coordinates, needs everything).
    const contextHeader = buildStageContext(index, slot === managerSlot)
    // Find the pre-spawned pane for this slot
    const pane = panes.value.find(
      (p) => p.stageId === stage.id && p.slotLabel === slot.label && p.origin === 'pipeline'
    )

    if (!pane) {
      // Fallback: slot was never pre-spawned — spawn it now with kickoff
      pipelineLog(`Stage ${stage.id}/${slot.label} → not pre-spawned, spawning now`)
      const kickoff =
        docPrefix + contextHeader +
        renderSlotKickoff(slot, pipeline.task, {
          allowQuestions: stage.allowQuestions,
          isCommander: slot === managerSlot,
          hasCommander: !!managerSlot && slot !== managerSlot,
          commanderLabel: managerSlot?.label,
          slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
        })
      const paneId = await spawnPane({
        agentKey: slot.agentKey as AgentKey,
        roleKey: slot.roleKey,
        stageId: stage.id,
        slotLabel: slot.label,
        commandOverride: '',
        workspacePath: pipeline.workspacePath,
        origin: 'pipeline',
        kickoffPrompt: kickoff
      })
      if (paneId) {
        await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
          workspace_path: pipeline.workspacePath,
          stage_index: index,
          pane_id: paneId,
          agent: slot.agentKey,
          role: slot.roleKey
        })
        if (managerSlot) {
          const router = ensureStageRouter(index)
          if (slot === managerSlot) router.managerPaneId = paneId
          else router.workerPaneIds.set(slot.label, paneId)
        }
      }
      return
    }

    const tag = `[${stage.id}/${slot.label}]`

    // Wait for scheduleInjection to finish role injection before sending kickoff.
    // Must wait for 'sent'/'failed'/'skipped' — 'scheduled' means scheduleInjection
    // has started but the role bytes haven't hit the agent yet. Injecting kickoff
    // while status is still 'scheduled' causes the agent to receive the task before
    // its role context, so it has no instructions and does nothing.
    const ROLE_WAIT_MS = 60_000
    const t0 = Date.now()
    while (
      (pane.injectionStatus === 'pending' || pane.injectionStatus === 'scheduled') &&
      Date.now() - t0 < ROLE_WAIT_MS
    ) {
      await sleep(500)
    }
    if (!paneAlive(pane.id)) return

    // If role was deferred (skipRoleInjection), inject it now before kickoff
    if (pane.injectionStatus === 'skipped') {
      const role = rolesApi.find(pane.roleKey)
      if (!role) {
        pipelineLog(`${tag} ✕ role '${pane.roleKey}' not found`)
        return
      }
      const roleContent = role.system_prompt + ROLE_STANDBY_SUFFIX + sessionMarkerLine(pane.sessionMarker)
      pipelineLog(`${tag} ➜ injecting role '${role.label}' (deferred, ${roleContent.length} chars)`)
      // bracketed paste (preserveNewlines) — same as kickoff — to avoid a raw
      // keystroke burst flooding the PTY input buffer.
      const roleOk = await injectPane(pane.id, roleContent, `role:${role.label}`, true)
      pane.injectionStatus = roleOk ? 'sent' : 'failed'
      syncViews()
      if (!roleOk) {
        // Honest record: role didn't land. Continue to kickoff anyway (agent
        // may recover; watcher backstop covers a genuine no-start).
        pipelineLog(`${tag} ✕ deferred role injection failed (agent didn't react) — continuing anyway`)
      } else {
        pipelineLog(`${tag} ✓ role injected`)
      }
      // Wait for agent to acknowledge the role before injecting kickoff
      const settleResult = await waitForActivityThenSettle(pane.id, 2500, 30_000)
      if (!paneAlive(pane.id)) return
      if (settleResult === 'no-activity') {
        pipelineLog(`${tag} ⚠ agent silent after role — sending kickoff anyway`)
      }
    }

    const kickoff =
      docPrefix + contextHeader +
      renderSlotKickoff(slot, pipeline.task, {
        allowQuestions: stage.allowQuestions,
        isCommander: slot === managerSlot,
        hasCommander: !!managerSlot && slot !== managerSlot,
        commanderLabel: managerSlot?.label,
        slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
      }) +
      sessionMarkerLine(pane.sessionMarker)
    pipelineLog(`${tag} ➜ injecting kickoff (${kickoff.length} chars)`)
    const MAX_KICKOFF_ATTEMPTS = 3
    let ok = false
    for (let attempt = 1; attempt <= MAX_KICKOFF_ATTEMPTS; attempt++) {
      ok = await injectPane(pane.id, kickoff, `kickoff:stage-${stage.id}`, true)
      if (ok) break
      if (attempt < MAX_KICKOFF_ATTEMPTS) {
        pipelineLog(`${tag} ✕ kickoff injection failed (attempt ${attempt}/${MAX_KICKOFF_ATTEMPTS}) — retrying in 3s`)
        await sleep(3_000)
        if (!paneAlive(pane.id)) return
      }
    }
    pane.kickoffStatus = ok ? 'sent' : 'failed'
    syncViews()
    await sendQuiet('pipeline.slot_kickoff', {
      workspace_path: pipeline.workspacePath,
      stage_index: index,
      slot_label: slot.label,
      kickoff_status: ok ? 'sent' : 'failed',
    })
    if (!ok) {
      pipelineLog(`${tag} ✕ kickoff injection failed after ${MAX_KICKOFF_ATTEMPTS} attempts — arming watcher anyway`)
    } else {
      pipelineLog(`${tag} ✓ kickoff sent`)
    }

    // For question-interactive stages (P01): capture scanFrom AFTER kickoff is
    // confirmed so the watcher only scans content produced after the kickoff.
    // For other stages: pass undefined — startStageWatcher uses markBufferPosition()
    // at arm time, and the agentGenerating guard handles the stabilisation wait.
    const kickoffScanFrom = stage.allowQuestions
      ? (paneRefs[pane.id]?.markBufferPosition as () => number | undefined)?.()
      : undefined

    // Notify backend: mark this stage running (and previous completed).
    // Same role as pipeline.stage_spawn in the old spawnPipelineStage flow.
    const stageResp = await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
      workspace_path: pipeline.workspacePath,
      stage_index: index,
      pane_id: pane.id,
      agent: slot.agentKey,
      role: slot.roleKey,
    })
    applyProjectPaths(stageResp ?? undefined)

    // Wire Manager router
    if (managerSlot) {
      const router = ensureStageRouter(index)
      if (slot === managerSlot) router.managerPaneId = pane.id
      else router.workerPaneIds.set(slot.label, pane.id)
    }

    startStageWatcher(index, pane.id, kickoffScanFrom)
  }))

  if (managerSlot) {
    startRouterPoll(index)
    pipelineLog(`Stage ${stage.id} 🎯 Manager router poll started`)
  }
}

async function spawnPipelineStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return

  // Cross-stage context is built per-slot inside the loop below (doc-driven:
  // summaries + file paths for workers, full file roster for the Manager) —
  // no more inlining up to 60KB of prior buffers into every kickoff.

  // Fetch framework docs from Context7 — best-effort, non-blocking on failure
  const docPrefix = await fetchDocPrefix(stage.docQuery ?? '')

  // Detect Manager designation (at most one per stage; ignored for lone slots).
  const managerSlot: StageSlot | null = stageCommanderSlot(stage)
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })
  pipelineLog(
    `Stage ${stage.id} → ${stage.slots.length} agent(s)` +
    (managerSlot ? ` · 🎯 Manager: ${managerSlot.label}` : '')
  )

  // For Manager-mode kickoff rendering: prepare slot roster for Manager,
  // and labels of other slots for Workers.
  const otherSlotsRoster = managerSlot
    ? stage.slots
        .filter((s) => s !== managerSlot)
        .map((s) => ({
          label: s.label,
          agentLabel:
            agentSpecs.find((a) => a.agentKey === s.agentKey)?.label ?? s.agentKey,
          roleLabel: roleLabel(s.roleKey),
        }))
    : []

  await Promise.all(stage.slots.map(async (slot) => {
    const contextHeader = buildStageContext(index, slot === managerSlot)
    const kickoff =
      docPrefix +
      contextHeader +
      renderSlotKickoff(slot, pipeline.task, {
        allowQuestions: stage.allowQuestions,
        isCommander: slot === managerSlot,
        hasCommander: !!managerSlot && slot !== managerSlot,
        commanderLabel: managerSlot?.label,
        slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
      })
    pipelineLog(
      `Stage ${stage.id}/${slot.label} → spawn ${slot.agentKey} as ${slot.roleKey}` +
      (slot === managerSlot ? ' 🎯' : managerSlot ? ' (worker)' : '')
    )
    const paneId = await spawnPane({
      agentKey: slot.agentKey as AgentKey,
      roleKey: slot.roleKey,
      stageId: stage.id,
      slotLabel: slot.label,
      commandOverride: '',
      workspacePath: pipeline.workspacePath,
      origin: 'pipeline',
      kickoffPrompt: kickoff
    })
    if (paneId) {
      const resp = await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
        workspace_path: pipeline.workspacePath,
        stage_index: index,
        pane_id: paneId,
        agent: slot.agentKey,
        role: slot.roleKey
      })
      applyProjectPaths(resp ?? undefined)
      // Wire Manager-mode router: track this pane's role.
      if (managerSlot) {
        const router = ensureStageRouter(index)
        if (slot === managerSlot) {
          router.managerPaneId = paneId
        } else {
          router.workerPaneIds.set(slot.label, paneId)
        }
      }
    }
  }))

  // Manager-mode: start the per-stage router poll loop (scans buffers,
  // routes ASK/REPORT/DISPATCH/MANAGER-READY/STAGE-DONE).
  if (managerSlot) {
    startRouterPoll(index)
    pipelineLog(`Stage ${stage.id} 🎯 Manager router poll started (${ROUTER_POLL_MS / 1000}s)`)
  }
}

async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string }): Promise<void> {
  // If a specific pipeline was requested and it's not currently active, switch first.
  if (payload.pipelineId && payload.pipelineId !== pipelinesApi.activePipelineId.value) {
    await pipelinesApi.setActivePipeline(payload.pipelineId, payload.workspacePath)
    // Reload stages for the newly-active pipeline before running.
    await stagesApi.refresh()
  }
  if (!stagesApi.isLoaded.value || stagesApi.stages.value.length === 0) {
    pipelineLog('Pipeline start skipped: stages not loaded yet. Please wait and try again.')
    return
  }
  pipeline.task = payload.task
  pipeline.workspacePath = payload.workspacePath
  pipeline.stageIndex = 0
  pipeline.state = 'running'
  // Derive global commander from stage config (slot with isCommander=true).
  let globalManager: GlobalManagerRef | null = null
  for (const s of stagesApi.stages.value) {
    const cmdSlot = s.slots.find((sl) => sl.isCommander)
    if (cmdSlot) {
      globalManager = { stageId: s.id, slotLabel: cmdSlot.label }
      break
    }
  }
  pipeline.globalManager = globalManager
  pipeline.log = []
  pipelineLog(`Pipeline started · ${stagesApi.stages.value.length} stages · cwd=${payload.workspacePath}`)
  const stageBlueprint = stagesApi.stages.value.map((s) => ({
    stage_id: s.id,
    title: s.title,
    sentinel: s.sentinel ?? '',
    slots: s.slots.map((sl) => ({ agent: sl.agentKey, role: sl.roleKey, label: sl.label }))
  }))
  const resp = await sendQuiet<ProjectPayload>('pipeline.start', {
    workspace_path: payload.workspacePath,
    task_description: payload.task,
    total_stages: stagesApi.stages.value.length,
    stage_blueprint: stageBlueprint,
    pipeline_id: pipelinesApi.activePipelineId.value,
  })
  applyProjectPaths(resp ?? undefined)
  if (resp?.paths) {
    pipelineLog(`project.json → ${resp.paths.project_file}`)
    pipelineLog(`pipeline.log → ${resp.paths.pipeline_log}`)
  }
  // Clear any stale Resume banner since we just overwrote project state.
  existingProject.value = null
  // Pre-spawn all stage slots simultaneously (role prompt only, no kickoff).
  await Promise.all(stagesApi.stages.value.map((_, i) => preSpawnStage(i)))
  // Activate stage 0: build context + inject kickoffs + arm watchers.
  await activateStage(0)
  // Start the global Manager cross-stage router (if configured).
  if (pipeline.globalManager) startGlobalManagerRouter()
}

/** Before firing 🎉 on the final stage, wait until every pipeline pane has
 *  stopped producing output (raw PTY quiet for `quietMs`) so we don't claim
 *  "done" while a worker is still flushing files / writing a final commit.
 *  Gives up after `hardCapMs` so a chatty TUI can't block the UI forever. */
async function waitForStagePanesSettled(
  stageIndex: number,
  options: { quietMs?: number; hardCapMs?: number } = {}
): Promise<void> {
  const quietMs = options.quietMs ?? 5_000
  const hardCapMs = options.hardCapMs ?? 120_000

  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const stagePanes = panes.value.filter(
    (p) => p.stageId === stage.id && p.origin === 'pipeline'
  )
  if (stagePanes.length === 0) return

  const startedAt = Date.now()
  while (Date.now() - startedAt < hardCapMs) {
    if (pipeline.state !== 'running') return
    const now = Date.now()
    const stillBusy: string[] = []
    for (const pane of stagePanes) {
      const ref = paneRefs[pane.id]
      const lastRaw = (ref?.lastRawActivityAt as unknown as number) ?? 0
      const quietFor = lastRaw === 0 ? Infinity : now - lastRaw
      if (quietFor < quietMs) {
        const label = pane.slotLabel || pane.id.slice(0, 8)
        stillBusy.push(`${label}(busy ${Math.round(quietFor / 1000)}s)`)
      }
    }

    if (stillBusy.length === 0) {
      pipelineLog(`Stage ${stage.id} ✓ all ${stagePanes.length} pane(s) quiet`)
      return
    }
    pipelineLog(`Stage ${stage.id} ⏳ waiting on: ${stillBusy.join(', ')}`)
    await sleep(3_000)
  }
  pipelineLog(
    `Stage ${stage.id} ⏰ settle cap ${Math.round(hardCapMs / 1000)}s — firing completion anyway`
  )
}

/** Resolve the live pane id for the global Manager (null if not configured or
 *  not yet spawned). Used by the cross-stage router to inject messages. */
function globalManagerPaneId(): string | null {
  const gm = pipeline.globalManager
  if (!gm) return null
  const pane = panes.value.find(
    (p) => p.stageId === gm.stageId && p.slotLabel === gm.slotLabel && p.origin === 'pipeline'
  )
  return pane?.id ?? null
}

async function onPipelineNext(): Promise<void> {
  if (pipeline.state !== 'running') return
  const currentIndex = pipeline.stageIndex
  // Tear down the current stage's Manager router (if any) before advancing.
  // BUT: if this stage contains the global Manager pane, do NOT cancel its
  // watcher — it stays alive and keeps listening across all future stages.
  const gm = pipeline.globalManager
  const currentStage = stagesApi.stages.value[currentIndex]
  const isGlobalManagerStage = gm && currentStage?.id === gm.stageId
  if (isGlobalManagerStage) {
    // Cancel all watchers EXCEPT the global Manager pane itself.
    const managerPaneId = globalManagerPaneId()
    for (const [pid, w] of [...watchers.entries()]) {
      if (pid !== managerPaneId) cancelWatcher(pid)
    }
    pipelineLog(`Stage ${currentStage?.id} 🎯 Global Manager pane stays alive across stages`)
  }
  disposeStageRouter(currentIndex)
  const nextIndex = currentIndex + 1
  if (nextIndex >= stagesApi.stages.value.length) {
    // Final stage finished. Wait for every pane in this stage to be raw-PTY
    // quiet before firing 🎉 so we don't claim "done" while a worker is
    // still flushing files / writing a final commit.
    await waitForStagePanesSettled(currentIndex)
    stopGlobalManagerRouter()
    pipeline.state = 'completed'
    currentMode.value = 'completed'
    pipelineLog('🎉 Pipeline completed all stages')
    const resp = await sendQuiet<ProjectPayload>('pipeline.complete', {
      workspace_path: pipeline.workspacePath
    })
    applyProjectPaths(resp ?? undefined)
    return
  }
  pipeline.stageIndex = nextIndex
  await activateStage(nextIndex)
}

async function onPipelineAbort(): Promise<void> {
  if (pipeline.state !== 'running') return
  pipeline.state = 'aborted'
  pipelineLog('Pipeline aborted by user')
  stopGlobalManagerRouter()
  cancelAllWatchers()
  stageCompletions.clear()
  for (const k of Array.from(stageRouters.keys())) disposeStageRouter(k)
  questionQueue.length = 0
  if (activeQuestion.value) activeQuestion.value = null
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  // Abort = PAUSE, not kill: stop the orchestration (watchers/routers/questions)
  // but leave the spawned agents and their panes alive so the run can be
  // resumed later via the Resume banner. (Reset is the destructive one.)
  const resp = await sendQuiet<ProjectPayload>('pipeline.abort', {
    workspace_path: pipeline.workspacePath,
    reason: 'user'
  })
  applyProjectPaths(resp ?? undefined)
  // Refresh existingProject so the Resume banner appears immediately in the
  // same session without requiring the user to switch workspaces and back.
  if (pipeline.workspacePath) await onWorkspaceCheck(pipeline.workspacePath)
}

async function onPipelineReset(): Promise<void> {
  cancelAllWatchers()
  stageCompletions.clear()
  for (const k of Array.from(stageRouters.keys())) disposeStageRouter(k)
  questionQueue.length = 0
  activeQuestion.value = null
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  // Reset is the destructive action: tear down ALL panes (pipeline + manual) so
  // the workspace returns to a clean slate. onKill handles each pane's
  // watcher/timer/session teardown and removes it from the view.
  await onKillAll()
  pipeline.task = ''
  pipeline.stageIndex = -1
  pipeline.state = 'idle'
  pipeline.log = []
  pipeline.projectId = ''
  pipeline.projectFile = ''
  pipeline.pipelineLogFile = ''
  pipeline.backendLogFile = ''
  pipeline.runDir = ''
}

// ─────────── Switch / close workspace (phase-7) ───────────
// Returns to the Welcome picker. The Welcome screen doubles as the switcher
// (recent + browse). A running pipeline triggers a confirm first; on confirm we
// abort it (record kept on disk → resumable) and kill all panes. Idle /
// completed / aborted close immediately.
const confirmCloseWorkspace = ref<boolean>(false)

function onSwitchWorkspace(): void {
  if (pipeline.state === 'running') {
    confirmCloseWorkspace.value = true
    return
  }
  void doCloseWorkspace()
}

async function doCloseWorkspace(): Promise<void> {
  confirmCloseWorkspace.value = false
  if (pipeline.state === 'running') await onPipelineAbort()
  await onPipelineReset()
  existingProject.value = null
  currentMode.value = 'spawn'
  pipeline.workspacePath = ''
  workspaceSelected.value = false
  currentWorkspace.value = ''
  try {
    sessionStorage.removeItem(WS_SELECTED_KEY)
    sessionStorage.removeItem(WS_PATH_KEY)
  } catch {
    /* ignore */
  }
}

// Triggered by the Browse button in ControlPane. Behaves like picking a workspace
// from the Welcome screen: reset all state first, then let the workspace-check
// debounce fire naturally once currentWorkspace drives the prop update.
async function onWorkspaceBrowse(path: string): Promise<void> {
  if (path === currentWorkspace.value) return
  if (pipeline.state === 'running') await onPipelineAbort()
  pipeline.workspacePath = ''
  await onPipelineReset()
  existingProject.value = null
  currentMode.value = 'spawn'
  pipeline.workspacePath = path
  currentWorkspace.value = path
  try {
    sessionStorage.setItem(WS_PATH_KEY, path)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* ignore */
  }
}

// ──────────────── Continuous-mode watcher + question alerts ────────────────

// Absolute ceiling on a single stage so a wedged agent can't block the
// pipeline forever. The agent's own sentinel (or the analyzer reading its
// output) ends a stage long before this — the cap is just a backstop.
const STAGE_MAX_DURATION_MS = 15 * 60_000

// turn_complete must remain the LATEST signal this long before it counts as
// completion — lets the buffer's QUESTION text (which can lag the hook/JSONL
// event) render and be caught by question detection first. See turnCompleteDone.
const TURN_COMPLETE_SETTLE_MS = 1500

// Multi-slot analyzer-completion FALLBACK: the buffer must be quiet at least
// this long before we trust the analyzer's "completion" on a multi-slot stage.
// Single-slot has no handoff pollution so it doesn't need this; multi-slot does
// — a sibling churns right after a handoff injection, and a short post-handoff
// pause must NOT be mistaken for completion (the Stage 04 early-advance bug).
// This quiet window is the PTY buffer's lastActivityAt (frontend-local, NOT the
// attribution-routed agent_active), so it's immune to pane mis-attribution.
const MULTISLOT_ANALYZER_CONFIRM_MS = 20_000

interface StageWatcher {
  paneId: string
  stageIndex: number
  scanFrom: number
  pollHandle: number | null
  cancelled: boolean
  waitingForAnswer: boolean
  /** Wall-clock ms when the last answer was injected (0 = no pending answer).
   *  Used to detect "CLI stuck at ❯ after answer" — if lastActivityAt stops
   *  updating (spinner gone) N seconds after injection, Claude needs a nudge. */
  answeredAt: number
  armedAt: number
  analyzerBusy: boolean
  analyzerCooldownUntil: number
  lastAnalyzedBufferLen: number
  /** Buffer length recorded at the END of the previous poll tick.
   *  Used to detect "agent still generating" — if buf.length > lastPollBufLen
   *  the buffer is growing and question detection is deferred one tick. */
  lastPollBufLen: number
  /** Byte offset into the outputLogFile already scanned for sentinel.
   *  Lets us scan only new bytes each poll — more reliable than cleanBuffer
   *  which can be truncated or have scanFrom pushed past the sentinel. */
  logFileOffset: number
  /** Minimum safe scanFrom: set in startStageWatcher by scanning for any
   *  pre-existing sentinel in the buffer (e.g. old session history replayed
   *  via `claude resume`). Buffer-cap resets use this instead of 0 to avoid
   *  re-detecting the sentinel from a previous run. */
  minScanFrom: number
}

// Keyed by paneId so multiple parallel agents in the same stage each get
// their own watcher without clobbering each other.
const watchers = new Map<string, StageWatcher>()

// Tracks how many parallel agent slots each stage has and how many have
// already completed, so we only advance the pipeline when ALL are done.
const stageCompletions = new Map<number, { expected: number; done: Set<string> }>()

// ── Per-pane turn-complete signal (CLI lifecycle, not a buffer guess) ────────
// The backend broadcasts `agent.activity` with event_type "turn_complete" when
// a CLI ends its turn (Claude Stop hook = 100% reliable, or JSONL turn-end for
// Codex/Gemini). We record the wall-clock time per pane. A pane only counts as
// "turn complete for the current stage" when this timestamp is AFTER the
// watcher armed (see slotFinished), so a stale signal from a prior stage/turn
// is never reused — no explicit reset needed.
const paneTurnCompleteAt = new Map<string, number>()

// Per-pane wall-clock of the latest `agent_active` (CLI is producing output or
// running a tool). Compared against turnCompleteAt to tell whether the CLI's
// MOST RECENT signal was "working" vs "turn ended" — the core of the CLI-state
// model that replaces buffer-guessing.
const paneLastActiveAt = new Map<string, number>()

// When each pane's watcher armed (start of its current stage). Kept in its own
// Map — NOT on the watcher — so it survives cancelWatcher(), letting the stall
// path (whose watcher is already cancelled) still judge slotFinished correctly.
const paneArmedAt = new Map<string, number>()

// CLI lifecycle events (the reliable, non-buffer signal). agent_active = the CLI
// is working; turn_complete = its turn ended. We timestamp both per pane; the
// completion logic reads these instead of guessing from the TUI buffer.
backend.on('agent.activity', (raw) => {
  const ev = raw as { event_type?: string; pane_id?: string; vendor?: string; session_id?: string }
  if (!ev?.pane_id) return
  if (ev.event_type === 'turn_complete') {
    paneTurnCompleteAt.set(ev.pane_id, Date.now())
  } else if (ev.event_type === 'agent_active') {
    paneLastActiveAt.set(ev.pane_id, Date.now())
  }
  if (ev.vendor === 'claude' && ev.session_id) {
    const pane = panes.value.find((p) => p.id === ev.pane_id)
    if (pane?.origin === 'manual') {
      pane.pinnedSessionId = ev.session_id
      syncViews()
      void persistPaneSession(pane, ev.session_id)
      const h = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
      if (h) h.sessionId = ev.session_id
    }
  }
})

// Codex/Gemini can't pin a session id at launch, so the backend detects it from
// the session file (matched by the marker we embedded in the kickoff) and emits
// session.detected. We persist it to project.json so the pane can be resumed
// with the agent's prior conversation on the next App restart.
backend.on('session.detected', (raw) => {
  const ev = raw as { pane_id?: string; session_id?: string }
  if (!ev?.pane_id || !ev.session_id) return
  const pane = panes.value.find((p) => p.id === ev.pane_id)
  if (!pane) return
  pane.pinnedSessionId = ev.session_id
  syncViews()
  const histSd = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
  if (histSd) histSd.sessionId = ev.session_id
  if (pane.origin === 'manual') {
    pipelineLog(`Manual ${pane.agentKey} 🔖 session 已綁定`)
    void persistPaneSession(pane, ev.session_id)
    return
  }
  if (!pane.slotLabel || pane.origin !== 'pipeline') return
  const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
  if (stageIndex < 0) return
  pipelineLog(`Stage ${pane.stageId}/${pane.slotLabel} 🔖 session 已綁定 (${pane.agentKey})`)
  void persistPaneSession(pane, ev.session_id)
})

// ── Exception tracking → supervision log ────────────────────────────────────
// Surface uncaught frontend errors into the pipeline log so a silent exception
// during stage supervision is visible HERE (rendered red), not just buried in
// devtools. The `❌` prefix is what ControlPane's classifier matches to colour
// the line. These are window-level nets; targeted try/catch still logs its own.
window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''
  pipelineLog(`❌ exception: ${e.message}${where}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason)
  pipelineLog(`❌ unhandled rejection: ${reason}`)
})

// How a slot was judged finished — recorded for history.jsonl auditing so a
// stage_advance can be traced to N/N reliable signals (vs a forced advance).
type SlotFinishReason = 'sentinel' | 'turn_complete' | 'analyzer' | 'cap-auto' | 'force'

// Build a SlotSignal per pipeline slot of a stage, for allSlotsFinished(). A
// slot already counted as done is finished by definition; otherwise we read its
// live signals (sentinel in buffer, turn_complete after armed). Used by the
// stall path to refuse a blind advance.
function computeStageSlotSignals(stageIndex: number): SlotSignal[] {
  const stage = stagesApi.stages.value[stageIndex]
  const tracker = stageCompletions.get(stageIndex)
  if (!stage || !tracker) return []
  const stagePanes = panes.value.filter(
    (p) => p.stageId === stage.id && p.origin === 'pipeline'
  )
  // Fewer live panes than slots → some slot never spawned; never "all finished".
  if (stagePanes.length < tracker.expected) return []
  return stagePanes.map((p) => {
    // A slot already counted as done is finished by definition. A slot that
    // printed its sentinel was added to `done` by the watcher, so we do NOT
    // re-scan the buffer here — scanning from 0 risks matching a sentinel
    // echoed inside the kickoff. `done` IS the reliable sentinel record.
    if (tracker.done.has(p.id)) {
      return { sentinelSeen: true, turnCompleteAt: 0, armedAt: 0 }
    }
    // Not yet done → rely on the turn_complete lifecycle signal only.
    return {
      sentinelSeen: false,
      turnCompleteAt: paneTurnCompleteAt.get(p.id) ?? 0,
      // No recorded arm time → treat turn_complete as unusable (stay cautious).
      armedAt: paneArmedAt.get(p.id) ?? Number.MAX_SAFE_INTEGER
    }
  })
}

// ── Manager-mode router (event-driven, per-stage) ───────────────────────────
// Set when stage.slots contains an entry with isCommander=true. The router
// scans pane buffers for sentinel blocks (ASK/REPORT/DISPATCH/MANAGER-READY/
// STAGE-DONE) and routes messages between Manager and Worker panes.
interface PendingMessage {
  fromLabel: string   // worker slot label
  kind: 'ASK' | 'REPORT'
  content: string
}
interface StageRouter {
  managerPaneId: string                  // empty until manager pane spawned
  /** Worker slot label → pane id (for routing DISPATCH targets). */
  workerPaneIds: Map<string, string>
  /** True once Manager printed ---MANAGER-READY---. Before that, all ASK /
   *  REPORT messages from workers are buffered here. */
  managerReady: boolean
  /** Queue of worker messages awaiting Manager-ready. */
  preReadyQueue: PendingMessage[]
  /** Per-pane scan cursor (Manager pane and each worker pane). */
  cursors: Map<string, number>
  /** True once STAGE-DONE has fired so we don't double-fire. */
  finished: boolean
  /** setInterval handle for the router scan loop. */
  pollHandle: number | null
}
const stageRouters = new Map<number, StageRouter>()

const ROUTER_POLL_MS = 4_000

function ensureStageRouter(stageIndex: number): StageRouter {
  let r = stageRouters.get(stageIndex)
  if (!r) {
    r = {
      managerPaneId: '',
      workerPaneIds: new Map(),
      managerReady: false,
      preReadyQueue: [],
      cursors: new Map(),
      finished: false,
      pollHandle: null,
    }
    stageRouters.set(stageIndex, r)
  }
  return r
}

function startRouterPoll(stageIndex: number): void {
  const router = stageRouters.get(stageIndex)
  if (!router || router.pollHandle !== null) return
  router.pollHandle = window.setInterval(() => {
    void managerRouterScan(stageIndex)
  }, ROUTER_POLL_MS)
}

function disposeStageRouter(stageIndex: number): void {
  const r = stageRouters.get(stageIndex)
  if (r?.pollHandle !== null && r?.pollHandle !== undefined) {
    window.clearInterval(r.pollHandle)
  }
  stageRouters.delete(stageIndex)
}

interface ActiveQuestionItem {
  prompt: string
  type: 'text' | 'choice'
  options: string[]
}
interface ActiveQuestion {
  paneId: string
  stageIndex: number
  questions: ActiveQuestionItem[]
  agentLabel: string
  stageTitle: string
  /** Slot label, e.g. "Architecture" or "UI/UX" for parallel-stage panes. */
  slotLabel: string
}
const activeQuestion = ref<ActiveQuestion | null>(null)
// FIFO queue: when a second (parallel) agent asks a question while the user
// is still answering the first, we buffer it here and show it next.
const questionQueue: ActiveQuestion[] = []
// Reactive count so the template can show "N more waiting"
const questionQueueLen = ref(0)

// ── Stage-stall confirmation state (strict mode) ────────────────────────────
interface StageStallPrompt {
  paneId: string
  stageIndex: number
  stageId: string
  stageTitle: string
  slotLabel: string
  reason: 'idle' | 'cap'
  detail: string                 // e.g. "no output for 92s"
  autoAdvanceAt: number | null   // wall-clock ms when Full auto will fire (null = manual only)
}
const stageStallPrompt = ref<StageStallPrompt | null>(null)
let stageStallAutoTimer: number | null = null

// ── Auto-answer state ───────────────────────────────────────────────────────
/** true while waiting for LLM to return an auto-answer */
const autoAnswerPending = ref(false)
/** The LLM-generated answer text (shown in the QuestionAlert before auto-submit) */
const autoAnswerText = ref('')

/**
 * Called whenever autoAnswerEnabled is on and a question is shown.
 * Sends the questions to the backend LLM, shows the result in the alert for
 * 1.5 s, then auto-submits identical to the user pressing "Send answer".
 */
async function triggerAutoAnswer(q: ActiveQuestion): Promise<void> {
  const stage = stagesApi.stages.value[q.stageIndex]
  autoAnswerPending.value = true
  autoAnswerText.value = ''
  pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answering ${q.questions.length} question(s)…`)
  // Track whether we handed off to a re-trigger so the finally block doesn't
  // clear autoAnswerPending that was just set by the new call.
  let reTriggered = false
  try {
    // Local LLM inference takes 30-60 s on typical hardware. The default
    // backend.send timeout is 10 s — far too short, causing every auto-answer
    // call to time-out, drop back to manual mode, and leave the user waiting.
    // Use 120 s (matching the llama-cli hard timeout in analyzer.py).
    const AUTO_ANSWER_TIMEOUT_MS = 120_000
    let resp: Awaited<ReturnType<typeof backend.send<{ ok: boolean; answer: string; answers: string[] }>>>
    try {
      resp = await backend.send<{ ok: boolean; answer: string; answers: string[] }>(
        'pipeline.auto_answer',
        {
          questions: q.questions,
          task: pipeline.task,
          stage_title: stage?.title ?? '',
          model: analyzerModel.value || undefined,
          workspace_path: pipeline.workspacePath || undefined,
          stage_id: stage?.id ?? undefined,
          pane_id: q.paneId
        },
        AUTO_ANSWER_TIMEOUT_MS
      )
    } catch (sendErr) {
      // WebSocket send timeout or network error — log and fall through to manual.
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer error: ${(sendErr as Error).message ?? sendErr} — 請手動回答`)
      return
    }
    if (!resp.ok || !resp.payload?.ok || !resp.payload.answer) {
      // Log the raw error so users can diagnose "思考後沒有答案" cases.
      // Common causes: LLM format unrecognized, empty output, model unavailable.
      const detail = resp.error?.message ?? (resp.payload ? `payload.ok=${resp.payload.ok} answer="${resp.payload.answer}"` : 'null payload')
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer failed (${detail}) — 請手動回答`)
      return
    }
    autoAnswerText.value = resp.payload.answer
    pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer ready: ${resp.payload.answer.slice(0, 80)}`)
    // Display for 1.5 s so user can see what was auto-answered before it submits.
    await sleep(1500)
    if (activeQuestion.value?.paneId === q.paneId) {
      const currentQ = activeQuestion.value
      // Detect if the question was upgraded from text → choice while the LLM
      // was running (PTY-noise recovery path: block parser defaulted to text,
      // then the analyzer found options and called enqueueQuestion with
      // upgradeInPlace=true).  If so, re-trigger with the choice version so the
      // LLM can pick from the actual options rather than sending free text.
      const wasUpgradedToChoice =
        q.questions.every((oq) => oq.type === 'text') &&
        currentQ.questions.some((cq) => cq.type === 'choice' && cq.options.length > 0)
      // Reset pending flag BEFORE calling onAnswerQuestion / triggerAutoAnswer so
      // that the synchronous dequeueNextQuestion() inside onAnswerQuestion sees
      // autoAnswerPending = false and correctly triggers auto-answer for the next
      // queued question.  Without this, queued questions are permanently stranded.
      autoAnswerPending.value = false
      autoAnswerText.value = ''
      if (wasUpgradedToChoice) {
        pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 question upgraded to choice — re-running auto-answer`)
        reTriggered = true  // prevent finally from clearing the new call's flag
        void triggerAutoAnswer(currentQ)
      } else {
        await onAnswerQuestion(resp.payload.answer, resp.payload.answers ?? [resp.payload.answer])
      }
    } else {
      // Active question changed while LLM was running (user dismissed / stage advanced).
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer discarded — question no longer active`)
      autoAnswerPending.value = false
      autoAnswerText.value = ''
    }
  } finally {
    // Safety net for error/early-return paths.
    // Skip the reset when we've already handed off to a re-trigger call that is
    // now running and holds its own autoAnswerPending=true.
    if (!reTriggered) {
      autoAnswerPending.value = false
      autoAnswerText.value = ''
    }
  }
}

/**
 * Set the displayed question or, if one is already active, push to the queue.
 * When `upgradeInPlace` is true, replace activeQuestion directly (text→choice
 * upgrade from the analyzer for the same pane already showing a question).
 */
function enqueueQuestion(q: ActiveQuestion, upgradeInPlace = false): void {
  if (upgradeInPlace && activeQuestion.value?.paneId === q.paneId) {
    activeQuestion.value = q
    // If auto-answer had already finished (or failed) for the text version,
    // autoAnswerPending is false and no auto-answer is running for the newly
    // upgraded choice question — trigger it now.
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(q)
    }
    return
  }
  if (!activeQuestion.value) {
    activeQuestion.value = q
    // Auto-answer: trigger immediately when this becomes the active question
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(q)
    }
  } else {
    // Replace any existing queued entry for the same pane (avoids duplicates)
    const idx = questionQueue.findIndex((qi) => qi.paneId === q.paneId)
    if (idx >= 0) {
      questionQueue[idx] = q
    } else {
      questionQueue.push(q)
      questionQueueLen.value = questionQueue.length
      pipelineLog(
        `Stage ${stagesApi.stages.value[q.stageIndex]?.id} ⏳ "${q.slotLabel || q.paneId.slice(0, 8)}" question queued (${questionQueue.length} waiting)`
      )
    }
  }
}

/** Show the next queued question after the user answers / dismisses the current one. */
function dequeueNextQuestion(): void {
  const next = questionQueue.shift() ?? null
  questionQueueLen.value = questionQueue.length
  activeQuestion.value = next
  if (next) {
    pipelineLog(
      `Stage ${stagesApi.stages.value[next.stageIndex]?.id} ❓ now showing "${next.slotLabel || next.paneId.slice(0, 8)}" question (${questionQueue.length} still waiting)`
    )
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(next)
    }
  }
}

// ── Stage-stall handlers ────────────────────────────────────────────────────
function clearStageStallAutoTimer(): void {
  if (stageStallAutoTimer !== null) {
    window.clearTimeout(stageStallAutoTimer)
    stageStallAutoTimer = null
  }
}

/** Raise the stall prompt — called when idle/cap fires in strict mode. */
function promptStageStall(
  stageIndex: number,
  paneId: string,
  reason: 'idle' | 'cap',
  detail: string
): void {
  // Don't stack prompts: if one is already showing, just log and let it resolve
  if (stageStallPrompt.value) {
    pipelineLog(`Stage stall (${reason}) suppressed — another prompt already showing`)
    return
  }
  const stage = stagesApi.stages.value[stageIndex]
  const paneMeta = panes.value.find((p) => p.id === paneId)
  const FULL_AUTO_GRACE_MS = 5000
  stageStallPrompt.value = {
    paneId,
    stageIndex,
    stageId: stage?.id ?? '?',
    stageTitle: stage?.title ?? '',
    slotLabel: paneMeta?.slotLabel ?? '',
    reason,
    detail,
    autoAdvanceAt: autoAnswerEnabled.value ? Date.now() + FULL_AUTO_GRACE_MS : null
  }
  // Full auto: after the grace period, advance ONLY when every slot has a
  // reliable finish signal (sentinel / turn_complete). Otherwise keep waiting —
  // never the old blind 5s push. We restart the watcher so a signal arriving
  // later still completes the slot promptly. The user can always click 強制推進
  // to override manually (forceAdvanceStall has no such gate).
  if (autoAnswerEnabled.value) {
    clearStageStallAutoTimer()
    const multiSlot = (stage?.slots.length ?? 1) > 1
    stageStallAutoTimer = window.setTimeout(() => {
      const p = stageStallPrompt.value
      if (!p || p.paneId !== paneId) return
      // Single-slot stages keep the original blind force-advance (acceptance:
      // single-slot behaviour unchanged). Only multi-slot stages get the
      // allSlotsFinished gate, so a real N/N is required before advancing.
      if (!multiSlot) {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto force-advanced after ${FULL_AUTO_GRACE_MS / 1000}s`)
        forceAdvanceStall()
        return
      }
      if (allSlotsFinished(computeStageSlotSignals(p.stageIndex))) {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto advanced after ${FULL_AUTO_GRACE_MS / 1000}s — all slots finished`)
        forceAdvanceStall()
      } else {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto held — not all slots finished, keep waiting`)
        continueWaitingStall()
      }
    }, FULL_AUTO_GRACE_MS)
  }
}

/** User clicked "繼續等待" — restart the watcher with fresh timers. */
function continueWaitingStall(): void {
  const p = stageStallPrompt.value
  if (!p) return
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  if (p.stageIndex !== pipeline.stageIndex) return  // stage already moved on
  pipelineLog(`Stage ${p.stageId} ⏯ continue waiting on "${p.slotLabel || p.paneId.slice(0, 8)}"`)
  // Restart the watcher: armedAt = now resets BOTH idle and cap counters
  startStageWatcher(p.stageIndex, p.paneId)
}

/** User clicked "強制推進" (or Full auto fired) — mark slot done. */
function forceAdvanceStall(): void {
  const p = stageStallPrompt.value
  if (!p) return
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  pipelineLog(`Stage ${p.stageId} ⏭ force-advanced after ${p.reason}: ${p.detail}`)
  onStageSlotCompleted(p.stageIndex, p.paneId, 'force')
}

/** Cancel the watcher for a single pane. */
function cancelWatcher(paneId: string): void {
  const w = watchers.get(paneId)
  if (!w) return
  w.cancelled = true
  if (w.pollHandle !== null) window.clearInterval(w.pollHandle)
  watchers.delete(paneId)
}

/** Cancel all watchers whose stageIndex matches — used when aborting/resetting. */
function cancelStageWatchers(stageIndex: number): void {
  for (const [paneId, w] of [...watchers.entries()]) {
    if (w.stageIndex === stageIndex) cancelWatcher(paneId)
  }
}

function cancelAllWatchers(): void {
  for (const paneId of [...watchers.keys()]) cancelWatcher(paneId)
  // Full reset (pipeline abort/complete): drop per-pane lifecycle signals so a
  // new run never inherits a prior pane's arm time / turn_complete and the maps
  // don't grow across runs. (The armedAt comparison already guards correctness;
  // this is hygiene.) cancelWatcher (single pane) intentionally does NOT clear
  // these — the stall path needs paneArmedAt after its watcher is cancelled.
  paneArmedAt.clear()
  paneTurnCompleteAt.clear()
  paneLastActiveAt.clear()
}

// ── Manager-mode router: parsers + scan + route ─────────────────────────────

const DISPATCH_RE = /---DISPATCH-START---([\s\S]*?)---DISPATCH-END---/g
const ASK_RE = /---ASK-START---([\s\S]*?)---ASK-END---/g
const REPORT_RE = /---REPORT-START---([\s\S]*?)---REPORT-END---/g

interface ParsedDispatch { to: string; message: string }

/** Parse content-bearing message blocks (ASK / REPORT) from a worker buffer
 *  region. Each block's `content:` field captures everything until the END
 *  marker (multi-line OK). Returns blocks + new cursor advanced past the
 *  last consumed block. */
function parseContentBlocks(
  buf: string,
  fromCursor: number,
  re: RegExp
): { items: string[]; newCursor: number } {
  const region = buf.slice(fromCursor)
  const items: string[] = []
  let lastEnd = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(region)) !== null) {
    const inner = m[1]
    // `content:` consumes everything to end of inner block.
    const cm = inner.match(/(?:^|\n)\s*content:\s*([\s\S]*)$/)
    if (cm) {
      items.push(cm[1].trim())
    } else {
      // Tolerant fallback: take inner trimmed if no `content:` prefix.
      const trimmed = inner.trim()
      if (trimmed) items.push(trimmed)
    }
    lastEnd = m.index + m[0].length
  }
  return { items, newCursor: fromCursor + lastEnd }
}

/** Parse DISPATCH blocks from a Manager buffer region. */
function parseDispatchBlocks(
  buf: string,
  fromCursor: number
): { items: ParsedDispatch[]; newCursor: number } {
  const region = buf.slice(fromCursor)
  const items: ParsedDispatch[] = []
  let lastEnd = 0
  DISPATCH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DISPATCH_RE.exec(region)) !== null) {
    const inner = m[1]
    const toMatch = inner.match(/^\s*to:\s*(.+?)\s*$/m)
    const msgMatch = inner.match(/(?:^|\n)\s*message:\s*([\s\S]*)$/)
    if (toMatch && msgMatch) {
      const to = toMatch[1].trim()
      // Ignore the placeholder block when the Manager echoes the prompt
      // template verbatim (e.g. `to: <slot label>`) — `<...>` is never a real
      // slot label, so it would only log a spurious "找不到 slot" skip.
      if (!/^<.*>$/.test(to)) {
        items.push({ to, message: msgMatch[1].trim() })
      }
    }
    lastEnd = m.index + m[0].length
  }
  return { items, newCursor: fromCursor + lastEnd }
}

/** Find the worker pane whose label best matches `to`. Exact (case-insensitive)
 *  → substring either direction → null. */
function matchWorkerByLabel(router: StageRouter, to: string): { paneId: string; label: string } | null {
  const needle = to.trim().toLowerCase()
  if (!needle) return null
  for (const [label, paneId] of router.workerPaneIds) {
    if (label.toLowerCase() === needle) return { paneId, label }
  }
  for (const [label, paneId] of router.workerPaneIds) {
    const lbl = label.toLowerCase()
    if (lbl && (lbl.includes(needle) || needle.includes(lbl))) return { paneId, label }
  }
  return null
}

/** Scan all Manager-mode panes in the current stage for sentinel blocks +
 *  route messages. Called by startStageWatcher on each poll tick. */
async function managerRouterScan(stageIndex: number): Promise<void> {
  if (stageIndex !== pipeline.stageIndex || pipeline.state !== 'running') return
  const router = stageRouters.get(stageIndex)
  const stage = stagesApi.stages.value[stageIndex]
  if (!router || !stage || router.finished) return

  // ── Worker panes: scan for ASK / REPORT ───────────────────────────────────
  for (const [label, paneId] of router.workerPaneIds) {
    const ref = paneRefs[paneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    if (!buf) continue
    const cursor = router.cursors.get(paneId) ?? 0
    const askRes = parseContentBlocks(buf, cursor, ASK_RE)
    const reportRes = parseContentBlocks(buf, cursor, REPORT_RE)
    const newCursor = Math.max(askRes.newCursor, reportRes.newCursor, cursor)
    router.cursors.set(paneId, newCursor)
    for (const content of askRes.items) {
      queueOrRouteWorkerMsg(router, stage.id, { fromLabel: label, kind: 'ASK', content })
    }
    for (const content of reportRes.items) {
      queueOrRouteWorkerMsg(router, stage.id, { fromLabel: label, kind: 'REPORT', content })
    }
  }

  // ── Manager pane: detect MANAGER-READY → drain queue ──────────────────────
  if (router.managerPaneId && !router.managerReady) {
    const ref = paneRefs[router.managerPaneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    const cursor = router.cursors.get(router.managerPaneId) ?? 0
    if (findSentinel(buf, MANAGER_READY_SENTINEL, cursor) >= 0) {
      router.managerReady = true
      pipelineLog(`Stage ${stage.id} 🎯 Manager READY — 開始控場（drain ${router.preReadyQueue.length} 則訊息）`)
      const drain = router.preReadyQueue.splice(0)
      for (const msg of drain) {
        await injectManagerPane(router, msg)
      }
    }
  }

  // ── Manager pane: scan for DISPATCH + STAGE-DONE ──────────────────────────
  if (router.managerPaneId) {
    const ref = paneRefs[router.managerPaneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    const cursor = router.cursors.get(router.managerPaneId) ?? 0
    const { items: dispatches, newCursor } = parseDispatchBlocks(buf, cursor)
    router.cursors.set(router.managerPaneId, newCursor)
    for (const d of dispatches) {
      const target = matchWorkerByLabel(router, d.to)
      if (!target) {
        pipelineLog(`Stage ${stage.id} 🎯 dispatch 找不到 slot "${d.to}" — skip`)
        continue
      }
      const preview = d.message.slice(0, 50).replace(/\s+/g, ' ')
      pipelineLog(`Stage ${stage.id} 🎯 → ${target.label}: ${preview}${d.message.length > 50 ? '…' : ''}`)
      await injectPane(
        target.paneId,
        `[→ DISPATCH FROM Manager]\n${d.message}`,
        `manager-dispatch:${target.label}`,
        true
      )
    }
    if (!router.finished && findSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, 0) >= 0) {
      router.finished = true
      pipelineLog(`Stage ${stage.id} 🎯 Manager 印 ${MANAGER_STAGE_DONE_SENTINEL} — 收尾`)
      stageCompletions.delete(stageIndex)
      void onPipelineNext()
    }
  }
}

function queueOrRouteWorkerMsg(router: StageRouter, stageId: string, msg: PendingMessage): void {
  if (!router.managerReady) {
    router.preReadyQueue.push(msg)
    pipelineLog(`Stage ${stageId} 🎯 ${msg.kind} from ${msg.fromLabel} 暫存（Manager 還沒 READY，已存 ${router.preReadyQueue.length} 則）`)
    return
  }
  void injectManagerPane(router, msg)
  pipelineLog(`Stage ${stageId} 🎯 → Manager: [${msg.kind} from ${msg.fromLabel}]`)
}

async function injectManagerPane(router: StageRouter, msg: PendingMessage): Promise<void> {
  if (!router.managerPaneId) return
  const text = `[→ ${msg.kind} FROM ${msg.fromLabel}]\n${msg.content}`
  await injectPane(router.managerPaneId, text, `${msg.kind.toLowerCase()}:${msg.fromLabel}`, true)
}

// ── Global Manager cross-stage router ────────────────────────────────────────
// When a global Manager is configured, scan every currently-active Worker pane
// (any stage) for ASK/REPORT blocks and route them to the global Manager pane.
// Also scans the global Manager's buffer for DISPATCH blocks and injects them
// into the target Worker. Runs on the same cadence as the stage router (2s).

let globalRouterHandle: number | null = null
const globalRouterCursors = new Map<string, number>()

function startGlobalManagerRouter(): void {
  if (globalRouterHandle !== null) return
  if (!pipeline.globalManager) return
  pipelineLog(`🎯 Global Manager router started (${pipeline.globalManager.stageId}/${pipeline.globalManager.slotLabel})`)
  globalRouterHandle = window.setInterval(() => { void globalManagerRouterScan() }, 2000)
}

function stopGlobalManagerRouter(): void {
  if (globalRouterHandle !== null) {
    window.clearInterval(globalRouterHandle)
    globalRouterHandle = null
    globalRouterCursors.clear()
    pipelineLog('🎯 Global Manager router stopped')
  }
}

async function globalManagerRouterScan(): Promise<void> {
  if (pipeline.state !== 'running') return
  const managerPaneId = globalManagerPaneId()
  if (!managerPaneId) return
  const gm = pipeline.globalManager!

  // Scan all active Worker panes (any stage, not the Manager itself) for ASK/REPORT
  const workerPanes = panes.value.filter(
    (p) => p.origin === 'pipeline' && p.id !== managerPaneId &&
           !(p.stageId === gm.stageId && p.slotLabel === gm.slotLabel)
  )
  for (const wp of workerPanes) {
    const ref = paneRefs[wp.id]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    if (!buf) continue
    const cursor = globalRouterCursors.get(wp.id) ?? 0
    const askRes = parseContentBlocks(buf, cursor, ASK_RE)
    const reportRes = parseContentBlocks(buf, cursor, REPORT_RE)
    const newCursor = Math.max(askRes.newCursor, reportRes.newCursor, cursor)
    if (newCursor > cursor) globalRouterCursors.set(wp.id, newCursor)
    const fromLabel = wp.slotLabel || wp.stageId
    for (const content of askRes.items) {
      pipelineLog(`🎯 Global → Manager: [ASK from ${fromLabel}]`)
      await injectPane(managerPaneId, `[→ ASK FROM ${fromLabel} (Stage ${wp.stageId})]\n${content}`, `ask:${fromLabel}`, true)
    }
    for (const content of reportRes.items) {
      pipelineLog(`🎯 Global → Manager: [REPORT from ${fromLabel}]`)
      await injectPane(managerPaneId, `[→ REPORT FROM ${fromLabel} (Stage ${wp.stageId})]\n${content}`, `report:${fromLabel}`, true)
    }
  }

  // Scan Manager pane for DISPATCH → route to target Worker by label
  const mRef = paneRefs[managerPaneId]
  const mBuf: string = (mRef?.cleanBuffer as unknown as string) ?? ''
  const mCursor = globalRouterCursors.get(managerPaneId) ?? 0
  const { items: dispatches, newCursor: mNew } = parseDispatchBlocks(mBuf, mCursor)
  if (mNew > mCursor) globalRouterCursors.set(managerPaneId, mNew)
  for (const d of dispatches) {
    const target = panes.value.find(
      (p) => p.origin === 'pipeline' && p.id !== managerPaneId &&
             p.slotLabel.toLowerCase() === d.to.toLowerCase()
    )
    if (!target) {
      pipelineLog(`🎯 Global DISPATCH 找不到 slot "${d.to}" — skip`)
      continue
    }
    pipelineLog(`🎯 Global → ${target.slotLabel} (Stage ${target.stageId}): ${d.message.slice(0, 50).replace(/\s+/g, ' ')}`)
    await injectPane(target.id, `[→ DISPATCH FROM Manager]\n${d.message}`, `manager-dispatch:${target.slotLabel}`, true)
  }
}

/**
 * Called whenever one parallel slot in a stage finishes.
 * Advances the pipeline only after ALL expected slots are done.
 *
 * Cross-agent handoff: when a slot finishes early, its tail output is
 * injected into still-running sibling panes as a brief context update so
 * they can incorporate the completed work without waiting for a full restart.
 */
function onStageSlotCompleted(
  stageIndex: number,
  paneId: string,
  reason: SlotFinishReason = 'sentinel'
): void {
  if (stageIndex !== pipeline.stageIndex) return  // stale
  const tracker = stageCompletions.get(stageIndex)
  if (!tracker) { void onPipelineNext(); return }
  if (tracker.done.has(paneId)) return  // guard against double-fire
  tracker.done.add(paneId)
  const remaining = tracker.expected - tracker.done.size
  const stage = stagesApi.stages.value[stageIndex]
  const completedPane = panes.value.find((p) => p.id === paneId)
  const slotName = completedPane?.slotLabel || paneId.slice(0, 8)
  // Audit trail (→ history.jsonl): every slot finish records its reason so a
  // stage advance can be verified as N/N reliable signals, not a blind push.
  pipelineLog(
    `Stage ${stage?.id} ✓ slot "${slotName}" finished via ${reason}` +
    ` (${tracker.done.size}/${tracker.expected})`
  )
  if (remaining > 0) {
    pipelineLog(`Stage ${stage?.id} ⏳ waiting for ${remaining} more slot(s)`)

    // ── Cross-agent handoff ────────────────────────────────────────────────
    // Inject the completed slot's tail output into still-running siblings so
    // they can reference each other's work. Wait briefly for siblings to
    // settle between thoughts before sending the handoff message.
    const completedRef = paneRefs[paneId]
    const completedBuf: string = (completedRef?.cleanBuffer as unknown as string) ?? ''
    if (completedPane && completedBuf.trim() && stage) {
      const MAX_HANDOFF = 3000
      const rawSnippet = completedBuf.length > MAX_HANDOFF
        ? completedBuf.slice(completedBuf.length - MAX_HANDOFF)
        : completedBuf
      // Strip the completed slot's sentinel from the handoff text. Otherwise the
      // still-running sibling's watcher detects this sentinel echoed into its OWN
      // buffer and falsely marks itself done — firing pipeline-complete while the
      // sibling is still working (the "fireworks mid-development" bug). The
      // sentinel is a completion marker, not content, so dropping it is lossless.
      const snippet = stage.sentinel
        ? rawSnippet.split(stage.sentinel).join('〈完成標記〉')
        : rawSnippet
      const fromLabel = completedPane.slotLabel || stage.id
      // Find sibling panes that are still running (not in done set)
      const siblingPanes = panes.value.filter(
        (p) =>
          p.stageId === stage.id &&
          p.origin === 'pipeline' &&
          p.id !== paneId &&
          !tracker.done.has(p.id)
      )
      for (const sibling of siblingPanes) {
        const toLabel = sibling.slotLabel || sibling.id.slice(0, 8)
        ;(async () => {
          // Give the sibling a moment to settle before injecting context
          await sleep(3000)
          if (!paneAlive(sibling.id)) return
          pipelineLog(`Stage ${stage.id} 🔀 handoff: ${fromLabel} → ${toLabel}`)
          const handoffMsg =
            `[跨代理人 Handoff — ${fromLabel} 已完成]\n` +
            `以下是 ${fromLabel} 的最終輸出（請參考後繼續你的工作）：\n\n` +
            snippet.trim()
          await injectPane(sibling.id, handoffMsg, `handoff:${fromLabel}→${toLabel}`, true)
          // Push the sibling watcher's scan window PAST the injected handoff so
          // the sentinel / analyzer scanners don't read this injected text as
          // the sibling's OWN output — that pollution was tripping early
          // completion (the Stage 04 bug). Wait for the echo to land, then
          // advance to the buffer tail (mirrors onAnswerQuestion's scanFrom
          // advance). The completed slot's sentinel is already stripped above,
          // but the handoff body can still false-trigger the analyzer.
          await sleep(1500)
          const sw = watchers.get(sibling.id)
          if (sw && !sw.cancelled) {
            const len = ((paneRefs[sibling.id]?.cleanBuffer as unknown as string) || '').length
            if (len > sw.scanFrom) sw.scanFrom = len
            sw.lastAnalyzedBufferLen = len
            pipelineLog(`Stage ${stage.id} 🔀 handoff scan window advanced for ${toLabel} → ${len}`)
          }
        })()
      }
    }
  } else {
    stageCompletions.delete(stageIndex)
    void onPipelineNext()
  }
}

function startStageWatcher(stageIndex: number, paneId: string, kickoffScanFrom?: number): void {
  cancelWatcher(paneId)   // cancel only THIS pane's previous watcher
  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const pane = paneRefs[paneId]
  if (!pane) return

  // Manager mode: when a slot is designated Manager for this stage, sentinel
  // watchers are skipped for ALL panes (Manager + workers). Stage completion
  // is decided by the Manager printing ---STAGE-DONE--- via the router poll.
  const hasManager = !!stageCommanderSlot(stage)
  if (hasManager) {
    const label = panes.value.find((p) => p.id === paneId)?.slotLabel || paneId.slice(0, 8)
    pipelineLog(`Stage ${stage.id} ⏸ slot watcher 跳過 ${label}（Manager 模式）`)
    return
  }

  // When kickoffScanFrom is provided (position captured just before kickoff
  // injection), use it directly — the kickoff content is collapsed to
  // "[Pasted text +N lines]" in the TUI so its INTERACTION_PROTOCOL examples
  // never appear as raw text in cleanBuffer, eliminating false detections.
  // When not provided (e.g. continueWaitingStall), fall back to the current
  // buffer end after re-applying the TUI noise filter.
  let scanFrom: number
  if (kickoffScanFrom !== undefined) {
    scanFrom = kickoffScanFrom
  } else {
    ;(pane.recleanBuffer as (() => void) | undefined)?.()
    scanFrom = (pane.markBufferPosition as () => number)()
  }

  // Guard against pre-existing sentinel in the buffer from a previous session
  // replayed via `claude resume`. Find the last occurrence before scanFrom and
  // record it as minScanFrom so buffer-cap resets never scan past it backwards.
  let minScanFrom = 0
  if (stage.sentinel && scanFrom > 0) {
    const existingBuf = (pane.cleanBuffer as unknown as string) ?? ''
    const lastPre = existingBuf.lastIndexOf('\n' + stage.sentinel, scanFrom)
    if (lastPre >= 0) {
      minScanFrom = lastPre + 1 + stage.sentinel.length
      pipelineLog(`Stage ${stage.id} ↩ pre-existing sentinel at ${lastPre} (resume history) — minScanFrom=${minScanFrom}`)
    }
  }

  const watcher: StageWatcher = {
    paneId,
    stageIndex,
    scanFrom,
    pollHandle: null,
    cancelled: false,
    waitingForAnswer: false,
    answeredAt: 0,
    armedAt: Date.now(),
    analyzerBusy: false,
    analyzerCooldownUntil: 0,
    lastAnalyzedBufferLen: 0,
    lastPollBufLen: 0,
    logFileOffset: -1,  // -1 = not yet initialized; set to current file size on first poll
    minScanFrom
  }
  watchers.set(paneId, watcher)
  paneArmedAt.set(paneId, watcher.armedAt)
  pipelineLog(
    `Stage ${stage.id} watcher armed · sentinel / turn_complete / question / analyzer`
  )

  watcher.pollHandle = window.setInterval(() => {
    if (watcher.cancelled) return
    const ref = paneRefs[paneId]
    if (!ref) {
      cancelWatcher(paneId)
      return
    }
    const buf = (ref.cleanBuffer as unknown as string) ?? ''

    // ── Generating check ─────────────────────────────────────────────────
    // Compare current buffer length with the length recorded at the end of
    // the previous poll tick (600 ms ago). If the buffer is still growing,
    // the agent is mid-generation — defer question detection to the next tick
    // so we never parse an incomplete QUESTION block or a partial answer echo.
    // Sentinel detection below is NOT gated (we still want to catch ---DONE---
    // even while the agent is streaming the last few lines).
    const prevPollBufLen = watcher.lastPollBufLen
    watcher.lastPollBufLen = buf.length
    const agentGenerating = buf.length > prevPollBufLen && prevPollBufLen > 0

    // ── Buffer-cap trim correction ────────────────────────────────────────
    // useTerminal caps cleanBuffer at 128 KB via bufferTail(). When the
    // kickoff is larger than 128 KB (Stage 05 with 240 KB of prior context),
    // the buffer is trimmed to exactly 128 KB and watcher.scanFrom is set to
    // 128 * 1024 by markBufferPosition() — which is PAST the end of the (now
    // trimmed) buffer. Every subsequent write keeps the buffer at 128 KB, so
    // scanFrom always equals buf.length and buf.slice(scanFrom) is always "".
    // This means the sentinel and question scanners search from past the end
    // and miss all agent output.
    //
    // Fix: when scanFrom is at/past the buffer end AND the buffer has been
    // filled to cap (evidenced by buf.length === 128 KB), the trim race has
    // occurred. For non-question stages it is safe to reset scanFrom to 0
    // because (a) each stage has a unique sentinel so scanning from 0 won't
    // trigger a false-positive match, and (b) allowQuestions=false means the
    // question scanner is skipped.  We don't reset for question-aware stages
    // (01/02) because their kickoff text contains example QUESTION blocks
    // with real-looking prompts that would be falsely detected (though in
    // practice Stages 01/02 kickoffs are small enough to avoid the cap).
    const CLEAN_BUF_CAP = 128 * 1024  // must match useTerminal.ts BUFFER_CAP
    if (!stage.allowQuestions && buf.length >= CLEAN_BUF_CAP && watcher.scanFrom >= buf.length) {
      pipelineLog(`Stage ${stage.id} 🔄 buffer-cap trim detected — resetting scanFrom to ${watcher.minScanFrom}`)
      watcher.scanFrom = watcher.minScanFrom
      watcher.lastAnalyzedBufferLen = 0
    }

    // Question pre-check for interactive stages — runs BEFORE sentinel so that
    // when an agent emits both a QUESTION block and the sentinel in the same
    // turn, the question is surfaced instead of silently advancing the stage.
    // Only applies to allowQuestions stages (currently Stage 01); other stages
    // have no question detection and the sentinel remains fully unconditional.
    if (stage.allowQuestions && !watcher.waitingForAnswer && buf.length > watcher.scanFrom && !agentGenerating) {
      const PLACEHOLDER_RE_PRE = /^<[^>]{1,40}>$/
      const preBlocks = findConsecutiveQuestionBlocks(buf, watcher.scanFrom)
      const realPreBlocks = preBlocks.filter((b) => !PLACEHOLDER_RE_PRE.test(b.prompt.trim()))
      if (realPreBlocks.length > 0) {
        watcher.waitingForAnswer = true
        watcher.scanFrom = preBlocks[preBlocks.length - 1].endIndex
        const paneMeta = panes.value.find((p) => p.id === paneId)
        enqueueQuestion({
          paneId,
          stageIndex,
          questions: realPreBlocks.map((b) => ({ prompt: b.prompt, type: b.type, options: b.options })),
          agentLabel: paneMeta?.agentLabel ?? 'Agent',
          stageTitle: stage.title,
          slotLabel: paneMeta?.slotLabel ?? ''
        })
        pipelineLog(`Stage ${stage.id} ❓ (pre-sentinel) agent asked ${realPreBlocks.length} question(s)`)
        return  // skip sentinel detection this tick
      }
    }

    // Sentinel detection — UNCONDITIONAL (outside the waitingForAnswer guard).
    // The agent printing its done-sentinel means "stage complete", even if the
    // watcher currently thinks it's mid-Q&A. Without this, a genuine completion
    // gets hidden whenever the analyzer mis-reads the agent's "Open Questions"
    // section as real questions and flips waitingForAnswer on. Agent decision wins.
    // Exception: the question pre-check above returns early for allowQuestions
    // stages when a real question precedes the sentinel.
    //
    // TWO sources are checked (cleanBuffer first, then outputLogFile):
    //   1. cleanBuffer — fast, in-memory, but scanFrom can be pushed past the
    //      sentinel by Q&A injections, and TUI animations may garble it.
    //   2. outputLogFile — complete append-only record; immune to scanFrom and
    //      truncation. Used as a reliable supplement when cleanBuffer misses.
    if (stage.sentinel) {
      let detected = false
      if (buf.length > watcher.scanFrom) {
        detected = buf.indexOf('\n' + stage.sentinel, watcher.scanFrom) >= 0
        if (!detected) detected = findSentinel(buf, stage.sentinel, watcher.scanFrom) >= 0
      }

      // outputLogFile supplement — always runs, async, non-blocking.
      // Reads only NEW bytes since last check so it stays cheap.
      const pane = panes.value.find((p) => p.id === paneId)
      const logFile = pane?.outputLogFile
      if (!detected && logFile && window.agentTeam?.readFileFrom) {
        ;(async () => {
          // On first call, snapshot the current file size so we only read bytes
          // written AFTER the watcher armed — the kickoff itself contains the
          // sentinel in its usage examples and would cause a false positive.
          if (watcher.logFileOffset < 0) {
            const init = await window.agentTeam!.readFileFrom(logFile, 0)
            if (!init.ok || watcher.cancelled) return
            watcher.logFileOffset = init.newOffset  // skip everything up to now
            return
          }
          const result = await window.agentTeam!.readFileFrom(logFile, watcher.logFileOffset)
          if (!result.ok || watcher.cancelled) return
          watcher.logFileOffset = result.newOffset
          // Strip ANSI from log bytes before searching
          const clean = result.content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
          if (clean.includes(stage.sentinel!)) {
            if (!watcher.cancelled) {
              cancelWatcher(paneId)
              pipelineLog(`Stage ${stage.id} ✓ sentinel detected (log file)`)
              onStageSlotCompleted(stageIndex, paneId, 'sentinel')
            }
          }
        })()
      }

      if (detected) {
        cancelWatcher(paneId)
        pipelineLog(`Stage ${stage.id} ✓ sentinel detected`)
        onStageSlotCompleted(stageIndex, paneId, 'sentinel')
        return
      }
    }

    if (!watcher.waitingForAnswer) {
      // 0. Post-answer stuck detection — spinner gone after answer injection.
      //    When Claude receives an answer but doesn't continue (sits at ❯ idle),
      //    the spinner stops → lastActivityAt goes stale. We detect this and
      //    send a minimal nudge so it resumes work. Only fires once per answer.
      const ANSWER_STALL_MS = 8_000
      if (watcher.answeredAt > 0) {
        const lastAct = (ref.lastActivityAt as unknown as number) ?? 0
        const idleSinceAnswer = Date.now() - Math.max(lastAct, watcher.answeredAt)
        if (idleSinceAnswer > ANSWER_STALL_MS) {
          // Before nudging, check whether there is an unanswered QUESTION block
          // in the buffer from scanFrom. This happens when the agent outputs a
          // QUESTION and then keeps running (tool use / Crunching), so
          // agentGenerating blocked question detection, but answeredAt from a
          // prior answer makes the stall check think the agent is stuck.
          // In that case, reset answeredAt and let question detection surface it
          // on the next stable tick instead of erroneously nudging.
          const hasPendingQuestion =
            stage.allowQuestions &&
            buf.indexOf('---QUESTION-START---', watcher.scanFrom) >= 0 &&
            buf.indexOf('---QUESTION-END---', watcher.scanFrom) >= 0
          if (hasPendingQuestion) {
            watcher.answeredAt = 0  // prevent re-firing
            return  // question detection will surface it on next stable tick
          }
          watcher.answeredAt = 0  // reset so we don't fire again
          pipelineLog(`Stage ${stage.id} ⚡ CLI idle after answer — nudging agent to continue`)
          ;(async () => {
            const sessionId = (ref.sessionId as string | undefined)
            if (sessionId) await injectText(sessionId, '請繼續', `nudge:${stage.id}`)
          })()
        }
      }

      // 1. Question detection — only for stages that allow user interaction
      //    (stage.allowQuestions === true, currently only Stage 01).
      //    Later stages run autonomously and must not pause for user input.
      //    Skipped when agentGenerating so we never parse a partial block.
      if (stage.allowQuestions && buf.length > watcher.scanFrom && !agentGenerating) {
        const blocks = findConsecutiveQuestionBlocks(buf, watcher.scanFrom)
        // Drop any block whose prompt is still a template placeholder (e.g.
        // "<你的問題>", "<your question>"). The agent copied the INTERACTION_PROTOCOL
        // example verbatim instead of filling in real content.
        const PLACEHOLDER_RE = /^<[^>]{1,40}>$/
        const realBlocks = blocks.filter((b) => !PLACEHOLDER_RE.test(b.prompt.trim()))
        if (realBlocks.length < blocks.length) {
          pipelineLog(`Stage ${stage.id} ⚠ dropped ${blocks.length - realBlocks.length} placeholder question(s) — agent echoed the template`)
        }
        if (realBlocks.length > 0) {
          watcher.waitingForAnswer = true
          watcher.scanFrom = blocks[blocks.length - 1].endIndex
          const paneMeta = panes.value.find((p) => p.id === paneId)
          enqueueQuestion({
            paneId,
            stageIndex,
            questions: realBlocks.map((b) => ({ prompt: b.prompt, type: b.type, options: b.options })),
            agentLabel: paneMeta?.agentLabel ?? 'Agent',
            stageTitle: stage.title,
            slotLabel: paneMeta?.slotLabel ?? ''
          })
          const choiceCount = realBlocks.filter((b) => b.type === 'choice').length
          pipelineLog(
            `Stage ${stage.id} ❓ agent asked ${realBlocks.length} question(s)` +
              (choiceCount > 0 ? ` (${choiceCount} choice)` : '')
          )
          // Surface diagnostic when a block declared choice but we found 0 options
          for (const b of realBlocks) {
            const diag = (b as typeof b & { _diag?: string })._diag
            if (diag) {
              pipelineLog(`Stage ${stage.id} ⚠ choice parse missed — options raw: ${diag}`)
            }
          }
          return
        }
      }

      // 2. turn_complete — PRIMARY completion path (after sentinel). The CLI
      //    reported its turn ended and, having passed question detection above
      //    with no pending/new question, it's back at the prompt. Ordered AFTER
      //    question detection so an interactive QUESTION (whose turn also ends)
      //    is caught as a question first, never as completion. turnCompleteDone
      //    requires: post-arm, the LATEST signal (no agent_active after = not
      //    revived by an injected handoff/answer), and settled SETTLE_MS so the
      //    buffer's question text can catch up before we advance.
      if (
        !stage.allowQuestions &&
        turnCompleteDone({
          turnCompleteAt: paneTurnCompleteAt.get(paneId) ?? 0,
          lastActiveAt: paneLastActiveAt.get(paneId) ?? 0,
          armedAt: watcher.armedAt,
          now: Date.now(),
          settleMs: TURN_COMPLETE_SETTLE_MS
        })
      ) {
        cancelWatcher(paneId)
        pipelineLog(`Stage ${stage.id} ✓ turn_complete reported by CLI`)
        onStageSlotCompleted(stageIndex, paneId, 'turn_complete')
        return
      }

      // 3. Analyzer — now ONLY detects questions. Completion judgement moved to
      //    the CLI-state signals above (sentinel / turn_complete); the analyzer
      //    no longer advances stages. It reads the SAME buffer the agent printed
      //    and, if there's a question the buffer scanner missed, surfaces it.
      const now = Date.now()
      const lastActivityAt = (ref.lastActivityAt as unknown as number) ?? 0
      const idleMs = now - Math.max(lastActivityAt, watcher.armedAt)
      const bufferLen = (ref.cleanBuffer as unknown as string).length
      const newChars = bufferLen - watcher.lastAnalyzedBufferLen
      const hasResponded = lastActivityAt > watcher.armedAt
      const ANALYZER_QUIET_MS = 4_000
      const ANALYZER_COOLDOWN_MS = 5_000
      const ANALYZER_MIN_NEW_CHARS = 120
      const ANALYZER_FORCE_IDLE_MS = 12_000
      // Primary: agent produced new output then went quiet — read it.
      const primaryTrigger =
        hasResponded && idleMs > ANALYZER_QUIET_MS && newChars > ANALYZER_MIN_NEW_CHARS
      // Force re-ask (interactive stages only): the agent may have printed a
      // QUESTION and is now sitting silently waiting for an answer, so newChars
      // stops growing. Without this, a TUI-mangled question block or a transient
      // malformed-JSON from the analyzer would leave the stage stuck with no
      // Q&A popup forever. The 5s cooldown throttles it; the whole block is
      // skipped once a question pops (waitingForAnswer guard above), so it can't
      // loop after the dialog appears.
      const forceTrigger =
        stage.allowQuestions && hasResponded &&
        idleMs > ANALYZER_FORCE_IDLE_MS && bufferLen > watcher.scanFrom + 50
      if (
        analyzerApi.health.value?.ok &&
        !watcher.analyzerBusy &&
        now > watcher.analyzerCooldownUntil &&
        (primaryTrigger || forceTrigger)
      ) {
        watcher.analyzerBusy = true
        watcher.lastAnalyzedBufferLen = bufferLen
        const slice = ((ref.cleanBuffer as unknown as string) || '').slice(watcher.scanFrom)
        const trigger = primaryTrigger
          ? `quiet ${Math.round(idleMs / 1000)}s+${newChars}c`
          : `force ${Math.round(idleMs / 1000)}s`
        ;(async () => {
          // Quick regex pre-filter — skip LLM on obvious completions.
          // Only on primaryTrigger (agent went quiet after new output), NOT
          // forceTrigger (interactive re-ask for missed questions) — we don't
          // want regex to swallow a QUESTION the buffer scanner missed.
          if (primaryTrigger && !stage.allowQuestions && quickClassify(slice) === 'completion') {
            watcher.analyzerBusy = false
            if (watcher.cancelled) return
            pipelineLog(`Stage ${stage.id} ⚡ regex detected completion (skipped LLM)`)
            cancelWatcher(paneId)
            onStageSlotCompleted(stageIndex, paneId, 'analyzer')
            return
          }
          pipelineLog(`Stage ${stage.id} 🧠 asking analyzer (${slice.length} chars · ${trigger})`)
          const result = await analyzerApi.classify(slice, analyzerModel.value || undefined, {
            workspacePath: pipeline.workspacePath,
            stageId: stage.id,
            paneId
          })
          watcher.analyzerBusy = false
          watcher.analyzerCooldownUntil = Date.now() + ANALYZER_COOLDOWN_MS
          if (watcher.cancelled) return
          if (!result) {
            pipelineLog(`Stage ${stage.id} 🧠 analyzer error`)
            return
          }
          pipelineLog(
            `Stage ${stage.id} 🧠 intent=${result.intent} (${result.total_duration_ms ?? '?'}ms)${
              result.summary ? ` — ${result.summary}` : ''
            }`
          )
          handleAnalyzerResult(stageIndex, paneId, stage, result)
        })()
      }

      // 4. Hard-cap backstop — never let one wedged agent block the pipeline
      //    forever. The sentinel / analyzer above end the stage well before this.
      if (now - watcher.armedAt > STAGE_MAX_DURATION_MS) {
        cancelWatcher(paneId)
        const detail = `hit ${Math.round(STAGE_MAX_DURATION_MS / 60_000)}min cap`
        pipelineLog(`Stage ${stage.id} ⚠ ${detail}`)
        promptStageStall(stageIndex, paneId, 'cap', detail)
      }
    } // end !waitingForAnswer guard
  }, 600)
}

function handleAnalyzerResult(
  stageIndex: number,
  paneId: string,
  stage: { id: string; title: string; allowQuestions?: boolean },
  result: ClassifyResult
): void {
  const watcher = watchers.get(paneId)
  if (!watcher || watcher.cancelled) return

  // Completion —
  //   • Multi-slot: IGNORED. The analyzer's buffer guess mis-fires under handoff
  //     pollution → early advances (the Stage 04 bug). Multi-slot completes only
  //     via factual signals (sentinel / turn_complete).
  //   • Single-slot: FALLBACK advance. No siblings, no handoff pollution, so the
  //     analyzer's read of the agent's own output is safe to trust. This is the
  //     safety net for when the agent finished but printed NO sentinel AND
  //     turn_complete didn't land (e.g. mis-attributed to a sibling pane) —
  //     without it the stage stalls and the analyzer just spins (Stage 01/02).
  if (result.intent === 'completion') {
    const slotCount = stagesApi.stages.value[stageIndex]?.slots.length ?? 1
    if (slotCount > 1) {
      // Multi-slot FALLBACK: trust analyzer completion ONLY once the buffer has
      // been truly quiet — a sibling churns right after a handoff injection, so
      // a short post-handoff pause must not be read as completion (Stage 04
      // early-advance). lastActivityAt is the PTY buffer's own quiet clock
      // (frontend-local), immune to pane mis-attribution.
      const ref = paneRefs[paneId]
      const lastAct = (ref?.lastActivityAt as unknown as number) ?? 0
      const quietMs = Date.now() - lastAct
      if (quietMs < MULTISLOT_ANALYZER_CONFIRM_MS) {
        pipelineLog(`Stage ${stage.id} 🧠 analyzer completion held — buffer quiet ${Math.round(quietMs / 1000)}s < ${MULTISLOT_ANALYZER_CONFIRM_MS / 1000}s (multi-slot)`)
        return
      }
      cancelWatcher(paneId)
      pipelineLog(`Stage ${stage.id} ✓ analyzer detected completion (multi-slot fallback, quiet ${Math.round(quietMs / 1000)}s)`)
      onStageSlotCompleted(stageIndex, paneId, 'analyzer')
      return
    }
    cancelWatcher(paneId)
    pipelineLog(`Stage ${stage.id} ✓ analyzer detected completion (fallback)`)
    onStageSlotCompleted(stageIndex, paneId, 'analyzer')
    return
  }

  // Question — only pause for stages that allow it, and only if this pane
  // doesn't already have a question pending.
  const qs = result.questions ?? (result.question ? [result.question] : [])
  const alreadyPending =
    activeQuestion.value?.paneId === paneId ||
    questionQueue.some((qi) => qi.paneId === paneId)
  if (stage.allowQuestions && result.intent === 'question' && qs.length > 0 && !alreadyPending) {
    watcher.waitingForAnswer = true
    // Advance scan window to current buffer end so that after the user answers,
    // the next analysis pass doesn't re-read and re-detect the same questions.
    const ref = paneRefs[paneId]
    const currentLen = ((ref?.cleanBuffer as unknown as string) || '').length
    if (currentLen > watcher.scanFrom) watcher.scanFrom = currentLen
    watcher.lastAnalyzedBufferLen = currentLen
    const paneMeta = panes.value.find((p) => p.id === paneId)
    enqueueQuestion({
      paneId,
      stageIndex,
      questions: qs.map((q) => ({ prompt: q.prompt, type: q.type, options: q.options })),
      agentLabel: paneMeta?.agentLabel ?? 'Agent',
      stageTitle: `${stage.title} · 🧠 analyzer`,
      slotLabel: paneMeta?.slotLabel ?? ''
    })
    const choiceCount = qs.filter((q) => q.type === 'choice').length
    pipelineLog(
      `Stage ${stage.id} ❓ analyzer detected ${qs.length} question(s)` +
        (choiceCount > 0 ? ` (${choiceCount} choice)` : '')
    )
  }
}

async function onAnswerQuestion(combined: string, _answers: string[]): Promise<void> {
  const q = activeQuestion.value
  if (!q) return
  dequeueNextQuestion()
  pipelineLog(
    `↩ answered ${q.questions.length} question(s) for stage ${stagesApi.stages.value[q.stageIndex]?.id}: ${truncate(combined, 80)}`
  )
  const ref = paneRefs[q.paneId]
  if (ref?.sessionId) {
    await injectText(ref.sessionId as string, combined, `user-answer:stage-${stagesApi.stages.value[q.stageIndex]?.id}`)
  }
  ref?.focus?.()
  const w = watchers.get(q.paneId)
  if (w) {
    w.waitingForAnswer = false
    w.answeredAt = Date.now()  // track injection time for stuck detection
    // Do NOT advance scanFrom here. scanFrom already sits at Q1's endIndex
    // (set when Q1 was first detected). Pushing it to currentLen would skip
    // over any Q2 the agent generates quickly while the answer is being typed.
    // The agentGenerating guard in the poll loop prevents premature detection
    // of partial blocks, so Q2 is found correctly on the next stable tick.
    const currentLen = ((ref?.cleanBuffer as unknown as string) || '').length
    w.lastAnalyzedBufferLen = currentLen
    // Give the agent a few seconds to process the answer before re-analyzing.
    w.analyzerCooldownUntil = Date.now() + 5_000
  }
}

function onCancelQuestion(): void {
  const q = activeQuestion.value
  if (!q) return
  dequeueNextQuestion()
  pipelineLog(`✕ dismissed question for stage ${stagesApi.stages.value[q.stageIndex]?.id} (watcher resumed)`)
  const ref = paneRefs[q.paneId]
  ref?.focus?.()
  const w = watchers.get(q.paneId)
  if (w) w.waitingForAnswer = false
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim()
  return oneline.length > n ? oneline.slice(0, n - 1) + '…' : oneline
}

// ── Layout mode (F-A) + Minimize to sidebar (F-B) ────────────────────────────
const layoutMode = ref<LayoutMode>('grid')
const focusPaneId = ref<string | null>(null)
const minimizedPanes = ref(new Set<string>())

function minimizePane(id: string): void {
  minimizedPanes.value = new Set([...minimizedPanes.value, id])
  if (focusPaneId.value === id) {
    focusPaneId.value = panes.value.find((p) => p.id !== id && !minimizedPanes.value.has(p.id))?.id ?? null
  }
  syncViews()
}

function restorePane(id: string): void {
  const next = new Set(minimizedPanes.value)
  next.delete(id)
  minimizedPanes.value = next
  if (layoutMode.value !== 'grid') focusPaneId.value = id
  syncViews()
}

// Keep focusPaneId valid as panes are added/removed
watch(panes, (newPanes, oldPanes) => {
  const ids = new Set(newPanes.map((p) => p.id))
  if (focusPaneId.value && !ids.has(focusPaneId.value)) {
    focusPaneId.value = newPanes[0]?.id ?? null
  }
  if (layoutMode.value !== 'grid' && newPanes.length > (oldPanes?.length ?? 0)) {
    focusPaneId.value = newPanes[newPanes.length - 1].id
  }
})

// Auto-focus: poll lastRawActivityAt every 500ms to follow the most active pane.
// Two guards prevent jarring focus oscillation during pipeline execution:
//   1. Manual grace period: user click → no auto-override for 3s
//   2. Dwell time: current focus pane must be quiet for 2.5s before auto-switch
let _autoFocusInterval: ReturnType<typeof setInterval> | null = null
let _lastManualFocusAt = 0
const MANUAL_FOCUS_GRACE_MS = 3000
const AUTO_FOCUS_DWELL_MS = 2500  // current pane must be idle 2.5s before switching

function onSetFocus(paneId: string): void {
  _lastManualFocusAt = Date.now()
  focusPaneId.value = paneId
}

watch(layoutMode, (mode) => {
  const wp = pipeline.workspacePath
  if (wp) {
    backend.send('project.set_layout_mode', { workspace_path: wp, layout_mode: mode })
  }
  if (_autoFocusInterval) { clearInterval(_autoFocusInterval); _autoFocusInterval = null }
  if (mode !== 'grid') {
    _autoFocusInterval = setInterval(() => {
      // Guard 1: don't override a recent manual click
      if (Date.now() - _lastManualFocusAt < MANUAL_FOCUS_GRACE_MS) return
      let newest = 0, newestId: string | null = null
      let currentFocusLastActive = 0
      for (const id of Object.keys(paneRefs)) {
        if (minimizedPanes.value.has(id)) continue
        const r = paneRefs[id]
        if (!r) continue
        const ts = (r.lastRawActivityAt as unknown as number) ?? 0
        if (ts > newest) { newest = ts; newestId = id }
        if (id === focusPaneId.value) currentFocusLastActive = ts
      }
      if (newestId && newestId !== focusPaneId.value) {
        // Guard 2: only switch if the current focus pane has been quiet long enough
        const currentPaneIdleMs = Date.now() - currentFocusLastActive
        if (currentPaneIdleMs > AUTO_FOCUS_DWELL_MS) {
          focusPaneId.value = newestId
        }
      }
    }, 500)
  }
}, { immediate: true })

const effectiveLayoutMode = computed<'grid' | 'spotlight' | 'sidebar' | 'fullscreen'>(() => {
  if (panes.value.length <= 1) return 'grid'
  const m = layoutMode.value
  // auto → sidebar layout (focus pane left, others stacked in right column)
  if (m === 'auto') return 'sidebar'
  // spotlight → focus pane top, others in bottom strip
  if (m === 'spotlight') return 'spotlight'
  // fullscreen → focus pane 100%, others as floating overlays
  if (m === 'fullscreen') return 'fullscreen'
  return 'grid'
})

// After any layout mode change, refit all terminals once the browser has
// finished laying out the new grid — ResizeObserver alone is unreliable when
// panes transition from display:none (sidebar) to visible (spotlight/grid).
watch(effectiveLayoutMode, () => {
  void nextTick(() => {
    requestAnimationFrame(() => {
      for (const ref of Object.values(paneRefs)) {
        (ref as unknown as { fitTerminal?: () => void })?.fitTerminal?.()
      }
    })
  })
})

// In fullscreen mode non-focus panes are hidden (alive but not rendered);
// they appear in the collapsible PiP list instead.
function floatPaneStyle(paneId: string): Record<string, string> {
  if (effectiveLayoutMode.value !== 'fullscreen') return {}
  if (paneId === effectiveFocusPaneId.value) return {}
  if (dualFocusActive.value && paneId === dualFocusSecondaryId.value) return {}
  return { display: 'none' }
}

// ── Fullscreen PiP floating list ──────────────────────────────────────────────
const floatPipExpanded = ref(true)
const floatPipPos = ref<{ top: number; left: number }>(
  (() => { try { const v = JSON.parse(localStorage.getItem('agentTeam.floatPipPos') ?? ''); if (typeof v?.top === 'number') return v as { top: number; left: number } } catch {} return { top: 0, left: 0 } })()
)
const floatPipWidth = ref<number>(
  (() => { try { return parseInt(localStorage.getItem('agentTeam.floatPipWidth') ?? '220') || 220 } catch { return 220 } })()
)
watch(floatPipPos, (v) => { try { localStorage.setItem('agentTeam.floatPipPos', JSON.stringify(v)) } catch {} }, { deep: true })
watch(floatPipWidth, (v) => { try { localStorage.setItem('agentTeam.floatPipWidth', String(v)) } catch {} })
const floatPipListMaxHeight = ref(320)

function _pipStageSize(): { sw: number; sh: number } {
  const el = document.querySelector('.stage') as HTMLElement
  return { sw: el?.clientWidth ?? 800, sh: el?.clientHeight ?? 600 }
}

function clampPipPos(): void {
  nextTick(() => {
    const pip = document.querySelector('.float-pip') as HTMLElement
    if (!pip) return
    const { sw, sh } = _pipStageSize()
    floatPipPos.value = {
      left: Math.max(8, Math.min(sw - floatPipWidth.value - 8, floatPipPos.value.left)),
      top: Math.max(0, Math.min(sh - 32, floatPipPos.value.top)),
    }
  })
}

watch(effectiveLayoutMode, (mode) => {
  if (mode === 'fullscreen') {
    floatPipWidth.value = 220
    floatPipListMaxHeight.value = 320
    floatPipExpanded.value = true
    nextTick(() => {
      const pip = document.querySelector('.float-pip') as HTMLElement
      const { sw, sh } = _pipStageSize()
      const pipH = pip?.offsetHeight ?? 360
      floatPipPos.value = {
        left: sw - floatPipWidth.value - 16,
        top: Math.max(0, sh - pipH - 16),
      }
    })
  }
})

let _pipStartX = 0, _pipStartY = 0, _pipStartL = 0, _pipStartT = 0

function onPipDragStart(e: MouseEvent): void {
  _pipStartX = e.clientX
  _pipStartY = e.clientY
  _pipStartL = floatPipPos.value.left
  _pipStartT = floatPipPos.value.top
  document.addEventListener('mousemove', onPipDragMove)
  document.addEventListener('mouseup', onPipDragEnd)
  e.preventDefault()
}

function onPipDragMove(e: MouseEvent): void {
  const dx = e.clientX - _pipStartX
  const dy = e.clientY - _pipStartY
  const { sw, sh } = _pipStageSize()
  floatPipPos.value = {
    left: Math.max(8, Math.min(sw - floatPipWidth.value - 8, _pipStartL + dx)),
    top: Math.max(0, Math.min(sh - 32, _pipStartT + dy)),
  }
}

function onPipDragEnd(): void {
  document.removeEventListener('mousemove', onPipDragMove)
  document.removeEventListener('mouseup', onPipDragEnd)
}

let _resStartX = 0, _resStartY = 0, _resStartW = 0, _resStartH = 0

function onPipResizeStart(e: MouseEvent): void {
  _resStartX = e.clientX
  _resStartY = e.clientY
  _resStartW = floatPipWidth.value
  _resStartH = floatPipListMaxHeight.value
  document.addEventListener('mousemove', onPipResizeMove)
  document.addEventListener('mouseup', onPipResizeEnd)
  e.preventDefault()
  e.stopPropagation()
}

function onPipResizeMove(e: MouseEvent): void {
  const dx = e.clientX - _resStartX
  const dy = e.clientY - _resStartY
  const { sw } = _pipStageSize()
  floatPipWidth.value = Math.max(160, Math.min(sw - 32, _resStartW + dx))
  floatPipListMaxHeight.value = Math.max(80, Math.min(600, _resStartH + dy))
}

function onPipResizeEnd(): void {
  document.removeEventListener('mousemove', onPipResizeMove)
  document.removeEventListener('mouseup', onPipResizeEnd)
}

// Number of non-focus visible panes — drives explicit grid-template-rows so
// that grid-row: 1 / -1 works correctly on the focus pane.
const sidebarRowCount = computed(() => {
  const visible = panes.value.filter((p) => !minimizedPanes.value.has(p.id)).length
  return Math.max(1, visible - 1)
})

// ── Grid pane splitters ───────────────────────────────────────────────────────
const gridRef = ref<HTMLElement | null>(null)
const colWidths = ref<number[]>(
  (() => { try { const v = JSON.parse(localStorage.getItem('agentTeam.colWidths') ?? ''); if (Array.isArray(v)) return v as number[] } catch {} return [1] })()
)
const rowHeights = ref<number[]>(
  (() => { try { const v = JSON.parse(localStorage.getItem('agentTeam.rowHeights') ?? ''); if (Array.isArray(v)) return v as number[] } catch {} return [1] })()
)
// Sidebar left column width in pixels (0 = default: fill remaining space)
const sidebarLeftPx = ref<number>(
  (() => { try { return parseInt(localStorage.getItem('agentTeam.sidebarLeftPx') ?? '0') || 0 } catch { return 0 } })()
)
const dualFocusSplitPx = ref<number>(
  (() => { try { return parseInt(localStorage.getItem('agentTeam.dualFocusSplitPx') ?? '0') || 0 } catch { return 0 } })()
)
watch(colWidths, (v) => { try { localStorage.setItem('agentTeam.colWidths', JSON.stringify(v)) } catch {} }, { deep: true })
watch(rowHeights, (v) => { try { localStorage.setItem('agentTeam.rowHeights', JSON.stringify(v)) } catch {} }, { deep: true })
watch(sidebarLeftPx, (v) => { try { localStorage.setItem('agentTeam.sidebarLeftPx', String(v)) } catch {} })
watch(dualFocusSplitPx, (v) => { try { localStorage.setItem('agentTeam.dualFocusSplitPx', String(v)) } catch {} })

const numCols = computed(() => {
  const n = panes.value.length
  if (n <= 1) return 1
  if (n <= 4) return 2
  return 3
})
const numRows = computed(() => Math.max(1, Math.ceil(panes.value.length / numCols.value)))

watch(numCols, (n) => { colWidths.value = Array(n).fill(1) }, { immediate: true })
watch(numRows, (n) => { rowHeights.value = Array(n).fill(1) }, { immediate: true })

const gridTemplateColumns = computed(() => {
  switch (effectiveLayoutMode.value) {
    case 'spotlight':
    case 'fullscreen': {
      if (dualFocusActive.value) {
        const l = dualFocusSplitPx.value > 0 ? `${dualFocusSplitPx.value}px` : '1fr'
        return `${l} 1fr`
      }
      return '1fr'
    }
    case 'sidebar': {
      if (dualFocusActive.value) {
        const l = dualFocusSplitPx.value > 0 ? `${dualFocusSplitPx.value}px` : '1fr'
        return `${l} 1fr 220px`
      }
      return sidebarLeftPx.value > 0 ? `${sidebarLeftPx.value}px 1fr` : '1fr 220px'
    }
    default: {
      const ws = colWidths.value.length === numCols.value ? colWidths.value : Array(numCols.value).fill(1)
      return ws.map(w => `${w}fr`).join(' ')
    }
  }
})

const gridTemplateRows = computed(() => {
  switch (effectiveLayoutMode.value) {
    case 'spotlight': return '1fr'
    case 'sidebar':   return '1fr'
    case 'fullscreen': return '1fr'
    default: {
      const hs = rowHeights.value.length === numRows.value ? rowHeights.value : Array(numRows.value).fill(1)
      return hs.map(h => `${h}fr`).join(' ')
    }
  }
})

const gridStyle = computed(() => ({
  gridTemplateColumns: gridTemplateColumns.value,
  gridTemplateRows: gridTemplateRows.value,
}))

// Handle positions as percentage strings (grid mode: between columns/rows)
const colHandlePositions = computed<string[]>(() => {
  if (effectiveLayoutMode.value !== 'grid') return []
  const ws = colWidths.value.length === numCols.value ? colWidths.value : Array(numCols.value).fill(1)
  if (ws.length <= 1) return []
  const total = ws.reduce((a, b) => a + b, 0)
  let cum = 0
  return ws.slice(0, -1).map(w => { cum += w; return `${(cum / total) * 100}%` })
})

const rowHandlePositions = computed<string[]>(() => {
  if (effectiveLayoutMode.value !== 'grid') return []
  const hs = rowHeights.value.length === numRows.value ? rowHeights.value : Array(numRows.value).fill(1)
  if (hs.length <= 1) return []
  const total = hs.reduce((a, b) => a + b, 0)
  let cum = 0
  return hs.slice(0, -1).map(h => { cum += h; return `${(cum / total) * 100}%` })
})

// Sidebar handle: matches the grid template split exactly — no clientWidth needed.
const sidebarHandlePos = computed(() => {
  return sidebarLeftPx.value > 0 ? `${sidebarLeftPx.value}px` : 'calc(100% - 220px)'
})

type GridHandleAxis = 'col' | 'row' | 'sidebar' | 'dual-focus'
let _gAxis: GridHandleAxis | null = null
let _gIdx = 0
let _gStartX = 0
let _gStartY = 0
let _gA = 0
let _gB = 0
let _gSize = 0

function onGridHandleStart(e: MouseEvent, axis: GridHandleAxis, index: number): void {
  _gAxis = axis
  _gIdx = index
  _gStartX = e.clientX
  _gStartY = e.clientY
  const el = gridRef.value
  if (axis === 'col') {
    _gA = colWidths.value[index] ?? 1
    _gB = colWidths.value[index + 1] ?? 1
    _gSize = el?.clientWidth ?? 800
  } else if (axis === 'row') {
    _gA = rowHeights.value[index] ?? 1
    _gB = rowHeights.value[index + 1] ?? 1
    _gSize = el?.clientHeight ?? 600
  } else if (axis === 'sidebar') {
    _gA = sidebarLeftPx.value > 0 ? sidebarLeftPx.value : (el?.clientWidth ?? 800) - 220
    _gSize = el?.clientWidth ?? 800
  } else {
    const meetingW = effectiveLayoutMode.value === 'sidebar' ? 220 : 0
    _gSize = (el?.clientWidth ?? 800) - meetingW
    _gA = dualFocusSplitPx.value > 0 ? dualFocusSplitPx.value : _gSize / 2
    _gB = 0
  }
  isDragging.value = true
  document.body.style.cursor = axis === 'row' ? 'row-resize' : 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onGridHandleMove)
  document.addEventListener('mouseup', onGridHandleEnd)
  e.preventDefault()
}

function onGridHandleMove(e: MouseEvent): void {
  if (!_gAxis) return
  if (_gAxis === 'col') {
    const dx = e.clientX - _gStartX
    const sum = _gA + _gB
    const newA = Math.max(0.1, Math.min(sum - 0.1, _gA + dx * sum / _gSize))
    const next = [...colWidths.value]
    next[_gIdx] = newA
    next[_gIdx + 1] = sum - newA
    colWidths.value = next
  } else if (_gAxis === 'row') {
    const dy = e.clientY - _gStartY
    const sum = _gA + _gB
    const newA = Math.max(0.1, Math.min(sum - 0.1, _gA + dy * sum / _gSize))
    const next = [...rowHeights.value]
    next[_gIdx] = newA
    next[_gIdx + 1] = sum - newA
    rowHeights.value = next
  } else if (_gAxis === 'sidebar') {
    const dx = e.clientX - _gStartX
    sidebarLeftPx.value = Math.max(200, Math.min(_gSize - 140, _gA + dx))
  } else if (_gAxis === 'dual-focus') {
    const dx = e.clientX - _gStartX
    dualFocusSplitPx.value = Math.max(150, Math.min(_gSize - 150, _gA + dx))
  }
}

function onGridHandleEnd(): void {
  _gAxis = null
  isDragging.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onGridHandleMove)
  document.removeEventListener('mouseup', onGridHandleEnd)
}

// Resolved focus pane: skips minimized panes, falls back to first visible
const effectiveFocusPaneId = computed(() => {
  if (focusPaneId.value
    && panes.value.find((p) => p.id === focusPaneId.value)
    && !minimizedPanes.value.has(focusPaneId.value)) {
    return focusPaneId.value
  }
  return panes.value.find((p) => !minimizedPanes.value.has(p.id))?.id ?? null
})

// ── Dual-focus: show 2 running panes side-by-side in non-grid modes ───────────
const runningPaneIds = computed(() => {
  // Only consider pipeline panes that belong to the CURRENT active stage.
  // Restored panes from completed stages (via claude resume) also show as
  // 'running' during session replay and must not activate dual-focus.
  const activeStageId = stagesApi.stages.value[pipeline.stageIndex]?.id ?? ''
  const running = paneViews.value.filter(
    (p) =>
      (p.status === 'running' || p.status === 'starting') &&
      !minimizedPanes.value.has(p.id) &&
      p.origin === 'pipeline' &&
      p.stageId === activeStageId &&
      pipeline.state === 'running'
  )
  if (running.length < 2) return []
  // Keep focus pane first so it stays in col 1
  const focusIdx = running.findIndex((p) => p.id === effectiveFocusPaneId.value)
  if (focusIdx > 0) {
    const arr = [...running]
    const [fp] = arr.splice(focusIdx, 1)
    arr.unshift(fp)
    return arr.slice(0, 2).map((p) => p.id)
  }
  return running.slice(0, 2).map((p) => p.id)
})
const dualFocusActive = computed(
  () => runningPaneIds.value.length >= 2 && effectiveLayoutMode.value !== 'grid'
)
const dualFocusSecondaryId = computed<string | null>(
  () => (dualFocusActive.value ? runningPaneIds.value[1] : null)
)
const dualFocusHandlePos = computed(() => {
  if (dualFocusSplitPx.value > 0) return `${dualFocusSplitPx.value}px`
  const meetingW = effectiveLayoutMode.value === 'sidebar' ? 220 : 0
  return meetingW > 0 ? `calc((100% - ${meetingW}px) / 2)` : '50%'
})
watch(dualFocusActive, (active) => { if (!active) dualFocusSplitPx.value = 0 })

function dualFocusStyle(paneId: string): Record<string, string> {
  if (!dualFocusActive.value || paneId !== dualFocusSecondaryId.value) return {}
  return { gridColumn: '2', gridRow: '1' }
}

const backendUrl = computed(() => backend.httpUrl.value)

const analyzerStatus = computed<AnalyzerStatusView>(() => ({
  available: !!analyzerApi.health.value?.ok,
  version: analyzerApi.health.value?.version ?? '',
  defaultModel: analyzerApi.defaultModel.value,
  models: analyzerApi.models.value.map((m) => ({
    name: m.name,
    parameter_size: m.parameter_size,
    size: m.size
  })),
  benchmarkResults: analyzerApi.benchmarkResults.value,
}))

/** Latest pipeline-log entry, surfaced as live status text in the empty-area
 *  spinner so the user sees what the orchestrator is doing during the 10-30s
 *  startup window (Context7 docs → spawn → settle → inject). */
const latestPipelineLog = computed<string>(() => {
  const log = pipeline.log
  if (!log.length) return '正在啟動…'
  // pipelineLog() prefixes "[HH:MM:SS] " — strip it for the spinner display.
  return log[log.length - 1].replace(/^\[[\d:]+\]\s*/, '')
})

function paneSubtitle(p: ActivePane): string {
  if (p.origin !== 'pipeline' && !p.stageId) return `${roleLabel(p.roleKey)} · manual`
  const stage = stagesApi.stageById.value[p.stageId] ?? { shortTitle: p.stageId }
  const prefix = p.origin === 'pipeline' ? `P${p.stageId} · ` : ''
  const stageLabel = stage.shortTitle || 'manual'
  return `${prefix}${roleLabel(p.roleKey)} · ${stageLabel}`
}

/** The effective Commander slot for a stage, or null. Commander mode only applies
 *  when a stage has more than one slot — a lone slot has nobody to coordinate,
 *  and entering Commander mode would disable the reliable slot watcher (sentinel
 *  / analyzer / cap), leaving the easily-missed ---STAGE-DONE--- sentinel as
 *  the only way to advance. */
function stageCommanderSlot(stage: { slots: StageSlot[] }): StageSlot | null {
  if (stage.slots.length <= 1) return null
  return stage.slots.find((s) => s.isCommander) ?? null
}

/** True when this pane is the Commander slot (renders 🎯 badge).
 *  Uses the raw slot.isCommander flag, not stageCommanderSlot(), so the badge
 *  shows even for single-slot stages. */
function paneIsCommander(p: ActivePane): boolean {
  if (p.origin !== 'pipeline') return false
  const stage = stagesApi.stageById.value[p.stageId]
  if (!stage) return false
  const slot = stage.slots.find((s) => s.label === p.slotLabel)
  return !!slot?.isCommander
}
</script>

<template>
  <div class="app" :style="{ '--token-panel-width': tokenPanelWidth, '--left-width': leftPanelWidth + 'px' }" :class="{ 'is-resizing': isDragging }">
    <ControlPane
      ref="controlPaneRef"
      :backend-status="backend.status.value"
      :backend-url="backendUrl"
      :agent-specs="agentSpecs"
      :roles="rolesApi.roles.value"
      :stages="stagesApi.stages.value"
      :panes="paneViews"
      :pipeline="pipelineView"
      :existing-project="existingProject"
      :workspace="currentWorkspace"
      :mode="currentMode"
      :layout-mode="layoutMode"
      :analyzer-status="analyzerStatus"
      :pipelines="pipelinesApi.pipelines.value"
      :active-pipeline-id="pipelinesApi.activePipelineId.value"
      :backend="backend"
      v-model:yolo-enabled="yoloEnabled"
      v-model:analyzer-model="analyzerModel"
      v-model:auto-answer-enabled="autoAnswerEnabled"
      @spawn="onManualSpawn"
      @kill="onKill"
      @interrupt="onInterrupt"
      @kill-all="onKillAll"
      @reinject="onReinject"
      @restore="restorePane"
      @update:layout-mode="layoutMode = $event"
      @pipeline-start="onPipelineStart"
      @pipeline-next="onPipelineNext"
      @pipeline-abort="onPipelineAbort"
      @pipeline-reset="onPipelineReset"
      @workspace-check="onWorkspaceCheck"
      @pipeline-resume="onPipelineResume"
      @pipeline-restart="onPipelineRestart"
      @refresh-analyzer="onRefreshAnalyzer"
      @focus-pane="onFocusPane"
      @open-settings="showSettings = true"
      @open-history="showHistory = true"
      @switch-workspace="onSwitchWorkspace"
      @workspace-browse="onWorkspaceBrowse"
    />
    <QuestionAlert
      :visible="!!activeQuestion"
      :questions="activeQuestion?.questions ?? []"
      :agent-label="activeQuestion?.agentLabel"
      :stage-title="activeQuestion?.stageTitle"
      :slot-label="activeQuestion?.slotLabel"
      :queue-len="questionQueueLen"
      :pane-id="activeQuestion?.paneId"
      :auto-mode="autoAnswerEnabled && autoAnswerPending"
      :auto-text="autoAnswerText"
      @answer="onAnswerQuestion"
      @cancel="onCancelQuestion"
    />
    <!-- Stage-stall confirmation: shown when strict mode + idle/cap fires -->
    <Teleport v-if="stageStallPrompt" to="body">
      <div class="stall-overlay" @click.self="continueWaitingStall">
        <div class="stall-card">
          <header>
            <span class="stall-dot"></span>
            <strong>Stage {{ stageStallPrompt.stageId }} 似乎停滯了</strong>
            <span v-if="stageStallPrompt.slotLabel" class="stall-slot">· {{ stageStallPrompt.slotLabel }}</span>
          </header>
          <div class="stall-body">
            <div class="stall-title">{{ stageStallPrompt.stageTitle }}</div>
            <div class="stall-reason">
              {{ stageStallPrompt.reason === 'idle' ? '⏸ 偵測到無輸出' : '⏱ 已達時間上限' }}
              — {{ stageStallPrompt.detail }}
            </div>
            <p class="stall-hint">
              嚴格模式：未偵測到 sentinel 或完成意圖。
              選擇<strong>繼續等待</strong>會重置 idle 計時器；<strong>強制推進</strong>會把此 slot 標為完成。
            </p>
            <div v-if="stageStallPrompt.autoAdvanceAt !== null" class="stall-auto">
              🤖 Full auto: 5 秒後自動強制推進…
            </div>
          </div>
          <footer>
            <button class="stall-btn primary" @click="continueWaitingStall">⏯ 繼續等待</button>
            <button class="stall-btn danger" @click="forceAdvanceStall">⏭ 強制推進</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <CompletionModal
      v-if="showCompletionModal"
      :total-stages="stagesApi.stages.value.length"
      @close="showCompletionModal = false"
    />
    <SettingsModal
      v-if="showSettings"
      :backend="backend"
      :roles-api="rolesApi"
      :stages-api="stagesApi"
      :analyzer-api="analyzerApi"
      :pipelines-api="pipelinesApi"
      @close="showSettings = false"
      @open-pipeline="(id) => { showSettings = false; controlPaneRef?.openPipelineDetail(id) }"
    />
    <Teleport v-if="showHistory" to="body">
      <div class="history-overlay" @click.self="showHistory = false">
        <div class="history-modal">
          <div class="history-modal-header">
            <div class="history-header-left">
              <span>Agent History</span>
              <button
                v-if="panes.length > 0"
                class="history-killall"
                @click="confirmKillAll = true"
                title="Kill all agents"
              >🗑 Kill all</button>
            </div>
            <button class="history-close" @click="showHistory = false">✕</button>
          </div>
          <div class="agent-history-list">
            <div v-if="spawnHistory.length === 0" class="agent-history-empty">尚無 agent 紀錄</div>
            <div
              v-for="entry in [...spawnHistory].reverse()"
              :key="entry.paneId"
              class="agent-history-row"
              :class="{ active: !entry.removedAt }"
            >
              <div class="agent-history-main">
                <span class="ah-badge">{{ entry.agentLabel }}</span>
                <span class="ah-badge ah-role">{{ entry.roleLabel }}</span>
                <span class="ah-origin">{{ entry.origin }}</span>
                <span class="ah-status" :class="entry.removedAt ? 'removed' : 'active'">
                  {{ entry.removedAt ? 'removed' : 'active' }}
                </span>
              </div>
              <div class="agent-history-meta">
                <span class="ah-time">{{ new Date(entry.spawnedAt).toLocaleTimeString() }}</span>
                <span v-if="entry.sessionId" class="ah-session" :title="entry.sessionId">
                  🔖 {{ entry.sessionId.slice(0, 8) }}…
                </span>
              </div>
              <div v-if="entry.removedAt" class="agent-history-actions">
                <button class="ah-revive" @click="onReviveAgent(entry)">↺ Re-spawn</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
    <Teleport v-if="confirmKillAll" to="body">
      <div class="history-overlay" @click.self="confirmKillAll = false">
        <div class="history-modal" style="height: auto; max-width: 400px;">
          <div class="history-modal-header">
            <span>🗑 Kill all agents?</span>
            <button class="history-close" @click="confirmKillAll = false">✕</button>
          </div>
          <div style="padding: 16px 14px; font-size: 13px; color: #c9d1d9;">
            這將強制終止 <strong>{{ panes.length }} 個 agent</strong>，所有進行中的工作將遺失。
          </div>
          <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
            <button class="history-close" style="border: 1px solid #30363d; padding: 4px 12px; border-radius: 6px;" @click="confirmKillAll = false">Cancel</button>
            <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="() => { onKillAll(); confirmKillAll = false }">Kill all</button>
          </div>
        </div>
      </div>
    </Teleport>
    <main
      class="stage"
      :data-layout="effectiveLayoutMode"
    >
      <div v-if="panes.length === 0" class="empty">
        <!-- Pipeline is starting but the first pane hasn't appeared yet.
             The orchestrator typically takes 10-30s for the first stage:
             Context7 doc fetch → CLI spawn → settle → role + kickoff inject. -->
        <div v-if="pipeline.state === 'running'" class="empty-card loading-card">
          <div class="spinner"></div>
          <h2>啟動 Pipeline 中…</h2>
          <p class="status">{{ latestPipelineLog }}</p>
          <p class="muted small">
            首個 agent 可能要 10–30 秒（Context7 文件下載 + CLI 啟動 + role/kickoff 注入）。
            <br />進度可在左下 pipeline log 觀察。
          </p>
        </div>
        <div v-else class="empty-card">
          <h2>Two ways to drive the team</h2>
          <p>
            <strong>▶ Run pipeline</strong> — drive all {{ stagesApi.stages.value.length }} SDLC stages end-to-end. Each stage spawns the
            recommended CLI + role and receives a tailored kickoff prompt.
          </p>
          <p>
            <strong>+ Add to grid</strong> — spawn one agent at any role/stage you want, ad-hoc.
          </p>
          <p class="muted">Set workspace + (for pipeline) task description on the left first.</p>
        </div>
      </div>
      <div v-else class="grid" ref="gridRef" :style="gridStyle">
        <!-- Column splitter handles (grid mode only) -->
        <div
          v-for="(pos, i) in colHandlePositions"
          :key="`ch-${i}`"
          class="grid-handle grid-handle-v"
          :style="{ left: pos }"
          @mousedown.prevent="onGridHandleStart($event, 'col', i)"
        />
        <!-- Row splitter handles (grid mode only) -->
        <div
          v-for="(pos, i) in rowHandlePositions"
          :key="`rh-${i}`"
          class="grid-handle grid-handle-h"
          :style="{ top: pos }"
          @mousedown.prevent="onGridHandleStart($event, 'row', i)"
        />
        <!-- Sidebar/auto mode vertical handle -->
        <div
          v-if="effectiveLayoutMode === 'sidebar'"
          class="grid-handle grid-handle-v"
          :style="{ left: sidebarHandlePos }"
          @mousedown.prevent="onGridHandleStart($event, 'sidebar', 0)"
        />
        <!-- Dual-focus split handle (non-grid modes, 2 running panes) -->
        <div
          v-if="dualFocusActive"
          class="grid-handle grid-handle-v"
          :style="{ left: dualFocusHandlePos }"
          @mousedown.prevent="onGridHandleStart($event, 'dual-focus', 0)"
        />
        <TerminalPane
          v-for="p in panes"
          :key="p.id"
          v-show="!minimizedPanes.has(p.id) && !(effectiveLayoutMode === 'sidebar' && p.id !== effectiveFocusPaneId && p.id !== dualFocusSecondaryId) && !(effectiveLayoutMode === 'spotlight' && p.id !== effectiveFocusPaneId && p.id !== dualFocusSecondaryId)"
          :style="{ ...floatPaneStyle(p.id), ...dualFocusStyle(p.id) }"
          :ref="(el) => setPaneRef(p.id, el)"
          :data-pane-id="p.id"
          :pane-id="p.id"
          :title="p.agentLabel"
          :subtitle="paneSubtitle(p)"
          :pipe-tag="p.origin === 'pipeline' && p.stageId ? `P${p.stageId}` : undefined"
          :is-commander="paneIsCommander(p)"
          :is-focus="p.id === effectiveFocusPaneId"
          :backend="backend"
          @set-focus="onSetFocus(p.id)"
          @minimize="minimizePane(p.id)"
        />
        <!-- Auto/sidebar mode: meeting-style agent list on the right -->
        <div v-if="effectiveLayoutMode === 'sidebar'" class="auto-meeting-list" :style="dualFocusActive ? { gridColumn: '3' } : {}">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized)"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId }"
            @click="onSetFocus(p.id)"
          >
            <span class="meeting-avatar">{{ p.agentLabel.charAt(0).toUpperCase() }}</span>
            <div class="meeting-info">
              <div class="meeting-name-row">
                <span v-if="p.origin === 'pipeline' && p.stageId" class="meeting-pipe-tag">P{{ p.stageId }}</span>
                <span class="meeting-name">{{ p.agentLabel }}</span>
              </div>
              <span v-if="p.roleLabel" class="meeting-sub">{{ p.roleLabel }}</span>
            </div>
            <span class="meeting-badge" :data-status="p.status">{{ p.status }}</span>
          </div>
          <div v-if="paneViews.filter(v => !v.isMinimized).length === 0" class="meeting-empty">
            只有一個 agent
          </div>
        </div>
      </div>
      <!-- Spotlight mode: horizontal scrollable bottom strip -->
      <div v-if="effectiveLayoutMode === 'spotlight'" class="spotlight-strip">
        <div
          v-for="p in paneViews.filter(v => !v.isMinimized)"
          :key="p.id"
          class="spotlight-thumb"
          :class="{ 'spotlight-thumb--active': p.id === effectiveFocusPaneId }"
          @click="onSetFocus(p.id)"
        >
          <div class="spotlight-thumb-info">
            <div class="spotlight-thumb-name-row">
              <span v-if="p.origin === 'pipeline' && p.stageId" class="spotlight-thumb-pipe-tag">P{{ p.stageId }}</span>
              <span class="spotlight-thumb-name">{{ p.agentLabel }}</span>
            </div>
            <span v-if="p.roleLabel" class="spotlight-thumb-role">{{ p.roleLabel }}</span>
          </div>
          <span class="spotlight-thumb-badge" :data-status="p.status">{{ p.status }}</span>
        </div>
        <div v-if="paneViews.filter(v => !v.isMinimized).length === 0" class="spotlight-strip-empty">
          只有一個 agent
        </div>
      </div>
      <!-- Fullscreen mode: collapsible PiP agent list (draggable) -->
      <div
        v-if="effectiveLayoutMode === 'fullscreen'"
        class="float-pip"
        :style="{ top: floatPipPos.top + 'px', left: floatPipPos.left + 'px', width: floatPipWidth + 'px' }"
      >
        <div class="float-pip-header" @mousedown.prevent="onPipDragStart">
          <span class="float-pip-title">
            Agents ({{ paneViews.filter(v => !v.isMinimized).length }})
          </span>
          <button class="float-pip-toggle" @mousedown.stop @click="floatPipExpanded = !floatPipExpanded; clampPipPos()">
            {{ floatPipExpanded ? '▾' : '▸' }}
          </button>
        </div>
        <div v-if="floatPipExpanded" class="float-pip-list" :style="{ maxHeight: floatPipListMaxHeight + 'px' }">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized)"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId }"
            @click="onSetFocus(p.id)"
          >
            <span class="meeting-avatar">{{ p.agentLabel.charAt(0).toUpperCase() }}</span>
            <div class="meeting-info">
              <div class="meeting-name-row">
                <span v-if="p.origin === 'pipeline' && p.stageId" class="meeting-pipe-tag">P{{ p.stageId }}</span>
                <span class="meeting-name">{{ p.agentLabel }}</span>
              </div>
              <span v-if="p.roleLabel" class="meeting-sub">{{ p.roleLabel }}</span>
            </div>
            <span class="meeting-badge" :data-status="p.status">{{ p.status }}</span>
          </div>
          <div v-if="paneViews.filter(v => !v.isMinimized).length === 0" class="meeting-empty">
            只有一個 agent
          </div>
        </div>
        <div v-if="floatPipExpanded" class="float-pip-resize" @mousedown="onPipResizeStart" />
      </div>
    </main>
    <TokenStatsPanel
      :backend="backend"
      :workspace-path="pipeline.workspacePath"
      :stages="stagesApi.stages.value"
      :panes="paneViews"
      :pipeline="pipelineView"
      v-model:expanded="tokenPanelExpanded"
    />
    <Welcome
      v-if="!workspaceSelected"
      :backend="backend"
      @select="onWorkspaceSelected"
      @open-settings="showSettings = true"
    />
    <Teleport v-if="confirmCloseWorkspace" to="body">
      <div class="stall-overlay" @click.self="confirmCloseWorkspace = false">
        <div class="stall-card">
          <header>
            <span class="stall-dot"></span>
            <strong>Pipeline 進行中</strong>
          </header>
          <div class="stall-body">
            <p class="stall-hint">
              切換 workspace 會<strong>中止目前 pipeline</strong>並關閉所有 CLI pane。
              pipeline 紀錄會保留在磁碟，稍後重開此 workspace 可 resume。確定要切換嗎？
            </p>
          </div>
          <footer>
            <button class="stall-btn primary" @click="confirmCloseWorkspace = false">取消</button>
            <button class="stall-btn danger" @click="doCloseWorkspace">中止並切換</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <div class="resize-handle resize-handle-left" @mousedown="onResizeStart($event, 'left')" />
    <div v-if="tokenPanelExpanded" class="resize-handle resize-handle-right" @mousedown="onResizeStart($event, 'right')" />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  /* Three columns: controls · terminal grid · token stats panel
     Both left and token-panel widths are driven by CSS vars set inline. */
  grid-template-columns: var(--left-width, 360px) 1fr var(--token-panel-width, 36px);
  position: relative;
  height: 100vh;
  background: #010409;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  overflow: hidden;
}
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 50;
}
.resize-handle::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle:hover::after {
  background: #388bfd44;
}
.is-resizing .resize-handle::after {
  background: #388bfd66;
}
.resize-handle-left {
  left: var(--left-width, 360px);
  transform: translateX(-50%);
}
.resize-handle-right {
  right: var(--token-panel-width, 36px);
  transform: translateX(50%);
}
.stage {
  position: relative;
  padding: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.grid {
  display: grid;
  /* grid-template-columns/rows are driven by gridStyle computed (JS) */
  gap: 8px;
  height: 100%;
  position: relative;
}
/* Grid pane splitter handles */
.grid-handle {
  position: absolute;
  z-index: 20;
}
.grid-handle::after {
  content: '';
  position: absolute;
  background: transparent;
  transition: background 0.15s;
}
.grid-handle:hover::after,
.is-resizing .grid-handle::after {
  background: #388bfd55;
}
.grid-handle-v {
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  transform: translateX(-50%);
}
.grid-handle-v::after {
  inset: 0 3px;
}
.grid-handle-h {
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  transform: translateY(-50%);
}
.grid-handle-h::after {
  inset: 3px 0;
}
/* Spotlight: stage as flex column — grid on top, scroll strip on bottom */
.stage[data-layout="spotlight"] {
  display: flex;
  flex-direction: column;
  padding: 0;
}
.stage[data-layout="spotlight"] .grid {
  flex: 1;
  min-height: 0;
  margin: 8px 8px 0;
}
/* Spotlight horizontal scrollable bottom strip */
.spotlight-strip {
  flex-shrink: 0;
  height: 104px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 10px;
  background: #0d1117;
  border-top: 1px solid #21262d;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}
.spotlight-strip::-webkit-scrollbar { height: 4px; }
.spotlight-strip::-webkit-scrollbar-track { background: transparent; }
.spotlight-strip::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
.spotlight-thumb {
  flex-shrink: 0;
  width: 160px;
  height: 84px;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 6px;
  padding: 9px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transition: border-color 0.12s, box-shadow 0.12s;
  overflow: hidden;
}
.spotlight-thumb:hover {
  border-color: #388bfd66;
  box-shadow: 0 2px 12px rgba(56, 139, 253, 0.15);
  background: #1a2332;
}
.spotlight-thumb--active {
  border-color: #388bfd;
  box-shadow: 0 0 0 2px rgba(56, 139, 253, 0.25);
  background: #1a2332;
}
.spotlight-thumb-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.spotlight-thumb-name-row {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.spotlight-thumb-pipe-tag {
  font-size: 8px;
  font-weight: 700;
  background: #1f3a5f;
  color: #79c0ff;
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.spotlight-thumb-name {
  font-size: 11px;
  font-weight: 600;
  color: #e6edf3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotlight-thumb-role {
  font-size: 9px;
  color: #8b949e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotlight-thumb-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  align-self: flex-start;
  margin-top: auto;
}
.spotlight-thumb-badge[data-status="running"]  { background: #0d2818; color: #3fb950; border: 1px solid #238636; }
.spotlight-thumb-badge[data-status="idle"]     { background: #2d2100; color: #e3b341; border: 1px solid #9e6a03; }
.spotlight-thumb-badge[data-status="starting"] { background: #0d1a2d; color: #58a6ff; border: 1px solid #1f6feb; }
.spotlight-thumb-badge[data-status="error"],
.spotlight-thumb-badge[data-status="stopped"]  { background: #3d0d0d; color: #f85149; border: 1px solid #da3633; }
.spotlight-strip-empty {
  color: #484f58;
  font-size: 11px;
  padding: 0 8px;
}
/* Sidebar (Auto): focus pane fills left column; meeting list in right column */
.stage[data-layout="sidebar"] .grid :deep(.pane-focus) {
  grid-column: 1;
  grid-row: 1;
}
/* Meeting-style agent list */
.auto-meeting-list {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  padding: 8px 6px;
  background: #0d1117;
  min-width: 140px;
}
.meeting-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #21262d;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  min-width: 0;
}
.meeting-item:hover {
  background: #161b22;
  border-color: #388bfd66;
}
.meeting-item--active {
  border-color: #388bfd;
  background: #1a2332;
  box-shadow: 0 0 0 2px rgba(56, 139, 253, 0.2);
}
.meeting-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #1a2332;
  border: 1px solid #30363d;
  color: #58a6ff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.meeting-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meeting-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.meeting-pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: #1f3a5f;
  color: #79c0ff;
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.meeting-name {
  font-size: 12px;
  color: #e6edf3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.meeting-sub {
  font-size: 10px;
  color: #8b949e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meeting-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.meeting-badge[data-status="running"]  { background: #0d2818; color: #3fb950; border: 1px solid #238636; }
.meeting-badge[data-status="idle"]     { background: #2d2100; color: #e3b341; border: 1px solid #9e6a03; }
.meeting-badge[data-status="stopped"]  { background: #3d0d0d; color: #f85149; border: 1px solid #da3633; }
.meeting-badge[data-status="starting"] { background: #0d1a2d; color: #58a6ff; border: 1px solid #1f6feb; }
.meeting-badge[data-status="error"]    { background: #3d0d0d; color: #ffa198; border: 1px solid #da3633; }
.meeting-empty {
  color: #484f58;
  font-size: 11px;
  text-align: center;
  padding: 16px 8px;
}
/* Fullscreen: focus pane fills entire grid */
.stage[data-layout="fullscreen"] .grid :deep(.pane-focus) {
  grid-column: 1;
  grid-row: 1;
}
/* Fullscreen PiP collapsible list */
.float-pip {
  position: absolute;
  z-index: 30;
  min-width: 160px;
  background: #0d1117ee;
  border: 1px solid #30363d;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
}
.float-pip-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 40%, #444d56 40%, #444d56 60%, transparent 60%),
              linear-gradient(135deg, transparent 60%, #444d56 60%, #444d56 80%, transparent 80%);
  opacity: 0.5;
  border-radius: 0 0 8px 0;
}
.float-pip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  cursor: move;
  background: #161b22;
  border-bottom: 1px solid #21262d;
  user-select: none;
}
.float-pip-title {
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
}
.float-pip-toggle {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}
.float-pip-toggle:hover { color: #e6edf3; }
.float-pip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.empty-card {
  text-align: center;
  max-width: 520px;
  padding: 28px 32px;
  border: 1px dashed #30363d;
  border-radius: 8px;
  background: #0d1117;
}
.empty-card h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.empty-card p {
  margin: 8px 0;
  font-size: 13px;
  color: #c9d1d9;
  text-align: left;
}
.empty-card .muted {
  color: #8b949e;
  font-size: 12px;
}
.empty-card.loading-card {
  border-style: solid;
  border-color: #1f6feb55;
  background: linear-gradient(180deg, #0d1117 0%, #0d1730 100%);
}
.empty-card.loading-card h2 {
  text-align: center;
  margin-top: 16px;
}
.empty-card .status {
  text-align: center;
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  color: #79c0ff;
  background: #0a1426;
  border: 1px solid #1f3a5f;
  border-radius: 4px;
  padding: 8px 12px;
  margin: 12px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.empty-card .small {
  text-align: center;
  font-size: 11px;
  line-height: 1.7;
}
.spinner {
  width: 38px;
  height: 38px;
  margin: 0 auto;
  border: 3px solid #1f3a5f;
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Stage-stall confirmation modal ──────────────────────────────────────── */
.history-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.history-modal {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  width: min(680px, 92vw);
  height: min(560px, 85vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #21262d;
  font-size: 13px;
  font-weight: 600;
  color: #e6edf3;
}
.history-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-killall {
  background: transparent;
  border: 1px solid #6e363666;
  color: #f85149;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
}
.history-killall:hover {
  background: #6e363622;
  border-color: #f85149;
  opacity: 1;
}
.history-close {
  background: transparent;
  border: none;
  color: #8b949e;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.history-close:hover {
  color: #e6edf3;
  background: #21262d;
}
.agent-history-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.agent-history-empty {
  color: #8b949e;
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.agent-history-row {
  padding: 8px 14px;
  border-bottom: 1px solid #161b22;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-history-row.active {
  border-left: 3px solid #3fb950;
  padding-left: 11px;
}
.agent-history-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ah-badge {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: #e6edf3;
}
.ah-badge.ah-role {
  color: #79c0ff;
  border-color: #388bfd55;
}
.ah-origin {
  font-size: 10px;
  color: #8b949e;
}
.ah-status {
  font-size: 10px;
  font-weight: 600;
}
.ah-status.active { color: #3fb950; }
.ah-status.removed { color: #6e7681; }
.agent-history-meta {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: #6e7681;
}
.ah-session {
  font-family: monospace;
}
.agent-history-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.ah-revive {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid #388bfd66;
  background: #388bfd14;
  color: #79c0ff;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ah-revive:hover {
  background: #388bfd28;
  border-color: #79c0ff;
  color: #cae8ff;
}
.stall-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.stall-card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-left: 4px solid #f0883e;
  border-radius: 8px;
  width: min(520px, 92vw);
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.stall-card header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #21262d;
  background: #161b22;
}
.stall-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #f0883e;
  box-shadow: 0 0 0 4px rgba(240, 136, 62, 0.2);
}
.stall-slot {
  color: #8b949e;
  font-size: 11px;
}
.stall-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stall-title {
  font-size: 14px;
  font-weight: 600;
  color: #c9d1d9;
}
.stall-reason {
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  color: #f0883e;
  background: #21130d;
  border: 1px solid #4d2818;
  border-radius: 4px;
  padding: 8px 10px;
}
.stall-hint {
  margin: 0;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.6;
}
.stall-hint strong {
  color: #e6edf3;
}
.stall-auto {
  font-size: 12px;
  color: #79c0ff;
  font-weight: 500;
}
.stall-card footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid #21262d;
  background: #0d1117;
}
.stall-btn {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.stall-btn.primary {
  background: #238636;
  border-color: #2ea043;
  color: #fff;
}
.stall-btn.primary:hover {
  background: #2ea043;
}
.stall-btn.danger {
  background: #6f1f1f;
  border-color: #8a2929;
  color: #f4d2d2;
}
.stall-btn.danger:hover {
  background: #8a2929;
}
</style>
<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: #010409;
}
</style>
