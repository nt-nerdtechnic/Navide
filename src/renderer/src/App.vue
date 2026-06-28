<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import ViewPanel, { type LayoutMode } from './components/ViewPanel.vue'
import TerminalPane from './components/TerminalPane.vue'
import ControlPane, {
  type AgentSpec,
  type ActivePaneView,
  type SpawnPayload,
  type ResumePayload,
  type PipelineState,
  type PipelineStatusView,
  type ExistingProjectInfo,
  type AnalyzerStatusView,
  type WorkspaceMode
} from './components/ControlPane.vue'
import QuestionAlert from './components/QuestionAlert.vue'
import TokenStatsPanel from './components/TokenStatsPanel.vue'
import NotificationHost from './components/NotificationHost.vue'
import Welcome from './components/Welcome.vue'
import StageTabBar, { type TabItem } from './components/StageTabBar.vue'
import { useBackend } from './composables/useBackend'
import { useTheme } from './composables/useTheme'
import { useSettings } from './composables/useSettings'
import { useRoles } from './composables/useRoles'
import { useStages } from './composables/useStages'
import { usePipelines } from './composables/usePipelines'
import { useAnalyzer, type ClassifyResult } from './composables/useAnalyzer'
import { useSystemNotify } from './composables/useSystemNotify'
import { playDoneSound, playAttentionSound } from './composables/useSoundNotify'
import { formatIssueForDispatch, type IssueDetail } from './composables/useIssues'
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
import { i18n } from './i18n'
import { findConsecutiveQuestionBlocks, findSentinel } from './lib/buffer'
import { allSlotsFinished, turnCompleteDone, type SlotSignal } from './lib/completion'
import { quickClassify } from './lib/quick-classify'
import { buildResumeCommand } from './lib/resume-command'
import { useKeybindings, registerCommand, setContext } from './keybindings/useKeybindings'

// Modals/wizard that only render behind a v-if (settings opened, run completed,
// first-run onboarding) — defer them off the main shell's first-paint bundle.
const CompletionModal = defineAsyncComponent(() => import('./components/CompletionModal.vue'))
const SettingsModal = defineAsyncComponent(() => import('./components/SettingsModal.vue'))
const OnboardingWizard = defineAsyncComponent(() => import('./components/OnboardingWizard.vue'))

const backend = useBackend()
const rolesApi = useRoles(backend)
const pipelinesApi = usePipelines(backend)
const stagesApi = useStages(backend, () => pipelinesApi.activePipelineId.value)
const analyzerApi = useAnalyzer(backend)
const themeApi = useTheme()
const settingsApi = useSettings()

// Apply the theme and language as early as possible (localStorage → default).
// The backend backup is adopted later inside onWorkspaceCheck.
onMounted(() => {
  themeApi.loadTheme()
  settingsApi.loadLanguage()
  window.agentTeam?.onLanguageChanged?.((locale) => {
    settingsApi.setLanguage(locale)
  })
  // Clicking a system notification focuses the window on the originating pane.
  window.agentTeam?.onFocusPane?.((paneId) => { onFocusPane(paneId) })
  window.addEventListener('resize', onWindowResize)
  // Warm the heaviest deferred panel (Settings) during idle: it stays lazy to
  // keep off first paint, but it's commonly opened, so pre-fetching once the
  // shell is interactive makes its first open instant at no visible cost.
  const warmSettings = (): void => { void import('./components/SettingsModal.vue') }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warmSettings, { timeout: 4000 })
  } else {
    window.setTimeout(warmSettings, 2500)
  }
})

// ── First-run onboarding gate ────────────────────────────────────────────────
// `null` = not yet checked. When the backend connects we ask whether the
// environment setup is complete; if not, OnboardingWizard hard-blocks the shell.
const onboardingComplete = ref<boolean | null>(null)
async function checkOnboarding(): Promise<void> {
  try {
    const resp = await backend.send<{ complete?: boolean; skip?: boolean }>('onboarding.status', {})
    onboardingComplete.value = resp.payload?.complete ?? true
  } catch {
    // If the check fails, don't lock the user out — fail open.
    onboardingComplete.value = true
  }
}
// First-boot loading overlay: shown until the backend first settles, then
// dismissed for good (later reconnects use the status-bar indicator, not this).
const booting = ref(true)
const bootError = ref(false)
// Reflect the real boot phase in the splash status instead of a flat "loading".
const bootStatusKey = computed(() => {
  switch (backend.status.value) {
    case 'starting': return 'label.boot-starting'
    case 'connecting':
    case 'disconnected': return 'label.boot-connecting'
    default: return 'label.loading'
  }
})
const dismissBoot = (): void => { booting.value = false }
let _bootTimer: number | undefined
function armBootTimeout(): void {
  if (_bootTimer) clearTimeout(_bootTimer)
  // Safety net: dismiss a stuck spinner so the user is never trapped — but never
  // override an error state, which stays put with a Retry button. Kept just past
  // useBackend's 20s init deadline: on a slow cold start the backend may take up
  // to 20s to report ready (then connect) or to give up and set status='error'.
  // Firing earlier would tear the overlay down mid-startup, revealing a bare
  // unconnected shell and pre-empting the error+Retry the backend failure path
  // is meant to show.
  _bootTimer = window.setTimeout(() => { if (!bootError.value) dismissBoot() }, 22_000)
}
armBootTimeout()
function retryBackend(): void {
  bootError.value = false
  booting.value = true
  armBootTimeout()
  void backend.restart()
}
watch(
  () => backend.status.value,
  (s) => {
    if (s === 'connected' && onboardingComplete.value === null) void checkOnboarding()
    if (s === 'connected') { booting.value = false; bootError.value = false }
    // On a hard failure, keep the overlay and show an error + Retry (the app is
    // non-functional without a backend anyway). 'disconnected' is transient
    // during reconnect backoff, so it's left alone.
    else if (s === 'error') bootError.value = true
  },
  { immediate: true },
)
function reopenOnboarding(): void {
  onboardingComplete.value = false
}

// --- Workspace-first entry gate (phase-4) ------------------------------------
// The Welcome screen is shown until a workspace is chosen. Selection is kept in
// sessionStorage so a reload (Vite HMR / refresh) stays in the workspace, but a
// full app restart returns to Welcome.
const WS_SELECTED_KEY = 'agentTeam.workspaceSelected'
const WS_PATH_KEY = 'agentTeam.currentWorkspace'
// A duplicated main window (cmd+shift+N) receives its workspace via URL param.
// sessionStorage is per-window so it would otherwise boot to Welcome; the URL
// param seeds it. The window must NOT auto-resume the source window's agent
// panes (that would double-resume the same CLI sessions), so restore is
// suppressed once on this first load — see onWorkspaceCheck.
const _bootWorkspace = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
let suppressPaneRestoreOnce = _bootWorkspace !== ''
if (_bootWorkspace) {
  try {
    sessionStorage.setItem(WS_PATH_KEY, _bootWorkspace)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}
const currentWorkspace = ref<string>(
  _bootWorkspace ||
  (() => {
    try {
      return sessionStorage.getItem(WS_PATH_KEY) ?? ''
    } catch {
      return ''
    }
  })()
)
const workspaceSelected = ref<boolean>(
  _bootWorkspace !== '' ||
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

// Best-effort backup of theme prefs to the workspace JSON (source of truth stays
// in localStorage). Fires whenever the active theme or custom overrides change.
watch(
  [themeApi.theme, themeApi.customOverrides],
  () => {
    if (currentWorkspace.value) {
      void themeApi.syncToBackend(backend.send, currentWorkspace.value)
    }
  },
  { deep: true },
)
// Best-effort backup of language pref to the workspace JSON.
watch(settingsApi.language, () => {
  if (currentWorkspace.value) {
    void settingsApi.syncToBackend(backend.send, currentWorkspace.value)
  }
})

function roleLabel(key: string): string {
  if (!key) return i18n.global.t('label.no-role')
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
  },
  {
    agentKey: 'antigravity',
    label: 'Antigravity CLI',
    defaultCommand: 'agy',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'generalist'
  },
  {
    agentKey: 'terminal',
    label: 'Terminal',
    defaultCommand: '',
    hint: 'plain shell'
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

function refitAllTerminals(): void {
  void nextTick(() => requestAnimationFrame(() => {
    for (const ref of Object.values(paneRefs)) {
      (ref as unknown as { fitTerminal?: () => void })?.fitTerminal?.()
    }
  }))
}

// Window-level resize safety net. Per-pane ResizeObservers can miss the macOS
// fullscreen / maximize transition (the renderer is occluded mid-animation, so
// the observer callback is coalesced away), leaving panes at a stale width with
// empty space on the right. A debounced window 'resize' listener guarantees a
// refit on any OS-window size change regardless of the observers.
let _winResizeTimer: number | null = null
function onWindowResize(): void {
  if (_winResizeTimer !== null) clearTimeout(_winResizeTimer)
  _winResizeTimer = window.setTimeout(() => { _winResizeTimer = null; refitAllTerminals() }, 150)
}

function onResizeEnd(): void {
  _dragTarget = null
  isDragging.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  refitAllTerminals()
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
type PreparationStatus = 'starting' | 'checking-dialog' | 'settling' | 'injecting-role' | 'waiting-agent' | 'ready' | 'failed'

interface RunGroup {
  id: string
  name: string
  createdAt: number
}

interface ActivePane {
  id: string
  agentKey: string
  agentLabel: string
  /** User-set display name from the rename action. Overrides agentLabel in all
   *  pane surfaces when non-empty; persisted to project.json (PaneRecord.custom_name). */
  customName?: string
  roleKey: RoleKey
  stageId: StageId
  /** Human-readable slot label, e.g. "Architecture" or "UI/UX".
   *  Empty string for single-agent stages or manually-spawned panes. */
  slotLabel: string
  command: string
  workspacePath: string
  origin: 'manual' | 'pipeline'
  /** Which pipeline run group this pane belongs to. Undefined = unassigned (manual). */
  runGroupId?: string
  injectionStatus: InjectionStatus
  preparationStatus: PreparationStatus
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
  /** Stable Codex CODEX_HOME id. It can differ from the live pane id after restore. */
  sessionHomeId?: string
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
  restoreMode?: 'memory-resume' | 'fresh'
  sessionHomeId?: string
}

const panes = ref<ActivePane[]>([])
const paneRefs = reactive<Record<string, InstanceType<typeof TerminalPane> | null>>({})
const persistedPaneSessions = new Set<string>()
const SPAWN_HISTORY_KEY = 'agentTeam.spawnHistory'
const MAX_SPAWN_HISTORY = 100

function loadSpawnHistory(): SpawnHistoryEntry[] {
  try {
    const raw = localStorage.getItem(SPAWN_HISTORY_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as SpawnHistoryEntry[]).slice(-MAX_SPAWN_HISTORY)
  } catch {
    return []
  }
}

const spawnHistory = ref<SpawnHistoryEntry[]>(loadSpawnHistory())

watch(spawnHistory, (v) => {
  try {
    localStorage.setItem(SPAWN_HISTORY_KEY, JSON.stringify(v.slice(-MAX_SPAWN_HISTORY)))
  } catch {}
}, { deep: true })

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
      agentLabel: p.customName || p.agentLabel,
      roleKey: p.roleKey,
      roleLabel: roleLabel(p.roleKey),
      stageId: p.stageId,
      command: p.command,
      status: (ref?.displayStatus as string | undefined) ?? (ref?.status as string | undefined) ?? 'starting',
      error: ref?.error as string | undefined,
      injectionStatus: p.injectionStatus,
      preparationStatus: p.preparationStatus,
      kickoffStatus: p.kickoffStatus,
      origin: p.origin,
      isCommander: paneIsCommander(p),
      sessionId: p.pinnedSessionId,
      slotLabel: p.slotLabel,
      isMinimized: minimizedPanes.value.has(p.id)
    }
  })
}

let _syncViewsTimer: number | null = null
onMounted(() => { _syncViewsTimer = window.setInterval(syncViews, 400) })
onUnmounted(() => {
  if (_syncViewsTimer !== null) clearInterval(_syncViewsTimer)
  window.removeEventListener('resize', onWindowResize)
  if (_winResizeTimer !== null) clearTimeout(_winResizeTimer)
})
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

// Dispatch a cloud issue into a running agent pane as a task (one-way: no
// write-back to the issue). Reuses the pipeline-kickoff injection path.
async function onDispatchIssue(payload: { paneId: string; issue: IssueDetail }): Promise<void> {
  const ok = await injectPane(payload.paneId, formatIssueForDispatch(payload.issue), 'issue-dispatch', true)
  if (!ok) console.warn(`[dispatch-issue] injection failed for pane ${payload.paneId}`)
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

async function waitForStartupActivity(paneId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return false
    const ref = paneRefs[paneId]
    if (!ref) return false
    const status = ref.status as unknown as string
    if (status === 'error' || status === 'exited') return false
    const cleanSize = ((ref.cleanBuffer as unknown as string) ?? '').length
    const rawAt = Number((ref.lastRawActivityAt as unknown as number | undefined) ?? 0)
    if (cleanSize > 0 || rawAt > 0) return true
    await sleep(250)
  }
  return false
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
    const resp = await sendQuiet<ProjectPayload>('manual_pane.session', {
      workspace_path: pane.workspacePath,
      pane_id: pane.id,
      session_id: id,
    })
    // The backend silently noops when the manual pane record doesn't exist
    // yet (persist can race manual_pane.spawn) — only cache a write the
    // response confirms, so a later event can retry.
    saved = resp?.project?.panes?.some(
      (p) => p.pane_id === pane.id && p.session_id === id
    ) ? resp : null
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
  pane.preparationStatus = 'checking-dialog'
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
    pane.preparationStatus = 'settling'
    syncViews()
    await sleep(settleMs)
    if (!paneAlive(pane.id)) return

    // 3. Inject role system prompt — unless this is a pre-spawn pane that
    //    will receive role + kickoff together at activation time.
    if (!pane.roleKey) {
      pane.injectionStatus = 'skipped'
      pane.preparationStatus = 'ready'
      syncViews()
      pipelineLog(`${tag} ⏸ no role selected — skipping role injection`)
      if (pane.origin === 'manual' && pane.agentKey === 'claude' && pane.pinnedSessionId) {
        void persistPaneSession(pane, pane.pinnedSessionId)
      }
      return
    }
    if (pane.skipRoleInjection) {
      pane.injectionStatus = 'skipped'
      pane.preparationStatus = 'ready'
      syncViews()
      pipelineLog(`${tag} ⏸ role deferred (pre-spawn — will inject at stage activation)`)
      return
    }
    const role = rolesApi.find(pane.roleKey)
    if (!role) {
      pane.injectionStatus = 'failed'
      pane.preparationStatus = 'failed'
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
    pane.preparationStatus = 'injecting-role'
    syncViews()
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
    pane.preparationStatus = ok ? 'ready' : 'failed'
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
      pane.preparationStatus = 'waiting-agent'
      syncViews()
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
      pane.preparationStatus = ok2 ? 'ready' : 'failed'
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
  runGroupId?: string
  kickoffPrompt?: string
  skipRoleInjection?: boolean
  /** True when commandOverride is a `--resume`/`resume` command restoring a
   *  prior session. Suppresses the fresh Claude --session-id and the
   *  Codex/Gemini detection marker — the session id is already known. */
  isResume?: boolean
  /** Pipeline stage index. */
  stageIndex?: number
  /** Restore mode label for the agent history badge. */
  restoreMode?: 'memory-resume' | 'fresh'
  sessionHomeId?: string
  resumeSessionId?: string
}

/** Trailing line embedded in a Codex/Gemini kickoff so the backend can match
 *  the resulting CLI session file back to this pane (those CLIs can't pin a
 *  session id at launch). Innocuous to the agent; only the marker text matters.
 *  Empty marker (Claude / manual panes) → no line added. */
function sessionMarkerLine(marker?: string): string {
  return marker ? `\n\n<!-- agent-team-session: ${marker} -->` : ''
}

async function sendSessionMarkerBootstrap(pane: ActivePane, tag: string): Promise<boolean> {
  const markerText = sessionMarkerLine(pane.sessionMarker).trim()
  if (!markerText) return false
  try {
    await dismissStartupDialog(pane.id, DISMISS_TIMEOUT_MS)
    if (!(await waitForStartupActivity(pane.id))) {
      pipelineLog(`${tag} ⚠ no startup activity detected — session marker not sent`)
      return false
    }
    await waitForQuiet(pane.id, 1000, 8000)
    if (!paneAlive(pane.id)) return false
    const ref = paneRefs[pane.id]
    if (!ref?.sessionId) return false
    backend.send('terminal.log_sent', {
      terminal_session_id: ref.sessionId as string,
      label: `session-marker:${pane.agentKey}`,
      text: markerText
    }).catch(() => {/* ignore */})
    await backend.send('terminal.input', {
      terminal_session_id: ref.sessionId as string,
      data: BRACKETED_PASTE_START + markerText + BRACKETED_PASTE_END
    })
    await sleep(250)
    await backend.send('terminal.input', {
      terminal_session_id: ref.sessionId as string,
      data: '\r'
    })
    pipelineLog(`${tag} ✓ session marker sent for resume capture`)
    return true
  } catch (err) {
    console.error('[sendSessionMarkerBootstrap] failed:', err)
    pipelineLog(`${tag} ⚠ session marker send failed — resume id may stay unknown`)
    return false
  }
}

async function spawnPane(opts: SpawnInternal): Promise<string | null> {
  const spec = agentSpecs.find((s) => s.agentKey === opts.agentKey)
  if (!spec) return null
  let command = resolveCommand(opts.agentKey, opts.commandOverride)
  const userShell = backend.shell.value || 'bash'

  if (opts.agentKey === 'terminal' && !command) {
    command = userShell
  }

  const id = crypto.randomUUID()
  // For Claude, pin a unique --session-id so backend attribution maps THIS
  // pane's CLI events (turn_complete / agent_active / JSONL) precisely. Without
  // it, panes sharing one workspace are matched by a first-come-claim heuristic
  // that mis-routed a pane's turn_complete to a sibling (the Stage 01 bug).
  let explicitSessionId = ''
  if (opts.agentKey === 'claude' && !opts.isResume && !command.includes('--session-id')) {
    explicitSessionId = crypto.randomUUID()
    command = `${command} --session-id ${explicitSessionId}`
  } else if (opts.agentKey === 'gemini' && !opts.isResume && !command.includes('--session-id')) {
    explicitSessionId = crypto.randomUUID()
    command = `${command} --session-id ${explicitSessionId}`
  }
  const sessionHomeId = opts.agentKey === 'codex'
    ? (opts.sessionHomeId || id)
    : ''
  const pinnedSessionId = opts.isResume
    ? (opts.resumeSessionId?.trim() || undefined)
    : (opts.agentKey === 'claude' ? explicitSessionId || undefined : undefined)
  // Codex keeps a marker fallback during rollout. Gemini now pins a session id
  // at launch, so it only needs the marker if the explicit path fails and the
  // pane is non-resume. Antigravity can't pin an id at launch (`agy
  // --conversation` only resumes existing ids), so the marker is its ONLY
  // session-binding path.
  const sessionMarker =
    !opts.isResume &&
    (opts.agentKey === 'codex' || opts.agentKey === 'antigravity')
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
    runGroupId: opts.runGroupId,
    injectionStatus: 'pending',
    preparationStatus: 'starting',
    injectionTimer: null,
    kickoffStatus: opts.kickoffPrompt ? 'pending' : 'none',
    kickoffPrompt: opts.kickoffPrompt ?? '',
    skipRoleInjection: opts.skipRoleInjection ?? false,
    pinnedSessionId,
    sessionHomeId: sessionHomeId || undefined,
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
    restoreMode: opts.restoreMode,
    sessionHomeId: pane.sessionHomeId,
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
      command: [userShell, '-lc', command],
      cwd: opts.workspacePath,
      agentKey: opts.agentKey,
      metadata: {
        roleKey: opts.roleKey,
        stageId: opts.stageId,
        stage_id: opts.stageId,                 // snake_case alias for backend token sink
        origin: opts.origin,
        workspace_path: opts.workspacePath ?? '',
        explicit_session_id: explicitSessionId,  // Claude/Gemini --session-id → precise pane attribution
        session_marker: sessionMarker,           // Codex → marker fallback session detection
        session_home_id: sessionHomeId,           // Codex per-pane CODEX_HOME id
        slot_label: opts.slotLabel ?? ''          // stable by_pane key survives frontend restarts
      },
      outputLogFile,
      // Stable reattach key: the pinned CLI session id is identical on first
      // spawn and on restore (claude --session-id), so a reload reattaches to
      // the live PTY instead of starting a second `--resume` that collides.
      resumeKey: pinnedSessionId,
      // Resume panes must create at the real width (reprint); fresh panes may
      // create immediately even while hidden (empty CLI) so a pipeline stage
      // spawned into a non-active tab still starts.
      isResume: opts.isResume,
    })

    if ((ref.status as unknown as string) === 'running') {
      if (pane.origin === 'manual' && !pane.roleKey && !pane.kickoffPrompt) {
        pane.injectionStatus = 'skipped'
        pane.preparationStatus = 'ready'
        syncViews()
        if (pane.agentKey === 'claude' && pane.pinnedSessionId) {
          void persistPaneSession(pane, pane.pinnedSessionId)
        }
        return id
      }
      scheduleInjection(pane)
    } else if ((ref.status as unknown as string) === 'starting') {
      // A resume parked on a hidden tab returns 'starting' — its PTY (and the
      // --resume) is created when the tab is shown. Resume reloads memory, so
      // nothing is injected; this is a ready pane, NOT a spawn failure.
      pane.injectionStatus = 'skipped'
      pane.preparationStatus = 'ready'
    } else {
      pane.injectionStatus = 'skipped'
      pane.preparationStatus = 'failed'
    }
  } finally {
    syncViews()
  }
  return id
}

async function onManualSpawn(payload: SpawnPayload): Promise<void> {
  // Spawn into the tab the user is LOOKING AT. currentRunGroupId lags behind
  // activeTab for the synthetic "手動" tab (the sync watcher skips it), which
  // sent panes to a different tab than the one being viewed.
  const spawnGroupId =
    activeTab.value === 'manual'
      ? ''
      : runGroups.value.some((g) => g.id === activeTab.value)
        ? activeTab.value
        : currentRunGroupId.value || ''
  const paneId = await spawnPane({
    agentKey: payload.agentKey,
    roleKey: payload.roleKey,
    stageId: payload.stageId,
    commandOverride: '',
    workspacePath: payload.workspacePath,
    origin: 'manual',
    runGroupId: spawnGroupId || undefined,
  })
  if (paneId) {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: payload.workspacePath,
      pane_id: paneId,
      agent: payload.agentKey,
      role: payload.roleKey,
      command: '',
      // Claude's pinned --session-id is known at spawn: pass it here so the
      // record is created with it atomically (a separate manual_pane.session
      // call would race this spawn and silently noop on the backend).
      session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
      session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
      run_group_id: spawnGroupId,
    })
    const pane = panes.value.find((p) => p.id === paneId)
    if (pane?.sessionMarker && !pane.roleKey && !pane.kickoffPrompt) {
      void sendSessionMarkerBootstrap(pane, `[pane ${pane.id.slice(0, 8)}]`)
    }
  }
}

// Resume an existing agent session by id (Manual Spawn → Resume button). Reuses
// the same resume path as boot-restore: validate → buildResumeCommand → spawnPane
// with isResume/skipRoleInjection. No role is injected (the session already
// carries its own context).
async function onManualResume(payload: ResumePayload): Promise<void> {
  const { agentKey, workspacePath } = payload
  const sessionId = payload.sessionId.trim()
  if (!sessionId) return
  // Authoritative existence check: the datalist may list a since-deleted id, or
  // the user may have pasted a bad one. Never fall through to a fresh spawn —
  // that would silently start a brand-new agent and confuse the user.
  const exists = await canResumeSession(agentKey, workspacePath, sessionId)
  if (!exists) {
    controlPaneRef.value?.showResumeError(i18n.global.t('label.resume-session-not-found'))
    return
  }
  const spec = agentSpecs.find((s) => s.agentKey === agentKey)
  const skipFlag = yoloEnabled.value ? (spec?.skipPermissionFlag ?? '') : ''
  const commandOverride = buildResumeCommand(agentKey, sessionId, skipFlag)
  const spawnGroupId =
    activeTab.value === 'manual'
      ? ''
      : runGroups.value.some((g) => g.id === activeTab.value)
        ? activeTab.value
        : currentRunGroupId.value || ''
  const paneId = await spawnPane({
    agentKey: agentKey as AgentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    commandOverride,
    workspacePath,
    origin: 'manual',
    runGroupId: spawnGroupId || undefined,
    isResume: true,
    skipRoleInjection: true,
    restoreMode: 'memory-resume',
    resumeSessionId: sessionId,
  })
  if (paneId) {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: workspacePath,
      pane_id: paneId,
      agent: agentKey,
      role: '',
      command: commandOverride,
      session_id: sessionId,
      session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
      run_group_id: spawnGroupId,
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
      // session_id is stable across restarts (pane_id is regenerated each launch);
      // sending it lets the backend remove the right record even if the id drifted,
      // so a removed CLI can't resurrect on the next restart.
      session_id: pane.pinnedSessionId ?? '',
    })
  }
  if (opts.markRemoved !== false && pane?.agentKey === 'codex' && pane.sessionHomeId) {
    await sendQuiet('codex_home.cleanup', {
      session_home_id: pane.sessionHomeId,
    })
  }
  const histEntry = spawnHistory.value.find((e) => e.paneId === paneId)
  if (histEntry && !histEntry.removedAt) {
    histEntry.sessionId = pane?.pinnedSessionId ?? histEntry.sessionId
    histEntry.removedAt = new Date().toISOString()
  }
  panes.value = panes.value.filter((p) => p.id !== paneId)
  delete paneRefs[paneId]
  clearDoneNotifyTimer(paneId)
  sysNotify.forgetPane(paneId)
  syncViews()
}

/** Recover a render-corrupted pane: kill it and re-spawn the same CLI session
 *  via --resume at the current size. A fresh terminal has no stale content for
 *  xterm to reflow, so the cursor-up overlap/ghosting clears (reuses the exact
 *  restart-resume path). Only offered for panes with a resumable session id
 *  (see :can-rebuild). Interrupts the in-flight turn and reprints the
 *  conversation; no-ops if the id isn't actually resumable. */
async function rebuildPaneViaResume(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const sessionId = (pane.pinnedSessionId ?? '').trim()
  if (!sessionId) return
  const ws = pane.workspacePath
  if (!(await canResumeSession(pane.agentKey, ws, sessionId))) {
    pipelineLog(`⚠ rebuild ${pane.agentLabel}: session ${sessionId} not resumable`)
    return
  }
  const spec = agentSpecs.find((s) => s.agentKey === pane.agentKey)
  const skipFlag = yoloEnabled.value ? (spec?.skipPermissionFlag ?? '') : ''
  const resumeCmd = buildResumeCommand(pane.agentKey, sessionId, skipFlag)
  if (!resumeCmd) return
  // Snapshot identity before onKill removes the pane from the list.
  const snap = {
    agentKey: pane.agentKey,
    roleKey: pane.roleKey,
    stageId: pane.stageId,
    slotLabel: pane.slotLabel,
    workspacePath: ws,
    origin: pane.origin,
    runGroupId: pane.runGroupId,
    sessionHomeId: pane.sessionHomeId,
  }
  // Preserve layout order: onKill removes the pane and spawnPane appends the
  // replacement to the end, which would jump the rebuilt pane to the last slot.
  // Capture its index and move the replacement back into place after spawn.
  const origIndex = panes.value.findIndex((p) => p.id === paneId)
  await onKill(paneId, { markRemoved: false })
  const newId = await spawnPane({
    agentKey: snap.agentKey,
    roleKey: snap.roleKey,
    stageId: snap.stageId,
    slotLabel: snap.slotLabel,
    commandOverride: resumeCmd,
    workspacePath: snap.workspacePath,
    origin: snap.origin,
    runGroupId: snap.runGroupId || undefined,
    isResume: true,
    skipRoleInjection: true,
    restoreMode: 'memory-resume',
    sessionHomeId: snap.sessionHomeId,
    resumeSessionId: sessionId,
  })
  if (newId && origIndex >= 0) {
    const from = panes.value.findIndex((p) => p.id === newId)
    if (from >= 0 && from !== origIndex) {
      const [moved] = panes.value.splice(from, 1)
      panes.value.splice(origIndex, 0, moved)
    }
  }
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
const showKbPanel = ref(false)
const kbQueryMain = ref('')
const showHistory = ref(false)
const confirmKillAll = ref(false)

// ── Keyboard Shortcuts Panel ──────────────────────────────────────────────────
const MAIN_SHORTCUTS = [
  { label: 'Open Settings',              keys: '⌘,' },
  { label: 'Open Mini IDE',              keys: '⌘⇧I' },
  { label: 'Find in Files',             keys: '⌘⇧F' },
  { label: 'Show Keyboard Shortcuts',   keys: '⌘K ⌘S' },
  { label: 'New Main Window',           keys: '⌘⇧N' },
  { label: 'Toggle AI Chat',            keys: '⌘⇧A / ⌘J' },
  { label: 'Show Explorer',             keys: '⌘⇧E' },
  { label: 'Show Pipeline',             keys: '⌘⇧R' },
  { label: 'Show Source Control',       keys: '⌘⇧G' },
  { label: 'Toggle Sidebar',            keys: '⌘B' },
  { label: 'Sidebar: Explorer Tab',     keys: '⌘1' },
  { label: 'Sidebar: Pipeline Tab',     keys: '⌘2' },
  { label: 'Sidebar: Git Tab',          keys: '⌘3' },
  { label: 'Close Modal / Escape',      keys: 'Esc' },
]
const kbMainItems = computed(() => {
  const q = kbQueryMain.value.toLowerCase()
  return q ? MAIN_SHORTCUTS.filter(s => s.label.toLowerCase().includes(q) || s.keys.toLowerCase().includes(q)) : MAIN_SHORTCUTS
})

// ── Titlebar & Status Bar ─────────────────────────────────────────────────────
const workspaceBaseName = computed(() => {
  if (!currentWorkspace.value) return 'Navide (Agent-Team)'
  const parts = currentWorkspace.value.replace(/\\/g, '/').split('/')
  return parts.filter(Boolean).at(-1) || 'Navide (Agent-Team)'
})

// Reflect the open workspace in the real window title (document.title) so each
// main window is distinguishable in macOS Mission Control / the Dock. Without
// this every main window shows the static index.html <title>. Editor windows
// already set their own document.title.
watch(
  workspaceBaseName,
  (name) => {
    document.title = currentWorkspace.value ? `${name} — Navide (Agent-Team)` : 'Navide (Agent-Team)'
  },
  { immediate: true },
)

interface StatusBarGit {
  branch: string
  ahead: number
  behind: number
  dirty: boolean
}
const statusBarGit = ref<StatusBarGit>({ branch: '', ahead: 0, behind: 0, dirty: false })

async function refreshStatusBarGit(): Promise<void> {
  if (!currentWorkspace.value || !workspaceSelected.value) return
  if (backend.status.value !== 'connected') return
  const resp = await sendQuiet<{
    branch: string; ahead: number; behind: number
    staged: unknown[]; unstaged: unknown[]
  }>('git.status', { workspace_path: currentWorkspace.value })
  if (resp) {
    statusBarGit.value = {
      branch: resp.branch || '',
      ahead: resp.ahead ?? 0,
      behind: resp.behind ?? 0,
      dirty: (resp.staged?.length ?? 0) + (resp.unstaged?.length ?? 0) > 0
    }
  }
}

let _gitPollTimer: number | null = null
watch(workspaceSelected, (v) => {
  if (v) {
    void refreshStatusBarGit()
    _gitPollTimer = window.setInterval(() => void refreshStatusBarGit(), 5000)
  } else {
    if (_gitPollTimer !== null) { clearInterval(_gitPollTimer); _gitPollTimer = null }
    statusBarGit.value = { branch: '', ahead: 0, behind: 0, dirty: false }
  }
}, { immediate: true })

// ── Keybinding system ─────────────────────────────────────────────────────────
useKeybindings()
registerCommand('workbench.action.newWindow', async () => {
  const api = (window as Window & {
    agentTeam?: { openMainWindow?: (args?: { workspace_path?: string }) => Promise<{ ok: boolean }> }
  }).agentTeam
  // Always open a fresh Welcome window — do not inherit the current workspace.
  await api?.openMainWindow?.({})
})
registerCommand('workbench.action.openSettings', () => { showSettings.value = true })
registerCommand('workbench.action.closeModal', () => {
  if (showSettings.value) showSettings.value = false
  else if (showKbPanel.value) showKbPanel.value = false
  else if (showCompletionModal.value) showCompletionModal.value = false
})
registerCommand('workbench.action.openKeyboardShortcuts', () => {
  showKbPanel.value = true
  kbQueryMain.value = ''
})
registerCommand('workbench.action.findInFiles', async () => {
  const api = (window as Window & { agentTeam?: { openEditorWindow?: (args: { workspace_path: string; sidebar: 'search' }) => Promise<{ ok: boolean }> } }).agentTeam
  if (currentWorkspace.value && api?.openEditorWindow) {
    await api.openEditorWindow({ workspace_path: currentWorkspace.value, sidebar: 'search' })
  }
})
registerCommand('workbench.action.openMiniIDE', async () => {
  if (currentWorkspace.value) {
    await window.agentTeam?.openEditorWindow({ workspace_path: currentWorkspace.value })
  }
})
watch([showSettings, showKbPanel, showCompletionModal], ([s, k, c]) => setContext('modalOpen', s || k || c))

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
  session_home_id?: string
  run_group_id?: string  // frontend tab this pane belongs to
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
  session_home_id?: string
  run_group_id?: string
}

// Unified restore record — covers both pipeline slots and manual panes.
interface ProjectPane {
  pane_id: string
  agent: string
  role: string
  command?: string
  session_id?: string
  session_home_id?: string
  spawn_status: string   // 'pending' | 'spawned' | 'removed'
  run_group_id?: string
  origin: 'pipeline' | 'manual'
  stage_id?: string
  stage_index?: number
  slot_label?: string
  kickoff_status?: string
  custom_name?: string
  is_minimized?: boolean
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
    panes?: ProjectPane[]          // unified restore source (pipeline + manual)
    manual_panes?: ProjectManualPane[]  // legacy; kept for migration fallback
    updated_at?: string
    layout_mode?: string
    pipeline_id?: string
    run_count?: number
    theme?: string
    theme_custom?: Record<string, string>
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
  if (agentKey === 'gemini') return /^gemini\s+--session-file\s+\S+/.test(cmd)
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
  // Keep currentWorkspace in sync with the workspace being inspected so that
  // run-group localStorage keys match: _saveRunGroups() keys off currentWorkspace
  // while _loadRunGroups() keys off `path`. If they diverge, a pipeline tab saved
  // under one key is unreadable under the other and silently vanishes on reload.
  currentWorkspace.value = path
  existingProject.value = resp ? buildExistingProjectInfo(resp) : null
  currentMode.value = detectMode(resp)
  applyProjectPaths(resp ?? undefined)
  if (resp?.project) {
    // Adopt the backend theme backup only if localStorage held nothing
    // (load order: localStorage → backend → default). loadTheme() is a no-op
    // for theme when localStorage already wins, so this is safe to call here.
    themeApi.loadTheme({ theme: resp.project.theme, theme_custom: resp.project.theme_custom })
    settingsApi.loadLanguage({ language: (resp.project as { language?: string }).language })
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
    _loadRunGroups(path)
    // Set the active tab BEFORE restoring panes. Without it, tab filtering is
    // inactive (tabFilteredPaneIds falls back to "all panes"), so every tab's
    // panes share one grid (e.g. 7 panes → 3 cols → ~282px). Each agent then
    // resumes hard-wrapped at that narrow width (~34 cols) and the frame stays
    // stuck in scrollback even after the later resize — visible as a pane whose
    // text is much narrower than the cell. Filtering first makes each pane spawn
    // into its final-width grid cell.
    try {
      const key = `agentTeam.activeTab.${path}`
      const saved = localStorage.getItem(key)
      activeTab.value = (saved && stageTabs.value.some((t) => t.key === saved))
        ? saved
        : (stageTabs.value[0]?.key ?? '')
    } catch { activeTab.value = stageTabs.value[0]?.key ?? '' }
    if (suppressPaneRestoreOnce) {
      // First load of a duplicated window: open the same workspace as a clean
      // view without re-resuming the source window's live agent sessions.
      suppressPaneRestoreOnce = false
    } else {
      await restoreWorkspacePanes(resp, path)
    }
    // If the active tab has no panes (e.g. old project.json panes landed in a
    // different group via fallback), switch to the first tab that has panes so
    // the user is not greeted with an empty grid.
    if (activeTab.value && stageTabs.value.length > 0) {
      const paneCountByGroup: Record<string, number> = {}
      for (const p of panes.value) {
        const groupKey = p.runGroupId || 'manual'
        paneCountByGroup[groupKey] = (paneCountByGroup[groupKey] ?? 0) + 1
      }
      const activeHasPanes = (paneCountByGroup[activeTab.value] ?? 0) > 0
      if (!activeHasPanes) {
        const firstFull = stageTabs.value.find((t) => (paneCountByGroup[t.key] ?? 0) > 0)
        if (firstFull) activeTab.value = firstFull.key
      }
    }
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

  // Build unified pane list. Prefer project.panes[] (new format); fall back to
  // migrating stages[].slots[] + manual_panes[] for old project.json files that
  // predate the unified schema.
  let allProjectPanes: ProjectPane[] = payload.project?.panes ?? []
  if (allProjectPanes.length === 0) {
    const stages = payload.project?.stages ?? []
    const fromSlots: ProjectPane[] = stages.flatMap((stage, i) =>
      (stage.slots ?? [])
        .filter((sl) => sl.spawn_status === 'spawned' || sl.spawn_status === 'removed')
        .map((sl) => ({
          pane_id: sl.pane_id ?? '',
          agent: sl.agent,
          role: sl.role,
          session_id: sl.session_id,
          session_home_id: sl.session_home_id,
          spawn_status: sl.spawn_status,
          run_group_id: sl.run_group_id,
          origin: 'pipeline' as const,
          stage_id: stage.stage_id,
          stage_index: i,
          slot_label: sl.label,
          kickoff_status: sl.kickoff_status,
        }))
        .filter((p) => p.pane_id)
    )
    const fromManual: ProjectPane[] = (payload.project?.manual_panes ?? []).map((mp) => ({
      pane_id: mp.pane_id,
      agent: mp.agent,
      role: mp.role,
      command: mp.command,
      session_id: mp.session_id,
      session_home_id: mp.session_home_id,
      spawn_status: mp.spawn_status,
      run_group_id: mp.run_group_id,
      origin: 'manual' as const,
    }))
    allProjectPanes = [...fromSlots, ...fromManual]
  }

  const toRestore = allProjectPanes.filter((p) => p.spawn_status === 'spawned')
  if (toRestore.length === 0) return

  pipelineLog(`↩ Restoring ${toRestore.length} pane(s)`)
  pipeline.workspacePath = workspacePath

  // Lazily create one group to house restored pipeline panes whose saved
  // run_group_id no longer maps to an existing tab (e.g. localStorage cleared
  // while project.json survived, or records predating run_group_id). Created
  // once on first need so we don't spawn an empty tab for manual-only restores.
  // Restored pipeline panes use the saved Pipeline name for the recreated
  // RunGroup tab; task_description stays task content, not a grouping label.
  let _restoreGroupId = ''
  const ensureRestoreGroup = (): string => {
    if (_restoreGroupId) return _restoreGroupId
    _restoreGroupId = runGroups.value[0]?.id
      ?? createRunGroup(pipelineRunGroupName(payload.project?.pipeline_id as string | undefined)).id
    return _restoreGroupId
  }

  await Promise.all(toRestore.map(async (saved) => {
    const sessionId = (saved.session_id ?? '').trim()
    const sessionHomeId = saved.agent === 'codex'
      ? ((saved.session_home_id ?? '').trim() || saved.pane_id)
      : ''
    const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
    const skipFlag = yoloEnabled.value ? (spec?.skipPermissionFlag ?? '') : ''
    // Reuse the saved group only if its tab still exists; otherwise pipeline
    // panes collapse into one restore group, manual panes stay ungrouped (手動).
    const savedGid = saved.run_group_id || ''
    const groupStillExists = !!savedGid && runGroups.value.some((g) => g.id === savedGid)
    const runGroupId = groupStillExists
      ? savedGid
      : (saved.origin === 'pipeline' ? ensureRestoreGroup() : '')

    // Unified session-resume logic for all pane types
    const canResume = await canResumeSession(saved.agent, workspacePath, sessionId)
    const resumeCmd = canResume ? buildResumeCommand(saved.agent, sessionId, skipFlag) : ''
    const fallbackCommand = saved.command && !looksLikeResumeCommand(saved.agent, saved.command)
      ? saved.command : ''
    const commandOverride = resumeCmd || fallbackCommand || ''
    const isResume = !!resumeCmd

    const paneId = await spawnPane({
      agentKey: saved.agent as AgentKey,
      roleKey: saved.role,
      stageId: (saved.stage_id ?? '') as StageId,
      slotLabel: saved.slot_label,
      commandOverride,
      workspacePath,
      origin: saved.origin,
      runGroupId: runGroupId || undefined,
      isResume,
      skipRoleInjection: isResume,
      stageIndex: saved.stage_index ?? -1,
      restoreMode: isResume ? 'memory-resume' : 'fresh',
      sessionHomeId,
      resumeSessionId: sessionId,
    })

    if (!paneId) return

    // Re-apply the user's persisted display name to the restored pane.
    if (saved.custom_name) {
      const restored = panes.value.find((p) => p.id === paneId)
      if (restored) restored.customName = saved.custom_name
    }

    // Re-apply the persisted collapsed-to-sidebar state to the new pane id.
    if (saved.is_minimized) {
      minimizedPanes.value = new Set([...minimizedPanes.value, paneId])
    }

    // Fresh (non-resume) Claude spawns pin a brand-new --session-id; persist
    // it with the record so the next restart can resume the new conversation
    // instead of keeping a stale (or empty) id.
    const newPinnedId = panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? ''

    if (saved.origin === 'pipeline') {
      await sendQuiet('pipeline.slot_spawn', {
        workspace_path: workspacePath,
        stage_index: saved.stage_index,
        slot_label: saved.slot_label,
        pane_id: paneId,
        agent: saved.agent,
        role: saved.role,
        session_id: isResume ? sessionId : (newPinnedId || sessionId),
        session_home_id: sessionHomeId,
        run_group_id: runGroupId,
      })
    } else {
      await sendQuiet<ProjectPayload>('manual_pane.spawn', {
        workspace_path: workspacePath,
        pane_id: paneId,
        previous_pane_id: saved.pane_id,
        agent: saved.agent,
        role: saved.role,
        command: fallbackCommand,
        session_id: isResume ? sessionId : newPinnedId,
        session_home_id: sessionHomeId,
        run_group_id: runGroupId,
      })
      if (sessionId && !isResume && !newPinnedId) {
        await sendQuiet('manual_pane.session', {
          workspace_path: workspacePath,
          pane_id: paneId,
          session_id: '',
        })
      }
    }
  }))

  // Backfill removed manual panes into spawnHistory so Agent History shows past sessions.
  const removedManual = allProjectPanes.filter(
    (p) => p.origin === 'manual' && p.spawn_status === 'removed'
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
      pipelineLog(`📚 injected ${resp.payload.doc_prefix.length} chars (LLM-enhanced)`)
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
      runGroupId: currentRunGroupId.value,
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
        session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
        run_group_id: currentRunGroupId.value,
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
        runGroupId: currentRunGroupId.value,
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
      runGroupId: currentRunGroupId.value,
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
  // Pipeline-created panes are grouped under a RunGroup tab named after the
  // Pipeline itself. Keep this separate from pipeline.task, which is the user's
  // task prompt and should not become a tab/group label.
  createRunGroup(pipelineRunGroupName(payload.pipelineId))
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
    if (pipeline.state !== 'running') return // abort fired during settle
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
  // Show Welcome screen immediately so the button feels responsive.
  // The async cleanup (abort / kill panes) runs after the gate is lifted.
  workspaceSelected.value = false
  currentWorkspace.value = ''
  existingProject.value = null
  currentMode.value = 'spawn'
  // Save path before clearing — the abort API needs it.
  // We don't call onPipelineAbort() here because its trailing onWorkspaceCheck()
  // would re-set currentWorkspace/existingProject that we just cleared.
  const wsPathForAbort = pipeline.workspacePath
  pipeline.workspacePath = ''
  runGroups.value = []
  currentRunGroupId.value = ''
  activeTab.value = ''
  try {
    sessionStorage.removeItem(WS_SELECTED_KEY)
    sessionStorage.removeItem(WS_PATH_KEY)
  } catch {
    /* ignore */
  }
  if (pipeline.state === 'running' && wsPathForAbort) {
    cancelAllWatchers()
    stopGlobalManagerRouter()
    await sendQuiet('pipeline.abort', { workspace_path: wsPathForAbort, reason: 'user' })
  }
  await onPipelineReset()
}

// Titlebar 📁 button: open the current workspace folder in Finder.
async function titlebarRevealWorkspace(): Promise<void> {
  if (!currentWorkspace.value || !window.agentTeam?.openPath) return
  await window.agentTeam.openPath(currentWorkspace.value)
}

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

// ── Background system notifications (CLI done / needs input) ─────────────────
// Native OS notification when a pane's turn completes or it needs the user's
// input — fired ONLY when the app is backgrounded (see useSystemNotify). This is
// purely additive: it reads the same agent.activity signals as the pipeline
// logic without altering paneTurnCompleteAt / paneLastActiveAt handling.
const sysNotify = useSystemNotify()

// Per-pane timer that fires a 'done' notification once turn_complete has stayed
// the latest signal for TURN_COMPLETE_SETTLE_MS — mirroring turnCompleteDone so
// a turn that ended to ask a QUESTION isn't mis-notified as completion.
const paneDoneNotifyTimers = new Map<string, number>()

function paneNotifyLabel(pane: { customName?: string; slotLabel?: string; agentLabel?: string }): string {
  return pane.customName || pane.slotLabel || pane.agentLabel || ''
}

function clearDoneNotifyTimer(paneId: string): void {
  const h = paneDoneNotifyTimers.get(paneId)
  if (h != null) { window.clearTimeout(h); paneDoneNotifyTimers.delete(paneId) }
}

function scheduleDoneNotify(paneId: string): void {
  clearDoneNotifyTimer(paneId)
  const h = window.setTimeout(() => {
    paneDoneNotifyTimers.delete(paneId)
    const tc = paneTurnCompleteAt.get(paneId) ?? 0
    const la = paneLastActiveAt.get(paneId) ?? 0
    // Still finished? Suppress if the CLI went active again after turn_complete
    // (e.g. a question arrived as hook:notification, or it resumed working).
    if (tc <= 0 || la > tc) return
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane) return
    playDoneSound()
    sysNotify.notifyPaneState(
      paneId,
      'done',
      i18n.global.t('notify.done-title'),
      i18n.global.t('notify.done-body', { label: paneNotifyLabel(pane) })
    )
  }, TURN_COMPLETE_SETTLE_MS)
  paneDoneNotifyTimers.set(paneId, h)
}

function notifyAttention(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  playAttentionSound()
  sysNotify.notifyPaneState(
    paneId,
    'attention',
    i18n.global.t('notify.attention-title'),
    i18n.global.t('notify.attention-body', { label: paneNotifyLabel(pane) })
  )
}

// CLI lifecycle events (the reliable, non-buffer signal). agent_active = the CLI
// is working; turn_complete = its turn ended. We timestamp both per pane; the
// completion logic reads these instead of guessing from the TUI buffer.
backend.on('agent.activity', (raw) => {
  const ev = raw as { event_type?: string; pane_id?: string; vendor?: string; session_id?: string; detail?: string }
  if (!ev?.pane_id) return
  if (ev.event_type === 'turn_complete') {
    paneTurnCompleteAt.set(ev.pane_id, Date.now())
    scheduleDoneNotify(ev.pane_id)
  } else if (ev.event_type === 'agent_active') {
    paneLastActiveAt.set(ev.pane_id, Date.now())
    // A new turn re-arms 'done' notifications for this pane.
    sysNotify.markActive(ev.pane_id)
    // Claude's Notification hook (user attention requested, e.g. permission
    // prompt) arrives as agent_active with detail 'hook:notification'.
    if (ev.detail === 'hook:notification') notifyAttention(ev.pane_id)
    // Clear the restore-mode badge once the user interacts with the pane.
    const histEntry = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
    if (histEntry?.restoreMode) histEntry.restoreMode = undefined
  }
  if (ev.vendor === 'claude' && ev.session_id) {
    const pane = panes.value.find((p) => p.id === ev.pane_id)
    // Attribution can mis-route an unowned session to a sibling pane in the
    // same cwd — never let that overwrite a pane that already pinned a
    // different id, or the pane's persisted resume id is lost for good.
    const accepts = !pane?.pinnedSessionId || pane.pinnedSessionId === ev.session_id
    if (pane?.origin === 'manual' && accepts) {
      pane.pinnedSessionId = ev.session_id
      syncViews()
      void persistPaneSession(pane, ev.session_id)
      const h = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
      if (h) h.sessionId = ev.session_id
    }
  }
})

// Codex/Gemini sessions are persisted after the backend observes their session
// files: Gemini announces the durable session-file path from its explicit
// --session-id owner, while Codex announces the resume id from its per-pane
// CODEX_HOME path. Marker matching remains a fallback for older sessions.
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
const _managerScanRunning = new Set<number>()

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
// A buffer-detected question (Codex/Gemini, or any stage pane with allowQuestions)
// surfaces here — fire an 'attention' notification so a backgrounded user is
// pulled back. Claude's questions arrive earlier via the hook:notification path;
// markActive (new turn) re-arms the pane so this isn't suppressed as a dup.
watch(() => activeQuestion.value?.paneId, (paneId) => {
  if (paneId) notifyAttention(paneId)
})
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
  if (_managerScanRunning.has(stageIndex)) return
  if (stageIndex !== pipeline.stageIndex || pipeline.state !== 'running') return
  const router = stageRouters.get(stageIndex)
  const stage = stagesApi.stages.value[stageIndex]
  if (!router || !stage || router.finished) return
  _managerScanRunning.add(stageIndex)
  try {

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
  } finally {
    _managerScanRunning.delete(stageIndex)
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
let _globalScanRunning = false

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
  if (_globalScanRunning) return
  if (pipeline.state !== 'running') return
  _globalScanRunning = true
  try {
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
  } finally {
    _globalScanRunning = false
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

// ── Agent Run Group Tab Bar ───────────────────────────────────────────────────
// Naming guide for this area:
//   Pipeline = the configured workflow template/run selected in the left panel.
//   Pane     = one live terminal session running Claude Code / Codex / Gemini.
//   RunGroup = a frontend grouping bucket for panes; rendered to the user as a tab.
//   Tab      = the visible UI affordance for selecting one RunGroup.
//
// Rule: when panes are created by a Pipeline run, their RunGroup tab name should
// be the Pipeline name. Ad-hoc groups created by the + button may use "Run N".
// Manual panes without any group appear in the special "手動" tab.

const runGroups = ref<RunGroup[]>([])
const currentRunGroupId = ref<string>('')  // ID assigned to newly spawned pipeline panes
const activeTab = ref<string>('')

function _runGroupsKey(): string {
  return currentWorkspace.value ? `agentTeam.runGroups.${currentWorkspace.value}` : ''
}

function _saveRunGroups(): void {
  try {
    const key = _runGroupsKey()
    if (key) localStorage.setItem(key, JSON.stringify(runGroups.value))
  } catch { /* ignore */ }
}

/** Fixed id for the always-present default tab. Using a constant id (rather than
 *  a timestamp) makes "預設" idempotent: it can exist at most once per workspace,
 *  so reloads/re-checks never spawn a duplicate. */
const DEFAULT_RUN_GROUP_ID = 'rg-default'

function _loadRunGroups(path: string): void {
  let hadStoredRunGroups = false
  try {
    const raw = localStorage.getItem(`agentTeam.runGroups.${path}`)
    hadStoredRunGroups = raw !== null
    runGroups.value = raw ? (JSON.parse(raw) as RunGroup[]) : []
  } catch { runGroups.value = [] }
  // Open with exactly one default tab. Only created when no group exists at all,
  // and with a fixed id → never duplicated. Each pipeline run still adds its own
  // tab via createRunGroup; the default acts as the catch-all / landing tab. If
  // localStorage explicitly contains [], the user deleted the default RunGroup,
  // so do not recreate it on reload.
  if (!hadStoredRunGroups && runGroups.value.length === 0) {
    runGroups.value = [{ id: DEFAULT_RUN_GROUP_ID, name: '預設', createdAt: Date.now() }]
    try { localStorage.setItem(`agentTeam.runGroups.${path}`, JSON.stringify(runGroups.value)) } catch { /* ignore */ }
  }
  currentRunGroupId.value = runGroups.value[runGroups.value.length - 1]?.id ?? ''
}

function createRunGroup(name?: string): RunGroup {
  const id = `rg-${Date.now()}`
  const group: RunGroup = {
    id,
    name: name ?? `Run ${runGroups.value.length + 1}`,
    createdAt: Date.now(),
  }
  runGroups.value = [...runGroups.value, group]
  currentRunGroupId.value = id
  activeTab.value = id
  _saveRunGroups()
  return group
}

function renameRunGroup(id: string, name: string): void {
  runGroups.value = runGroups.value.map((g) => (g.id === id ? { ...g, name } : g))
  _saveRunGroups()
}

function pipelineRunGroupName(pipelineId?: string): string {
  const id = pipelineId || pipelinesApi.activePipelineId.value
  const byId = pipelinesApi.pipelines.value.find((p) => p.id === id)?.name.trim()
  const active = pipelinesApi.activePipeline.value?.name.trim()
  return byId || active || 'Pipeline'
}

/** Persist a pane's run-group reassignment to project.json (survives restart). */
async function persistPaneRunGroup(pane: ActivePane, runGroupId: string): Promise<void> {
  const ws = pane.workspacePath || currentWorkspace.value
  if (!ws) return
  await sendQuiet('pane.set_run_group', {
    workspace_path: ws,
    pane_id: pane.id,
    run_group_id: runGroupId,
  })
}

/** Move one pane into another tab (drag-and-drop target). The "manual" tab maps
 *  to an empty run group (ungrouped). */
async function movePaneToGroup(paneId: string, targetKey: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const targetGroupId = targetKey === 'manual' ? '' : targetKey
  if ((pane.runGroupId ?? '') === targetGroupId) return
  pane.runGroupId = targetGroupId || undefined
  await persistPaneRunGroup(pane, targetGroupId)
}

/** Delete a RunGroup tab.
 *
 *  Important: "手動" is not a persisted RunGroup. It is a synthetic tab for
 *  panes whose runGroupId is empty. Therefore deleting the last real RunGroup is
 *  valid when there is, or will be, a manual/ungrouped tab to show those panes.
 */
async function closeRunGroup(id: string): Promise<void> {
  const affected = id === 'manual'
    ? panes.value.filter((p) => !p.runGroupId)
    : panes.value.filter((p) => p.runGroupId === id)
  for (const p of [...affected]) await onKill(p.id)
  if (id !== 'manual') {
    runGroups.value = runGroups.value.filter((g) => g.id !== id)
    if (currentRunGroupId.value === id) currentRunGroupId.value = ''
    if (activeTab.value === id) activeTab.value = runGroups.value[0]?.id ?? 'manual'
    _saveRunGroups()
  }
}

async function deleteRunGroup(id: string): Promise<void> {
  // 刪除「手動」tab：把未指派 pane 移到第一個 stage group
  if (id === 'manual') {
    if (stageTabs.value.length <= 1) return  // only the manual tab left — nothing to do
    const target = runGroups.value[0]
    if (!target) return
    const affected = panes.value.filter((p) => !p.runGroupId)
    await Promise.all(affected.map((p) => {
      p.runGroupId = target.id
      return persistPaneRunGroup(p, target.id)
    }))
    if (activeTab.value === 'manual') activeTab.value = target.id
    return
  }
  const target = runGroups.value.find((g) => g.id !== id)
  const affected = panes.value.filter((p) => p.runGroupId === id)

  if (!target) {
    await Promise.all(affected.map((p) => {
      p.runGroupId = undefined
      return persistPaneRunGroup(p, '')
    }))
    runGroups.value = runGroups.value.filter((g) => g.id !== id)
    if (currentRunGroupId.value === id) currentRunGroupId.value = ''
    if (activeTab.value === id) activeTab.value = 'manual'
    _saveRunGroups()
    return
  }

  await Promise.all(affected.map((p) => {
    p.runGroupId = target.id
    return persistPaneRunGroup(p, target.id)
  }))
  runGroups.value = runGroups.value.filter((g) => g.id !== id)
  if (currentRunGroupId.value === id) currentRunGroupId.value = target.id
  if (activeTab.value === id) activeTab.value = target.id
  _saveRunGroups()
}

const stageTabs = computed<TabItem[]>(() => {
  // Count panes per persisted RunGroup; panes without runGroupId are surfaced
  // through the synthetic "手動" tab, even when no real RunGroup remains.
  const groupCounts: Record<string, number> = {}
  let unassignedCount = 0
  for (const p of panes.value) {
    if (p.runGroupId) {
      groupCounts[p.runGroupId] = (groupCounts[p.runGroupId] ?? 0) + 1
    } else {
      unassignedCount++
    }
  }

  const tabs: TabItem[] = []
  for (const group of runGroups.value) {
    tabs.push({ key: group.id, label: group.name, count: groupCounts[group.id] ?? 0, type: 'stage' })
  }
  if (unassignedCount > 0) {
    tabs.push({ key: 'manual', label: '手動', count: unassignedCount, type: 'manual' })
  }
  return tabs
})

const tabFilteredPaneIds = computed<Set<string>>(() => {
  if (stageTabs.value.length === 0) {
    return new Set(panes.value.map((p) => p.id))
  }
  if (activeTab.value === 'manual') {
    return new Set(panes.value.filter((p) => !p.runGroupId).map((p) => p.id))
  }
  if (activeTab.value && runGroups.value.some((g) => g.id === activeTab.value)) {
    return new Set(panes.value.filter((p) => p.runGroupId === activeTab.value).map((p) => p.id))
  }
  // Fallback: show all
  return new Set(panes.value.map((p) => p.id))
})

// Panes visible under both tab filter and minimize filter — drives grid sizing
const tabVisiblePanes = computed(() =>
  panes.value.filter((p) => tabFilteredPaneIds.value.has(p.id) && !minimizedPanes.value.has(p.id))
)

// Persist activeTab to localStorage keyed by workspace path
const activeTabStorageKey = computed(() =>
  currentWorkspace.value ? `agentTeam.activeTab.${currentWorkspace.value}` : ''
)
watch(activeTab, (v) => {
  try {
    if (activeTabStorageKey.value) localStorage.setItem(activeTabStorageKey.value, v)
  } catch { /* ignore */ }
  // Keep currentRunGroupId in sync with the active tab so that "+ Add to grid"
  // always spawns into whichever tab the user is currently viewing.
  if (v && v !== 'manual' && runGroups.value.some((g) => g.id === v)) {
    currentRunGroupId.value = v
  }
})

function minimizePane(id: string): void {
  minimizedPanes.value = new Set([...minimizedPanes.value, id])
  if (focusPaneId.value === id) {
    focusPaneId.value = panes.value.find((p) => p.id !== id && !minimizedPanes.value.has(p.id))?.id ?? null
  }
  persistPaneMinimized(id, true)
  syncViews()
}

function restorePane(id: string): void {
  const next = new Set(minimizedPanes.value)
  next.delete(id)
  minimizedPanes.value = next
  if (layoutMode.value !== 'grid') focusPaneId.value = id
  persistPaneMinimized(id, false)
  syncViews()
}

// Persist the pane's collapsed-to-sidebar state to project.json so it survives
// a restart (mirrors project.rename_pane / custom_name).
function persistPaneMinimized(id: string, isMinimized: boolean): void {
  const pane = panes.value.find((p) => p.id === id)
  if (!pane) return
  backend.send('project.set_pane_minimized', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    is_minimized: isMinimized,
  })
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
  // If the current tab's run group was removed, fall back to first available group
  if (activeTab.value && stageTabs.value.length > 0) {
    const tabStillExists = stageTabs.value.some((t) => t.key === activeTab.value)
    if (!tabStillExists) activeTab.value = stageTabs.value[0]?.key ?? ''
  }
})

// When switching tabs, ensure focusPaneId is within the new tab's visible panes
watch(activeTab, () => {
  const visible = tabVisiblePanes.value
  if (focusPaneId.value && !visible.some((p) => p.id === focusPaneId.value)) {
    focusPaneId.value = visible[0]?.id ?? null
  }
  void nextTick(() => refitAllTerminals())
})

function onSetFocus(paneId: string): void {
  focusPaneId.value = paneId
}

// Pane right-click context menu, shared by the agent list, spotlight thumbnails,
// and pane headers. The menu is rendered once in this component; each surface only
// raises an open request with the pane id and pointer coords.
const paneCtxMenu = ref<{ paneId: string; x: number; y: number } | null>(null)
const paneCtxMenuEl = ref<HTMLElement | null>(null)

const paneCtxView = computed<ActivePaneView | null>(() =>
  paneCtxMenu.value ? paneViews.value.find((v) => v.id === paneCtxMenu.value!.paneId) ?? null : null
)

function openPaneCtxMenu(e: MouseEvent, paneId: string): void {
  e.preventDefault()
  paneCtxMenu.value = { paneId, x: e.clientX, y: e.clientY }
  // Flip/clamp into the viewport once the menu has rendered, so items near the
  // bottom/right edge aren't clipped by the window.
  void nextTick(() => {
    const el = paneCtxMenuEl.value
    const m = paneCtxMenu.value
    if (!el || !m) return
    const r = el.getBoundingClientRect()
    const margin = 8
    if (m.y + r.height > window.innerHeight) {
      m.y = Math.max(margin, window.innerHeight - r.height - margin)
    }
    if (m.x + r.width > window.innerWidth) {
      m.x = Math.max(margin, window.innerWidth - r.width - margin)
    }
  })
}

function closePaneCtxMenu(): void {
  paneCtxMenu.value = null
}

// Rename dialog state. Opened from the context menu; on confirm it overrides the
// pane's display label and persists it to project.json via project.rename_pane.
const renamingPane = ref<{ paneId: string; value: string } | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)

function startRenamePane(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  renamingPane.value = { paneId, value: pane.customName || pane.agentLabel }
  closePaneCtxMenu()
  void nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}

// Applies a custom display name to a pane and persists it. Shared by the
// context-menu rename dialog and the inline (double-click) header edit.
function setPaneCustomName(paneId: string, rawName: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const name = rawName.trim()
  // Empty name resets to the default label.
  pane.customName = name && name !== pane.agentLabel ? name : undefined
  syncViews()
  backend.send('project.rename_pane', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    custom_name: pane.customName ?? '',
  })
}

function confirmRenamePane(): void {
  const r = renamingPane.value
  if (!r) return
  setPaneCustomName(r.paneId, r.value)
  renamingPane.value = null
}

watch(layoutMode, (mode) => {
  const wp = pipeline.workspacePath
  if (wp) {
    backend.send('project.set_layout_mode', { workspace_path: wp, layout_mode: mode })
  }
}, { immediate: true })

const effectiveLayoutMode = computed<'grid' | 'spotlight' | 'sidebar' | 'fullscreen'>(() => {
  if (tabVisiblePanes.value.length <= 1) return 'grid'
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
      requestAnimationFrame(() => {
        for (const ref of Object.values(paneRefs)) {
          (ref as unknown as { fitTerminal?: () => void })?.fitTerminal?.()
        }
      })
    })
  })
})

// Tab switches and minimize/restore move panes through display:none the same
// way layout mode changes do — refit so a pane that spawned or resized while
// hidden doesn't keep rendering at a stale width (corrupted TUI layout).
watch([activeTab, minimizedPanes], () => refitAllTerminals())

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
  return Math.max(1, tabVisiblePanes.value.length - 1)
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
  const n = tabVisiblePanes.value.length
  if (n <= 1) return 1
  if (n <= 4) return 2
  return 3
})
const numRows = computed(() => Math.max(1, Math.ceil(tabVisiblePanes.value.length / numCols.value)))

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
  refitAllTerminals()
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
const buildTag = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev'

// Backend supervisor popover (status bar pill → manage/restart/stop the backend).
const backendPanelOpen = ref(false)
const backendBusy = ref(false)
async function onRestartBackend(): Promise<void> {
  if (backendBusy.value) return
  backendBusy.value = true
  try { await backend.restart() } finally { backendBusy.value = false }
}
async function onStopBackend(): Promise<void> {
  if (backendBusy.value) return
  backendBusy.value = true
  try { await backend.stop() } finally { backendBusy.value = false }
}

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
  const preparationLabel = panePreparationLabel(p)
  if (p.origin !== 'pipeline' && !p.stageId) return `${roleLabel(p.roleKey)} · ${i18n.global.t('label.manual')} · ${preparationLabel}`
  const stage = stagesApi.stageById.value[p.stageId] ?? { shortTitle: p.stageId }
  const prefix = p.origin === 'pipeline' ? `P${p.stageId} · ` : ''
  const stageLabel = stage.shortTitle || i18n.global.t('label.manual')
  return `${prefix}${roleLabel(p.roleKey)} · ${stageLabel} · ${preparationLabel}`
}

function panePreparationLabel(p: ActivePane): string {
  switch (p.preparationStatus) {
    case 'starting':
      return i18n.global.t('pane.prep.starting')
    case 'checking-dialog':
      return i18n.global.t('pane.prep.checking-dialog')
    case 'settling':
      return i18n.global.t('pane.prep.settling')
    case 'injecting-role':
      return i18n.global.t('pane.prep.injecting-role')
    case 'waiting-agent':
      return i18n.global.t('pane.prep.waiting-agent')
    case 'ready':
      return i18n.global.t('pane.prep.ready')
    case 'failed':
      return i18n.global.t('pane.prep.failed')
  }
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
  <!-- First-run environment wizard: hard-blocks the shell until complete. -->
  <OnboardingWizard
    v-if="onboardingComplete === false"
    :backend="backend"
    @complete="onboardingComplete = true"
  />
  <!-- First-boot loading overlay: covers the shell until the backend settles,
       then fades out. Brand-only text so no i18n keys are needed. -->
  <Transition name="boot-fade">
    <div v-if="booting" class="boot-overlay">
      <div class="boot-card">
        <div class="boot-wordmark">Agent-Team</div>
        <template v-if="bootError">
          <div class="boot-status boot-status-error">{{ $t('error.backend-start-failed') }}</div>
          <button class="boot-retry" @click="retryBackend">{{ $t('action.retry') }}</button>
        </template>
        <template v-else>
          <div class="boot-spinner" aria-label="loading" />
          <div class="boot-status">{{ $t(bootStatusKey) }}</div>
        </template>
      </div>
    </div>
  </Transition>
  <div class="app" :style="{ '--token-panel-width': tokenPanelWidth, '--left-width': leftPanelWidth + 'px' }" :class="{ 'is-resizing': isDragging }">
    <!-- Custom titlebar: traffic lights on left (via hiddenInset), name centre, gear right -->
    <div class="titlebar">
      <template v-if="workspaceSelected">
        <div class="titlebar-workspace">
          <input
            :value="currentWorkspace"
            type="text"
            class="titlebar-ws-input"
            spellcheck="false"
            autocorrect="off"
            @change="onWorkspaceBrowse(($event.target as HTMLInputElement).value)"
          />
          <button class="titlebar-ws-btn" @mousedown.stop @click="titlebarRevealWorkspace" :title="$t('action.open-in-finder')">📁</button>
          <button class="titlebar-ws-btn" @mousedown.stop @click="onSwitchWorkspace" :title="$t('action.switch-workspace')">↺</button>
        </div>
      </template>
      <span v-else class="titlebar-name">{{ workspaceBaseName }}</span>
      <button class="titlebar-gear" @mousedown.stop @click="showSettings = true" title="Settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
    <ControlPane
      ref="controlPaneRef"
      :backend-status="backend.status.value"
      :backend-url="backendUrl"
      :agent-specs="agentSpecs"
      :roles="rolesApi.roles.value"
      :stages="stagesApi.stages.value"
      :panes="paneViews.filter(v => tabFilteredPaneIds.has(v.id))"
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
      :spawn-history="spawnHistory"
      :focus-pane-id="effectiveFocusPaneId ?? undefined"
      @spawn="onManualSpawn"
      @spawn-resume="onManualResume"
      @kill="onKill"
      @interrupt="onInterrupt"
      @kill-all="onKillAll"
      @reinject="onReinject"
      @restore="restorePane"
      @context-menu="(id, ev) => openPaneCtxMenu(ev, id)"
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
      @dispatch-issue="onDispatchIssue"
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
      @reopen-onboarding="() => { showSettings = false; reopenOnboarding() }"
    />
    <div v-if="showKbPanel" class="kb-overlay" @mousedown.self="showKbPanel = false">
      <div class="kb-panel">
        <div class="kb-panel-header">
          <span class="kb-panel-title">Keyboard Shortcuts</span>
          <button class="kb-panel-close" @click="showKbPanel = false">✕</button>
        </div>
        <input
          v-model="kbQueryMain"
          class="kb-panel-search"
          placeholder="Search shortcuts…"
          autofocus
          @keydown.esc.stop="showKbPanel = false"
        />
        <ul class="kb-panel-list">
          <li v-for="s in kbMainItems" :key="s.label" class="kb-panel-item">
            <span class="kb-panel-label">{{ s.label }}</span>
            <span class="kb-panel-key">{{ s.keys }}</span>
          </li>
        </ul>
      </div>
    </div>
    <Teleport v-if="showHistory" to="body">
      <div class="history-overlay" @click.self="showHistory = false">
        <div class="history-modal">
          <div class="history-modal-header">
            <div class="history-header-left">
              <span>{{ $t('label.agent-history') }}</span>
              <button
                v-if="panes.length > 0"
                class="history-killall"
                @click="confirmKillAll = true"
                :title="$t('action.kill-all-agents')"
              >🗑 {{ $t('action.kill-all') }}</button>
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
                <span
                  v-if="entry.restoreMode === 'memory-resume'"
                  class="ah-restore-badge ah-resume"
                  title="以 CLI resume 指令載入記憶"
                >記憶恢復</span>
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
          <div style="padding: 16px 14px; font-size: 13px; color: var(--text-primary);">
            這將強制終止 <strong>{{ panes.length }} 個 agent</strong>，所有進行中的工作將遺失。
          </div>
          <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
            <button class="history-close" style="border: 1px solid var(--border-default); padding: 4px 12px; border-radius: 6px;" @click="confirmKillAll = false">{{ $t('action.cancel') }}</button>
            <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="() => { onKillAll(); confirmKillAll = false }">{{ $t('action.kill-all') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
    <main
      class="stage"
      :class="{ 'stage--tabbed': stageTabs.length > 0 }"
      :data-layout="effectiveLayoutMode"
    >
      <StageTabBar
        v-if="stageTabs.length > 0"
        :tabs="stageTabs"
        v-model="activeTab"
        @add="createRunGroup()"
        @rename="(key, name) => renameRunGroup(key, name)"
        @delete="(key) => deleteRunGroup(key)"
        @close-group="(key) => closeRunGroup(key)"
        @move-pane="(paneId, targetKey) => movePaneToGroup(paneId, targetKey)"
      />
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
          <h2>{{ $t('label.two-ways-title') }}</h2>
          <p>
            <strong>▶ {{ $t('action.run-pipeline') }}</strong> {{ $t('label.two-ways-pipeline', { count: stagesApi.stages.value.length }) }}
          </p>
          <p>
            <strong>{{ $t('action.add-to-grid') }}</strong> {{ $t('label.two-ways-grid') }}
          </p>
          <p class="muted">{{ $t('label.set-workspace-pipeline') }}</p>
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
          v-show="tabFilteredPaneIds.has(p.id) && !minimizedPanes.has(p.id) && !(effectiveLayoutMode === 'sidebar' && p.id !== effectiveFocusPaneId && p.id !== dualFocusSecondaryId) && !(effectiveLayoutMode === 'spotlight' && p.id !== effectiveFocusPaneId && p.id !== dualFocusSecondaryId)"
          :style="{ ...floatPaneStyle(p.id), ...dualFocusStyle(p.id) }"
          :ref="(el) => setPaneRef(p.id, el)"
          :data-pane-id="p.id"
          :pane-id="p.id"
          :title="p.customName || p.agentLabel"
          :subtitle="paneSubtitle(p)"
          :pipe-tag="p.origin === 'pipeline' && p.stageId ? `P${p.stageId}` : undefined"
          :is-commander="paneIsCommander(p)"
          :is-focus="p.id === effectiveFocusPaneId"
          :can-rebuild="!!p.pinnedSessionId && ['claude', 'codex', 'gemini', 'antigravity'].includes(p.agentKey)"
          :backend="backend"
          @set-focus="onSetFocus(p.id)"
          @minimize="minimizePane(p.id)"
          @rebuild="rebuildPaneViaResume(p.id)"
          @rename="(name) => setPaneCustomName(p.id, name)"
          @context-menu="(ev) => openPaneCtxMenu(ev, p.id)"
        />
        <!-- Auto/sidebar mode: meeting-style agent list on the right -->
        <div v-if="effectiveLayoutMode === 'sidebar'" class="auto-meeting-list" :style="dualFocusActive ? { gridColumn: '3' } : {}">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId }"
            @click="onSetFocus(p.id)"
            @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
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
          <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="meeting-empty">
            只有一個 agent
          </div>
        </div>
      </div>
      <!-- Spotlight mode: horizontal scrollable bottom strip -->
      <div v-if="effectiveLayoutMode === 'spotlight'" class="spotlight-strip">
        <div
          v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
          :key="p.id"
          class="spotlight-thumb"
          :class="{ 'spotlight-thumb--active': p.id === effectiveFocusPaneId }"
          @click="onSetFocus(p.id)"
          @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
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
        <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="spotlight-strip-empty">
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
            Agents ({{ paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length }})
          </span>
          <button class="float-pip-toggle" @mousedown.stop @click="floatPipExpanded = !floatPipExpanded; clampPipPos()">
            {{ floatPipExpanded ? '▾' : '▸' }}
          </button>
        </div>
        <div v-if="floatPipExpanded" class="float-pip-list" :style="{ maxHeight: floatPipListMaxHeight + 'px' }">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId }"
            @click="onSetFocus(p.id)"
            @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
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
          <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="meeting-empty">
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
            <button class="stall-btn primary" @click="confirmCloseWorkspace = false">{{ $t('action.cancel') }}</button>
            <button class="stall-btn danger" @click="doCloseWorkspace">{{ $t('action.abort-and-switch') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <!-- Pane right-click context menu (shared by agent list, spotlight thumbs, pane headers) -->
    <Teleport v-if="paneCtxMenu" to="body">
      <div class="pane-ctx-backdrop" @mousedown="closePaneCtxMenu" @contextmenu.prevent="closePaneCtxMenu" />
      <div ref="paneCtxMenuEl" class="pane-ctx" :style="{ left: paneCtxMenu.x + 'px', top: paneCtxMenu.y + 'px' }" @click.stop @mousedown.stop>
        <div class="pane-ctx-item" @click="onSetFocus(paneCtxMenu!.paneId); closePaneCtxMenu()">{{ $t('action.focus') }}</div>
        <div
          v-if="paneCtxView?.isMinimized"
          class="pane-ctx-item"
          @click="restorePane(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.restore') }}</div>
        <div class="pane-ctx-item" @click="startRenamePane(paneCtxMenu!.paneId)">{{ $t('action.rename') }}</div>
        <div class="pane-ctx-sep"></div>
        <div
          class="pane-ctx-item"
          :class="{ disabled: paneCtxView?.status !== 'running' }"
          @click="onInterrupt(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.interrupt') }}</div>
        <div
          class="pane-ctx-item"
          :class="{ disabled: paneCtxView?.status !== 'running' || !paneCtxView?.roleKey }"
          @click="onReinject(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.reapply-role') }}</div>
        <div class="pane-ctx-sep"></div>
        <div class="pane-ctx-item danger" @click="onKill(paneCtxMenu!.paneId); closePaneCtxMenu()">{{ $t('action.remove') }}</div>
      </div>
    </Teleport>
    <!-- Pane rename dialog -->
    <Teleport v-if="renamingPane" to="body">
      <div class="stall-overlay" @click.self="renamingPane = null">
        <div class="stall-card pane-rename-card">
          <header>
            <strong>{{ $t('action.rename') }}</strong>
          </header>
          <div class="stall-body">
            <input
              ref="renameInput"
              v-model="renamingPane.value"
              class="pane-rename-input"
              type="text"
              @keydown.enter="confirmRenamePane"
              @keydown.esc="renamingPane = null"
            />
          </div>
          <footer>
            <button class="stall-btn" @click="renamingPane = null">{{ $t('action.cancel') }}</button>
            <button class="stall-btn primary" @click="confirmRenamePane">{{ $t('action.rename') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <div class="resize-handle resize-handle-left" @mousedown="onResizeStart($event, 'left')" />
    <div v-if="tokenPanelExpanded" class="resize-handle resize-handle-right" @mousedown="onResizeStart($event, 'right')" />
    <NotificationHost />
    <!-- Status bar -->
    <div class="statusbar">
      <div class="statusbar-left">
        <span v-if="statusBarGit.branch" class="sb-item sb-git">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
          </svg>
          {{ statusBarGit.branch }}{{ statusBarGit.dirty ? '*' : '' }}
        </span>
        <span v-if="statusBarGit.behind > 0 || statusBarGit.ahead > 0" class="sb-item sb-sync">
          <span v-if="statusBarGit.behind > 0">{{ statusBarGit.behind }}↓</span>
          <span v-if="statusBarGit.ahead > 0"> {{ statusBarGit.ahead }}↑</span>
        </span>
        <span
          class="sb-item sb-backend sb-clickable"
          :class="'sb-' + backend.status.value"
          role="button"
          tabindex="0"
          @click="backendPanelOpen = !backendPanelOpen"
          @keydown.enter="backendPanelOpen = !backendPanelOpen"
        >
          <span class="sb-dot" />
          {{ backend.status.value === 'connected' ? 'backend' : 'connecting…' }}
          <span v-if="backendUrl" class="sb-url">· {{ backendUrl }}</span>
        </span>
      </div>
      <div class="statusbar-right">
        <span v-if="pipeline.state !== 'idle'" class="sb-item sb-pipeline" :class="'sb-' + pipeline.state">
          {{ pipeline.state === 'running'
            ? `Stage ${pipeline.stageIndex + 1} / ${stagesApi.stages.value.length || '?'}`
            : pipeline.state }}
        </span>
        <span v-if="panes.length > 0" class="sb-item sb-agents">
          {{ panes.length }} agent{{ panes.length !== 1 ? 's' : '' }}
        </span>
        <span class="sb-item sb-build">{{ buildTag }}</span>
      </div>
    </div>

    <!-- Backend supervisor popover -->
    <div v-if="backendPanelOpen" class="bp-backdrop" @click="backendPanelOpen = false" />
    <div v-if="backendPanelOpen" class="bp-pop" @click.stop>
      <div class="bp-head">
        <span class="bp-dot sb-backend" :class="'sb-' + backend.status.value" />
        <span class="bp-title">Backend</span>
        <span class="bp-state" :class="'sb-' + backend.status.value">{{ backend.status.value }}</span>
      </div>
      <div class="bp-rows">
        <div class="bp-row"><span class="bp-k">URL</span><span class="bp-v">{{ backendUrl || '—' }}</span></div>
        <div class="bp-row"><span class="bp-k">PID</span><span class="bp-v">{{ backend.pid.value || '—' }}</span></div>
      </div>
      <div class="bp-actions">
        <button class="bp-btn bp-restart" :disabled="backendBusy" @click="onRestartBackend">
          {{ backendBusy ? 'working…' : (backend.status.value === 'connected' ? 'Restart' : 'Start') }}
        </button>
        <button
          class="bp-btn bp-stop"
          :disabled="backendBusy || backend.status.value !== 'connected'"
          @click="onStopBackend"
        >Stop</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* First-boot loading overlay */
.boot-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
}
.boot-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.boot-wordmark {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-primary);
}
.boot-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid var(--border-muted);
  border-top-color: var(--accent-bright);
  border-radius: 50%;
  animation: boot-spin 0.8s linear infinite;
}
.boot-status {
  font-size: 12px;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}
.boot-status-error {
  color: var(--danger-fg);
}
.boot-retry {
  font-size: 12px;
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
}
.boot-retry:hover {
  background: var(--bg-elevated);
}
@keyframes boot-spin {
  to { transform: rotate(360deg); }
}
/* Fade the overlay out (no enter transition — it's there from first paint). */
.boot-fade-leave-active { transition: opacity 0.3s ease; }
.boot-fade-leave-to { opacity: 0; }

.app {
  display: grid;
  /* Three columns: controls · terminal grid · token stats panel
     Both left and token-panel widths are driven by CSS vars set inline. */
  grid-template-columns: var(--left-width, 360px) 1fr var(--token-panel-width, 36px);
  position: relative;
  height: 100vh;
  background: var(--bg-inset);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  overflow: hidden;
  box-sizing: border-box;
  padding-top: 38px;
  padding-bottom: 24px;
}

/* ── Custom Titlebar ─────────────────────────────────────────────────────────── */
.titlebar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  z-index: 200;
  user-select: none;
  /* leave 80px on the left for macOS traffic lights */
  padding-left: 80px;
  padding-right: 8px;
}
.titlebar-name {
  flex: 1;
  text-align: center;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.titlebar-workspace {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
  min-width: 0;
}
.titlebar-ws-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.titlebar-ws-input:focus {
  border-color: var(--border-focus, #4a90d9);
}
.titlebar-ws-btn {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  width: 26px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.titlebar-ws-btn:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.titlebar-gear {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.titlebar-gear:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}

/* ── Keyboard Shortcuts Panel ────────────────────────────────────────────────── */
.kb-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}
.kb-panel {
  width: 560px;
  max-height: 520px;
  display: flex;
  flex-direction: column;
  background: var(--bg-overlay, var(--bg-inset));
  border: 1px solid var(--border-default);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,0.4);
}
.kb-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 0;
}
.kb-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.kb-panel-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
}
.kb-panel-close:hover { background: var(--bg-hover); color: var(--text-bright); }
.kb-panel-search {
  margin: 10px 12px;
  padding: 6px 12px;
  font-size: 13px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  color: var(--text-primary);
  outline: none;
}
.kb-panel-search:focus { border-color: var(--border-focus, #4a90d9); }
.kb-panel-list {
  list-style: none;
  margin: 0;
  padding: 0 0 8px;
  overflow-y: auto;
  flex: 1;
}
.kb-panel-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  font-size: 13px;
}
.kb-panel-item:hover { background: var(--bg-hover); }
.kb-panel-label { color: var(--text-primary); }
.kb-panel-key {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}

/* ── Status Bar ──────────────────────────────────────────────────────────────── */
.statusbar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 200;
  user-select: none;
  padding: 0 8px;
  font-size: 11px;
}
.statusbar-left,
.statusbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sb-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  height: 22px;
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: default;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.sb-item:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.sb-git { gap: 5px; }
.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.sb-backend.sb-connected .sb-dot { background: var(--success-fg); }
.sb-backend:not(.sb-connected) .sb-dot { background: var(--danger-fg); }
.sb-pipeline.sb-running { color: var(--accent-fg); }
.sb-pipeline.sb-completed { color: var(--success-fg); }
.sb-pipeline.sb-aborted { color: var(--danger-fg); }
.sb-agents { color: var(--text-secondary); }
.sb-clickable { cursor: pointer; }

/* ── Backend supervisor popover ──────────────────────────────────────────── */
.bp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.bp-pop {
  position: fixed;
  left: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 280px;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
}
.bp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.bp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.bp-dot.sb-connected { background: var(--success-fg); }
.bp-dot:not(.sb-connected) { background: var(--danger-fg); }
.bp-title {
  font-weight: 600;
  color: var(--text-bright);
}
.bp-state {
  margin-left: auto;
  text-transform: capitalize;
}
.bp-state.sb-connected { color: var(--success-fg); }
.bp-state:not(.sb-connected) { color: var(--danger-fg); }
.bp-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.bp-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bp-k {
  width: 36px;
  flex-shrink: 0;
  color: var(--text-muted);
}
.bp-v {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-bright);
  word-break: break-all;
}
.bp-actions {
  display: flex;
  gap: 8px;
}
.bp-btn {
  flex: 1;
  height: 28px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-hover);
  color: var(--text-bright);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.12s, opacity 0.12s;
}
.bp-btn:hover:not(:disabled) { background: var(--bg-active, var(--bg-hover)); }
.bp-btn:disabled { opacity: 0.45; cursor: default; }
.bp-restart { border-color: var(--accent-focus); color: var(--accent-fg); }
.bp-stop { border-color: var(--danger-fg); color: var(--danger-fg); }
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
  background: color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.is-resizing .resize-handle::after {
  background: color-mix(in srgb, var(--accent-focus) 40%, transparent);
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
  display: flex;
  flex-direction: column;
  padding: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.stage--tabbed {
  padding-top: 0;
}
.stage--tabbed .empty,
.stage--tabbed .grid {
  margin-top: 8px;
}
.grid {
  display: grid;
  /* grid-template-columns/rows are driven by gridStyle computed (JS) */
  gap: 8px;
  flex: 1;
  min-height: 0;
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
  background: color-mix(in srgb, var(--accent-focus) 33%, transparent);
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
  background: var(--bg-base);
  border-top: 1px solid var(--border-muted);
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.spotlight-strip::-webkit-scrollbar { height: 4px; }
.spotlight-strip::-webkit-scrollbar-track { background: transparent; }
.spotlight-strip::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 2px; }
.spotlight-thumb {
  flex-shrink: 0;
  width: 160px;
  height: 84px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
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
  border-color: var(--accent-muted);
  box-shadow: 0 2px 12px color-mix(in srgb, var(--accent-focus) 15%, transparent);
  background: var(--bg-elevated);
}
.spotlight-thumb--active {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 8%, var(--bg-elevated));
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
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.spotlight-thumb-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotlight-thumb-role {
  font-size: 9px;
  color: var(--text-secondary);
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
.spotlight-thumb-badge[data-status="running"]  { background: var(--success-subtle); color: var(--success-fg); border: 1px solid var(--success-emphasis); }
.spotlight-thumb-badge[data-status="idle"]     { background: var(--attention-subtle); color: var(--attention-bright); border: 1px solid var(--attention-emphasis); }
.spotlight-thumb-badge[data-status="starting"] { background: var(--accent-subtle); color: var(--accent-fg); border: 1px solid var(--accent-emphasis); }
.spotlight-thumb-badge[data-status="error"],
.spotlight-thumb-badge[data-status="stopped"]  { background: var(--danger-subtle); color: var(--danger-fg); border: 1px solid var(--danger-emphasis); }
.spotlight-strip-empty {
  color: var(--text-disabled);
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
  background: var(--bg-base);
  min-width: 140px;
}
.meeting-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-muted);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  min-width: 0;
}
.meeting-item:hover {
  background: var(--bg-subtle);
  border-color: var(--accent-muted);
}
.meeting-item--active {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 8%, var(--bg-elevated));
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.meeting-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  color: var(--accent-fg);
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
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.meeting-name {
  font-size: 12px;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.meeting-sub {
  font-size: 10px;
  color: var(--text-secondary);
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
.meeting-badge[data-status="running"]  { background: var(--success-subtle); color: var(--success-fg); border: 1px solid var(--success-emphasis); }
.meeting-badge[data-status="idle"]     { background: var(--attention-subtle); color: var(--attention-bright); border: 1px solid var(--attention-emphasis); }
.meeting-badge[data-status="stopped"]  { background: var(--danger-subtle); color: var(--danger-fg); border: 1px solid var(--danger-emphasis); }
.meeting-badge[data-status="starting"] { background: var(--accent-subtle); color: var(--accent-fg); border: 1px solid var(--accent-emphasis); }
.meeting-badge[data-status="error"]    { background: var(--danger-subtle); color: var(--danger-bright); border: 1px solid var(--danger-emphasis); }
.meeting-empty {
  color: var(--text-disabled);
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
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 32px var(--shadow-overlay);
  backdrop-filter: blur(8px);
}
.float-pip-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 40%, var(--border-default) 40%, var(--border-default) 60%, transparent 60%),
              linear-gradient(135deg, transparent 60%, var(--border-default) 60%, var(--border-default) 80%, transparent 80%);
  opacity: 0.5;
  border-radius: 0 0 8px 0;
}
.float-pip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  cursor: move;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  user-select: none;
}
.float-pip-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}
.float-pip-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}
.float-pip-toggle:hover { color: var(--text-bright); }
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
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  background: var(--bg-base);
}
.empty-card h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.empty-card p {
  margin: 8px 0;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
}
.empty-card .muted {
  color: var(--text-secondary);
  font-size: 12px;
}
.empty-card.loading-card {
  border-style: solid;
  border-color: var(--accent-muted);
  background: linear-gradient(180deg, var(--bg-base) 0%, var(--accent-subtle) 100%);
}
.empty-card.loading-card h2 {
  text-align: center;
  margin-top: 16px;
}
.empty-card .status {
  text-align: center;
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  color: var(--accent-bright);
  background: var(--accent-subtle);
  border: 1px solid var(--accent-muted);
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
  border: 3px solid var(--accent-muted);
  border-top-color: var(--accent-fg);
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
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  -webkit-app-region: no-drag;
}
.history-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: min(680px, 92vw);
  height: min(560px, 85vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px var(--shadow-overlay);
}
.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-muted);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
}
.history-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-killall {
  background: transparent;
  border: 1px solid var(--danger-muted);
  color: var(--danger-fg);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
}
.history-killall:hover {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
  opacity: 1;
}
.history-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.history-close:hover {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.agent-history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
}
.agent-history-empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.agent-history-row {
  padding: 8px 14px;
  border-bottom: 1px solid var(--bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-history-row.active {
  border-left: 3px solid var(--success-fg);
  padding-left: 11px;
}
.agent-history-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ah-badge {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-bright);
}
.ah-badge.ah-role {
  color: var(--accent-bright);
  border-color: var(--accent-muted);
}
.ah-origin {
  font-size: 10px;
  color: var(--text-secondary);
}
.ah-status {
  font-size: 10px;
  font-weight: 600;
}
.ah-status.active { color: var(--success-fg); }
.ah-status.removed { color: var(--text-muted); }
.agent-history-meta {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--text-muted);
}
.ah-session {
  font-family: monospace;
}
.ah-restore-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  letter-spacing: 0.2px;
}
.ah-restore-badge.ah-memory {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  border: 1px solid var(--accent-muted);
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
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-bright);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ah-revive:hover {
  background: var(--bg-selected);
  border-color: var(--accent-bright);
  color: var(--accent-bright);
}
.stall-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.stall-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--warning-fg);
  border-radius: 8px;
  width: min(520px, 92vw);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px var(--shadow-overlay);
  overflow: hidden;
}
.stall-card header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
.stall-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--warning-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning-fg) 20%, transparent);
}
.stall-slot {
  color: var(--text-secondary);
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
  color: var(--text-primary);
}
.stall-reason {
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  color: var(--warning-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 4px;
  padding: 8px 10px;
}
.stall-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.stall-hint strong {
  color: var(--text-bright);
}
.stall-auto {
  font-size: 12px;
  color: var(--accent-bright);
  font-weight: 500;
}
.stall-card footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-base);
}
.stall-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.stall-btn.primary {
  background: var(--success-emphasis);
  border-color: var(--success-emphasis);
  color: var(--text-on-emphasis);
}
.stall-btn.primary:hover {
  background: var(--success-emphasis);
}
.stall-btn.danger {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
.stall-btn.danger:hover {
  background: var(--danger-bright);
}
.sb-url { color: var(--text-muted); font-size: 10px; }
.sb-build { color: var(--text-muted); }

/* Pane right-click context menu */
.pane-ctx-backdrop { position: fixed; inset: 0; z-index: 999; }
.pane-ctx {
  position: fixed;
  z-index: 1000;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  min-width: 170px;
  user-select: none;
}
.pane-ctx-item {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.pane-ctx-item:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.pane-ctx-item.danger { color: var(--danger-bright); }
.pane-ctx-item.danger:hover { background: var(--danger-emphasis); color: var(--text-on-emphasis); }
.pane-ctx-item.disabled { opacity: 0.4; pointer-events: none; }
.pane-ctx-sep { height: 1px; background: var(--border-default); margin: 4px 0; }
.pane-rename-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-bright);
}
.pane-rename-input:focus { outline: none; border-color: var(--accent-emphasis); }
</style>
<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: var(--bg-inset);
}
</style>
