<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { useBackend } from '../composables/useBackend'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import markdown from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('vue', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  embedded?: boolean
  active?: boolean
  getEditorContent?: () => string
  getEditorSelection?: () => string
  getActiveRelPath?: () => string
  insertTextAtCursor?: (text: string) => void
  openFile?: (relPath: string, line?: number) => void
}>()

// ── Message types ──────────────────────────────────────────────────────────────
interface ToolCallCard {
  kind: 'tool_call'
  tool_id: string
  tool_name: string
  tool_input: unknown
  result?: string
  collapsed: boolean
}

interface EditProposalCard {
  kind: 'edit_proposal'
  tool_id: string
  file_path: string
  new_content: string
  diff: string
  accepted: boolean
  discarded: boolean
}

interface CommandProposalCard {
  kind: 'command_proposal'
  tool_id: string
  command: string
  cwd: string
  status: 'pending' | 'approved' | 'rejected'
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  rawContent?: string | unknown[]  // full content sent to AI (includes @chip file/git content, or multimodal array)
  streaming?: boolean
  thinking?: boolean   // true until first chunk arrives
  model?: string
  timestamp?: number       // ms since epoch
  responseStartMs?: number // when first chunk arrived
  elapsedMs?: number       // total response duration in ms
  isError?: boolean        // true when last chunk was an error
  errorMsg?: string
  cards?: Array<ToolCallCard | EditProposalCard | CommandProposalCard>
  bookmarked?: boolean
  feedback?: 'up' | 'down'
  commitMsg?: string   // detected conventional-commit message
}

// ── State ──────────────────────────────────────────────────────────────────────
const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const inputHistory: string[] = []
let historyIdx = -1
let historySavedDraft = ''  // input text saved before first ArrowUp
const sending = ref(false)
const currentSessionId = ref<string | null>(null)
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const showSettings = ref(false)
const showShortcuts = ref(false)
const autoScroll = ref(true)
const toastMsg = ref('')
let toastTimer: number | null = null
let saveTimer: number | null = null
const followUps = ref<string[]>([])
const streamNow = ref(Date.now())
let streamTickInterval: number | null = null

// ── Conversation thread persistence ──────────────────────────────────────────
interface ChatThread { id: string; title: string; messages: ChatMessage[]; updatedAt: number; pinned?: boolean }
const MAX_THREADS = 20
const MAX_MESSAGES = 500
const threadsKey = computed(() => `ai-chat-threads:${props.workspacePath}`)
const historyKey = computed(() => `ai-chat-history:${props.workspacePath}`)
const showThreads = ref(false)
const threadSearchQuery = ref('')
const renamingThreadId = ref('')
const renamingTitle = ref('')
const filteredThreads = computed(() => {
  const q = threadSearchQuery.value.trim().toLowerCase()
  const list = q
    ? allThreads.value.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : allThreads.value
  // Pinned threads always at top, then by updatedAt desc (array is already sorted that way)
  return [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)]
})

type GroupedItem = { kind: 'thread'; thread: ChatThread } | { kind: 'label'; label: string }
const groupedThreads = computed<GroupedItem[]>(() => {
  const threads = filteredThreads.value
  const pinned = threads.filter((t) => t.pinned)
  const unpinned = threads.filter((t) => !t.pinned)
  const now = Date.now()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const lastWeek = new Date(today); lastWeek.setDate(today.getDate() - 7)

  const items: GroupedItem[] = []
  if (pinned.length) {
    items.push({ kind: 'label', label: 'Pinned' })
    for (const t of pinned) items.push({ kind: 'thread', thread: t })
  }

  const groups: { label: string; threads: ChatThread[] }[] = [
    { label: 'Today', threads: [] }, { label: 'Yesterday', threads: [] },
    { label: 'This Week', threads: [] }, { label: 'Older', threads: [] },
  ]
  for (const t of unpinned) {
    const d = new Date(t.updatedAt)
    if (d >= today) groups[0].threads.push(t)
    else if (d >= yesterday) groups[1].threads.push(t)
    else if (d >= lastWeek) groups[2].threads.push(t)
    else groups[3].threads.push(t)
  }
  for (const g of groups) {
    if (!g.threads.length) continue
    items.push({ kind: 'label', label: g.label })
    for (const t of g.threads) items.push({ kind: 'thread', thread: t })
  }
  return items
})

function getThreadMatchSnippet(thread: ChatThread, q: string): string {
  if (!q) return ''
  for (const m of thread.messages) {
    const idx = m.content.toLowerCase().indexOf(q.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - 20)
      const end = Math.min(m.content.length, idx + q.length + 40)
      return (start > 0 ? '…' : '') + m.content.slice(start, end).replace(/\n/g, ' ') + (end < m.content.length ? '…' : '')
    }
  }
  return ''
}

function togglePinThread(id: string, e: Event): void {
  e.stopPropagation()
  const t = allThreads.value.find((th) => th.id === id)
  if (t) { t.pinned = !t.pinned; saveCurrentThread() }
}
const currentThreadId = ref('')
const allThreads = ref<ChatThread[]>([])

function newThreadId(): string { return crypto.randomUUID() }

function loadThreads(): void {
  try {
    const raw = localStorage.getItem(threadsKey.value)
    if (raw) {
      allThreads.value = (JSON.parse(raw) as ChatThread[]).slice(0, MAX_THREADS)
    } else {
      // Migrate from old single-key format
      const legacyRaw = localStorage.getItem(historyKey.value)
      if (legacyRaw) {
        const legacyMsgs = (JSON.parse(legacyRaw) as ChatMessage[]).filter((m) => !m.streaming)
        if (legacyMsgs.length) {
          const firstUser = legacyMsgs.find((m) => m.role === 'user')
          const thread: ChatThread = {
            id: newThreadId(),
            title: firstUser ? firstUser.content.slice(0, 40) : 'Chat history',
            messages: legacyMsgs,
            updatedAt: Date.now(),
          }
          allThreads.value = [thread]
          localStorage.removeItem(historyKey.value)
        }
      }
    }
  } catch { /* ignore */ }

  if (allThreads.value.length === 0) {
    const id = newThreadId()
    allThreads.value = [{ id, title: 'New chat', messages: [], updatedAt: Date.now() }]
  }
  const latest = allThreads.value[0]
  currentThreadId.value = latest.id
  messages.value = latest.messages.map((m) => ({ ...m, streaming: false, thinking: false }))
}

function _doSave(): void {
  const idx = allThreads.value.findIndex((t) => t.id === currentThreadId.value)
  if (idx === -1) return
  const toSave = messages.value.filter((m) => !m.streaming).slice(-100)
  allThreads.value[idx].messages = toSave
  allThreads.value[idx].updatedAt = Date.now()
  const firstUser = toSave.find((m) => m.role === 'user')
  if (firstUser && (allThreads.value[idx].title === 'New chat' )) {
    // Truncate at word boundary within 40 chars
    const raw = firstUser.content.replace(/\s+/g, ' ').trim()
    const cut = raw.length <= 40 ? raw : (raw.slice(0, 40).replace(/\s\S*$/, '') || raw.slice(0, 40))
    allThreads.value[idx].title = cut
  }
  try { localStorage.setItem(threadsKey.value, JSON.stringify(allThreads.value.slice(0, MAX_THREADS))) }
  catch { /* quota */ }
}

function saveCurrentThread(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { _doSave() }, 1000)
}

function newThread(): void {
  if (sending.value) stopStreaming()
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
  _doSave()
  const id = newThreadId()
  const thread: ChatThread = { id, title: 'New chat', messages: [], updatedAt: Date.now() }
  allThreads.value.unshift(thread)
  currentThreadId.value = id
  messages.value = []
  expandedMsgIdxs.value = new Set(); expandedDiffs.value = new Set()
  showThreads.value = false
}

function switchThread(id: string): void {
  if (id === currentThreadId.value) { showThreads.value = false; return }
  if (sending.value) stopStreaming()
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
  _doSave()
  const thread = allThreads.value.find((t) => t.id === id)
  if (!thread) return
  currentThreadId.value = id
  messages.value = thread.messages.map((m) => ({ ...m, streaming: false, thinking: false }))
  expandedMsgIdxs.value = new Set(); expandedDiffs.value = new Set()
  // Move selected thread to front
  allThreads.value = [thread, ...allThreads.value.filter((t) => t.id !== id)]
  showThreads.value = false
}

function deleteThread(id: string): void {
  allThreads.value = allThreads.value.filter((t) => t.id !== id)
  if (currentThreadId.value === id) {
    if (allThreads.value.length === 0) newThread()
    else switchThread(allThreads.value[0].id)
  }
  try { localStorage.setItem(threadsKey.value, JSON.stringify(allThreads.value)) }
  catch { /* quota */ }
}

function startRenameThread(id: string, title: string, e: Event): void {
  e.stopPropagation()
  renamingThreadId.value = id
  renamingTitle.value = title
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.ai-thread-rename-input')
    el?.focus()
    el?.select()
  })
}
function finishRenameThread(): void {
  const id = renamingThreadId.value
  const title = renamingTitle.value.trim()
  if (id && title) {
    const t = allThreads.value.find((t) => t.id === id)
    if (t) { t.title = title; saveCurrentThread() }
  }
  renamingThreadId.value = ''
  renamingTitle.value = ''
}
function cancelRenameThread(): void {
  renamingThreadId.value = ''
  renamingTitle.value = ''
}

watch(messages, saveCurrentThread, { deep: true })

// ── Settings ───────────────────────────────────────────────────────────────────
const settingsProvider = ref<'anthropic' | 'ollama'>('anthropic')
const settingsApiKey = ref('')
const settingsModel = ref('claude-sonnet-4-6')
const settingsOllamaUrl = ref('http://localhost:11434')
const settingsSystemPrompt = ref('You are a helpful AI coding assistant.')
const settingsAutoAccept = ref(localStorage.getItem('ai-chat-auto-accept') === 'true')
const settingsMaxTokens = ref(4096)
const settingsTemperature = ref<number | null>(null)  // null = use model default
const showModelPicker = ref(false)

const ANTHROPIC_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
]
const OLLAMA_MODELS = ['llama3.2', 'llama3.1', 'qwen2.5-coder', 'mistral', 'codellama', 'gemma2']
const currentModelOptions = computed(() =>
  settingsProvider.value === 'anthropic' ? ANTHROPIC_MODELS : OLLAMA_MODELS,
)
const modelIsCustom = computed(() => !currentModelOptions.value.includes(settingsModel.value))
const selectedModelKey = computed({
  get: () => (modelIsCustom.value ? 'custom' : settingsModel.value),
  set: (val: string) => { if (val !== 'custom') settingsModel.value = val },
})
// When provider switches, reset model to the first preset for that provider
// (only if current model belongs to the other provider's list)
watch(settingsProvider, (provider) => {
  const opts = provider === 'anthropic' ? ANTHROPIC_MODELS : OLLAMA_MODELS
  const other = provider === 'anthropic' ? OLLAMA_MODELS : ANTHROPIC_MODELS
  if (!opts.includes(settingsModel.value) && other.includes(settingsModel.value)) {
    settingsModel.value = opts[0]
  }
})

// Long message fold — collapse AI messages with > 50 lines (UI-only, ephemeral)
const expandedMsgIdxs = ref(new Set<number>())
const MSG_FOLD_LINE_THRESHOLD = 50
function isMsgFolded(mi: number, content: string): boolean {
  return content.split('\n').length > MSG_FOLD_LINE_THRESHOLD && !expandedMsgIdxs.value.has(mi)
}
function toggleMsgFold(mi: number): void {
  if (expandedMsgIdxs.value.has(mi)) expandedMsgIdxs.value.delete(mi)
  else expandedMsgIdxs.value.add(mi)
  // Trigger reactivity
  expandedMsgIdxs.value = new Set(expandedMsgIdxs.value)
}

// Response length preference — prepended to system prompt when sending
const responseLengths = ['normal', 'concise', 'detailed'] as const
type ResponseLength = typeof responseLengths[number]
const responseLength = ref<ResponseLength>('normal')
const RESPONSE_LENGTH_LABELS: Record<ResponseLength, string> = { normal: 'Normal', concise: 'Concise', detailed: 'Detailed' }
const RESPONSE_LENGTH_HINTS: Record<ResponseLength, string> = {
  normal: '',
  concise: 'Be concise. Keep responses short and to the point.',
  detailed: 'Be thorough and detailed. Include examples and explanations.',
}
function cycleResponseLength(): void {
  const idx = responseLengths.indexOf(responseLength.value)
  responseLength.value = responseLengths[(idx + 1) % responseLengths.length]
}

// Input char counter + token estimate (shown when > 200 chars)
const inputCharCount = computed(() => inputText.value.length)
const inputTokenEstimate = computed(() => Math.ceil(inputCharCount.value / 4))

// Context window usage estimate (assumes ~100k token limit)
const CTX_MAX_TOKENS = 100_000
const conversationTokenEstimate = computed(() =>
  messages.value.reduce((sum, m) => sum + Math.ceil((m.rawContent ?? m.content).length / 4), 0)
)
const ctxUsagePct = computed(() => Math.min(100, Math.round((conversationTokenEstimate.value / CTX_MAX_TOKENS) * 100)))
const ctxUsageLevel = computed(() => {
  if (ctxUsagePct.value >= 90) return 'danger'
  if (ctxUsagePct.value >= 60) return 'warn'
  return 'ok'
})

// ── Conversation search ────────────────────────────────────────────────────────
const showSearch = ref(false)
const searchQuery = ref('')
const searchMatchIdx = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)

const searchMatches = computed<number[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  return messages.value.reduce<number[]>((acc, m, i) => {
    if (m.content.toLowerCase().includes(q)) acc.push(i)
    return acc
  }, [])
})

function openSearch(): void {
  showSearch.value = true
  searchQuery.value = ''
  searchMatchIdx.value = 0
  nextTick(() => searchInput.value?.focus())
}

function closeSearch(): void {
  showSearch.value = false
  searchQuery.value = ''
}

function searchNav(delta: number): void {
  const len = searchMatches.value.length
  if (!len) return
  searchMatchIdx.value = (searchMatchIdx.value + delta + len) % len
  const msgIdx = searchMatches.value[searchMatchIdx.value]
  const el = messagesEl.value?.querySelectorAll('.ai-msg')[msgIdx] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

watch(searchQuery, () => {
  searchMatchIdx.value = 0
  if (searchMatches.value.length) searchNav(0)
})

function isSearchMatch(idx: number): boolean {
  return showSearch.value && searchMatches.value.includes(idx)
}

function isSearchActive(idx: number): boolean {
  return showSearch.value && searchMatches.value[searchMatchIdx.value] === idx
}

function renderWithSearchHighlight(content: string): string {
  const html = renderMarkdownLite(content)
  const q = searchQuery.value.trim()
  if (!showSearch.value || !q) return html
  // Only highlight in text nodes — skip content inside HTML tags
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.replace(
    new RegExp(`(?![^<]*>)(${escaped})`, 'gi'),
    '<mark class="ai-search-highlight">$1</mark>',
  )
}

// ── Context chips (@mentions) ──────────────────────────────────────────────────
interface ContextChip {
  id: string
  label: string
  content: string
  imageData?: string // base64 data URL for pasted images (e.g. data:image/png;base64,...)
  pinned?: boolean   // pinned chips survive message sends — always included in context
}
const contextChips = ref<ContextChip[]>([])
const previewChipId = ref<string | null>(null)
const previewChip = computed(() => contextChips.value.find((c) => c.id === previewChipId.value) ?? null)
const showAtMenu = ref(false)
const atMenuFilter = ref('')
const atMenuIdx = ref(0)
const atMenuEl = ref<HTMLElement | null>(null)

interface AtOption { id: string; label: string }
const AT_OPTIONS_STATIC: AtOption[] = [
  { id: '@file', label: '@file — current open file' },
  { id: '@selection', label: '@selection — editor selection' },
  { id: '@git', label: '@git — current git diff (unstaged)' },
  { id: '@git:staged', label: '@git:staged — staged changes (git diff --cached)' },
  { id: '@git:log', label: '@git:log — recent commit history (last 20)' },
  { id: '@git:branch', label: '@git:branch — current branch & last commit' },
  { id: '@git:blame', label: '@git:blame — blame for current open file' },
  { id: '@codebase', label: '@codebase — search workspace code' },
  { id: '@folder', label: '@folder — all files in a directory' },
  { id: '@problems', label: '@problems — TypeScript & lint errors' },
  { id: '@url', label: '@url — fetch a web page as context' },
  { id: '@clipboard', label: '@clipboard — paste clipboard content' },
  { id: '@tree', label: '@tree — workspace file tree structure' },
  { id: '@symbol', label: '@symbol — find a function or class definition' },
]
const atDirItems = ref<AtOption[]>([])
const recentAtFiles = ref<string[]>([])

const atOptions = ref<AtOption[]>([...AT_OPTIONS_STATIC])

watch(() => props.getActiveRelPath?.(), (path) => {
  if (path && !recentAtFiles.value.includes(path)) {
    recentAtFiles.value.unshift(path)
    if (recentAtFiles.value.length > 8) recentAtFiles.value.pop()
  }
})

// ── Slash commands ────────────────────────────────────────────────────────────
interface SlashCommand { id: string; label: string; description: string; template: string }
const SLASH_COMMANDS: SlashCommand[] = [
  { id: '/explain', label: '/explain', description: 'Explain code',             template: 'Explain the following code in detail:' },
  { id: '/fix',     label: '/fix',     description: 'Fix issue',               template: 'Find and fix the issues in the following code:' },
  { id: '/tests',   label: '/tests',   description: 'Generate tests',          template: 'Write comprehensive unit tests for the following code:' },
  { id: '/doc',     label: '/doc',     description: 'Write docs',              template: 'Write clear documentation for the following code:' },
  { id: '/review',   label: '/review',   description: 'Code review',           template: 'Review the following code and point out potential issues and improvements:' },
  { id: '/optimize', label: '/optimize', description: 'Performance optimization', template: 'Analyze performance bottlenecks in the following code and provide optimization suggestions:' },
  { id: '/refactor', label: '/refactor', description: 'Refactor code',         template: 'Refactor the following code to improve readability and maintainability without changing functionality:' },
  { id: '/new',       label: '/new',       description: 'Create new file',     template: 'Create a new file with the following content:' },
  { id: '/debug',     label: '/debug',     description: 'Find bugs',            template: 'Analyze the following code for bugs, edge cases, and potential runtime errors. Be specific about line numbers and root causes:\n\n' },
  { id: '/improve',   label: '/improve',   description: 'Suggest improvements', template: 'Suggest concrete improvements for the following code in terms of readability, maintainability, and best practices:\n\n' },
  { id: '/commit',    label: '/commit',    description: 'AI commit message',   template: 'Generate a concise git commit message (conventional commits format) for the following changes:\n\n' },
  { id: '/summarize', label: '/summarize', description: 'Summarize conversation', template: '' },
  { id: '/run',      label: '/run',      description: 'Run shell command',       template: '' },
  { id: '/clear',    label: '/clear',    description: 'Clear chat',             template: '' },
  { id: '/export',   label: '/export',   description: 'Export chat',            template: '' },
  { id: '/help',     label: '/help',     description: 'Show all commands',       template: '' },
  { id: '/test',     label: '/test',     description: 'Run test suite',          template: '' },
  { id: '/diff',     label: '/diff',     description: 'Explain current diff',    template: '' },
  { id: '/continue', label: '/continue', description: 'Continue last response',  template: '' },
]
const showSlashMenu = ref(false)
const slashMenuFilter = ref('')
const slashMenuIdx = ref(0)
const slashMenuEl = ref<HTMLElement | null>(null)
const slashOptions = ref<SlashCommand[]>([...SLASH_COMMANDS])

// ── Code-block copy via event delegation ─────────────────────────────────────
async function onMessagesClick(e: MouseEvent): Promise<void> {
  const target = e.target as Element
  // Copy button
  const copyBtn = target.closest<HTMLButtonElement>('.ai-code-copy-btn')
  if (copyBtn) {
    try {
      const code = decodeURIComponent(escape(atob(copyBtn.dataset.code ?? '')))
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = 'Copied!'
        window.setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
      }).catch(() => {/* ignore */})
    } catch {/* ignore */}
    return
  }
  // Code fold/expand toggle
  const foldBtn = target.closest<HTMLButtonElement>('.ai-code-fold-btn')
  if (foldBtn) {
    const wrap = foldBtn.closest<HTMLElement>('.ai-code-wrap')
    const pre = wrap?.querySelector<HTMLElement>('pre.ai-code-block')
    if (!pre || !wrap) return
    const folded = wrap.dataset.folded === 'true'
    const lines = foldBtn.dataset.lines ?? '?'
    if (folded) {
      pre.style.display = ''
      wrap.dataset.folded = 'false'
      foldBtn.textContent = `▼ Collapse (${lines} lines)`
    } else {
      pre.style.display = 'none'
      wrap.dataset.folded = 'true'
      foldBtn.textContent = `▶ Expand (${lines} lines)`
    }
    return
  }

  // Apply to editor button
  const applyBtn = target.closest<HTMLButtonElement>('.ai-code-apply-btn')
  if (applyBtn) {
    try {
      const code = decodeURIComponent(escape(atob(applyBtn.dataset.code ?? '')))
      const relPath = props.getActiveRelPath?.()
      if (!relPath) { showToast('No file open'); return }
      const lineCount = code.split('\n').length
      if (!window.confirm(`Apply ${lineCount} lines of code to "${relPath}"?\n\nNote: This will overwrite the entire file.`)) return
      props.backend.send('fs.write_file', {
        workspace_path: props.workspacePath,
        rel_path: relPath,
        content: code,
      }).then(() => {
        applyBtn.textContent = 'Applied ✓'
        applyBtn.style.color = 'var(--success-fg, #3fb950)'
        window.setTimeout(() => { applyBtn.textContent = 'Apply'; applyBtn.style.color = '' }, 2000)
        showToast(`Applied to ${relPath}`)
      }).catch(() => showToast('Apply failed'))
    } catch { showToast('Apply failed') }
  }

  // Insert at cursor button
  const insertBtn = target.closest<HTMLButtonElement>('.ai-code-insert-btn')
  if (insertBtn) {
    try {
      const code = decodeURIComponent(escape(atob(insertBtn.dataset.code ?? '')))
      if (!props.insertTextAtCursor) { showToast('No editor active'); return }
      props.insertTextAtCursor(code)
      insertBtn.textContent = 'Inserted ✓'
      insertBtn.style.color = 'var(--success-fg, #3fb950)'
      window.setTimeout(() => { insertBtn.textContent = 'Insert'; insertBtn.style.color = '' }, 2000)
      showToast('Inserted at cursor')
    } catch { showToast('Insert failed') }
  }

  // Run shell code block
  const runCodeBtn = target.closest<HTMLButtonElement>('.ai-code-run-btn')
  if (runCodeBtn) {
    try {
      const code = decodeURIComponent(escape(atob(runCodeBtn.dataset.code ?? '')))
      if (!window.confirm(`Run this command in workspace?\n\n${code}\n\nNote: This will execute in your workspace directory.`)) return
      runCodeBtn.textContent = '⏳ Running…'
      runCodeBtn.disabled = true
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: code,
        workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const resultText = r?.ok
        ? `\`\`\`\n${r.output ?? '(no output)'}\n\`\`\`\n_Exit code: ${r.exit_code ?? 0}_`
        : `Error: ${r?.error ?? 'unknown'}`
      messages.value.push({ role: 'assistant', content: resultText, timestamp: Date.now() })
      runCodeBtn.textContent = '✓ Done'
      window.setTimeout(() => { runCodeBtn.textContent = '▶ Run'; runCodeBtn.disabled = false }, 2000)
    } catch {
      runCodeBtn.textContent = '▶ Run'
      runCodeBtn.disabled = false
      showToast('Run failed')
    }
    return
  }

  // Save code block to file
  const saveBtn = target.closest<HTMLButtonElement>('.ai-code-save-btn')
  if (saveBtn) {
    try {
      const code = decodeURIComponent(escape(atob(saveBtn.dataset.code ?? '')))
      const ext = saveBtn.dataset.ext ?? 'txt'
      const r = await window.agentTeam?.saveJson({ defaultName: `snippet.${ext}`, content: code, title: 'Save code to file' })
      if (r?.ok) showToast('Saved')
      else if (!r?.canceled) showToast('Save failed')
    } catch { showToast('Save failed') }
    return
  }

  // Clickable file path in inline code (supports :line notation)
  const fileRef = target.closest<HTMLElement>('.ai-file-ref')
  if (fileRef) {
    const relPath = fileRef.dataset.path ?? ''
    const line = fileRef.dataset.line ? parseInt(fileRef.dataset.line, 10) : undefined
    if (relPath && props.openFile) {
      props.openFile(relPath, line)
    } else if (relPath) {
      showToast(`File: ${relPath}${line ? `:${line}` : ''}`)
    }
  }
}

// ── Run git commit from AI-detected commit message ────────────────────────────
async function runCommit(msg: ChatMessage): Promise<void> {
  if (!msg.commitMsg) return
  if (!window.confirm(`Run git commit with message:\n\n${msg.commitMsg}\n\nThis will commit all staged changes.`)) return
  try {
    interface CommitResp { ok: boolean; error?: string }
    const resp = await props.backend.send<CommitResp>('git.commit', {
      workspace_path: props.workspacePath,
      message: msg.commitMsg,
      all: false,
    })
    if (resp.payload?.ok) {
      showToast('Committed successfully')
      msg.commitMsg = undefined
    } else {
      showToast(`Commit failed: ${resp.payload?.error ?? 'unknown error'}`)
    }
  } catch {
    showToast('Commit failed')
  }
}

// ── Follow-up suggestions ──────────────────────────────────────────────────────
function extractFollowUps(content: string): string[] {
  // Strip code blocks first
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
  // Find sentences ending with ?
  const sentences = stripped.match(/[A-Z][^.!?]*\?/g) ?? []
  // Filter: at least 15 chars, not too long, start with question words
  const QUESTION_WORDS = /^(What|How|Why|When|Where|Which|Who|Can|Could|Should|Would|Is|Are|Does|Do)\b/i
  const suggestions = sentences
    .map((s) => s.trim())
    .filter((s) => s.length >= 15 && s.length <= 120 && QUESTION_WORDS.test(s))
    .slice(0, 3)
  return suggestions
}

// ── Markdown lite renderer ─────────────────────────────────────────────────────
function renderMarkdownLite(rawText: string): string {
  // 1. Extract fenced code blocks so they are never touched by inline transforms
  const blocks: string[] = []
  let text = rawText.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const LANG_DISPLAY: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
      py: 'Python', python: 'Python', rb: 'Ruby', go: 'Go',
      rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
      cpp: 'C++', c: 'C', cs: 'C#', php: 'PHP', scala: 'Scala',
      sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
      json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
      html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass',
      sql: 'SQL', md: 'Markdown', xml: 'XML', vue: 'Vue',
      svelte: 'Svelte', graphql: 'GraphQL', dockerfile: 'Dockerfile',
      makefile: 'Makefile', r: 'R', lua: 'Lua', dart: 'Dart',
    }
    const langLabelRaw = lang ? (LANG_DISPLAY[lang.toLowerCase()] ?? lang) : 'text'
    const langLabel = langLabelRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const encoded = btoa(unescape(encodeURIComponent(code.trim())))
    // Apply syntax highlighting; skip auto-detect for large blocks (> 3000 chars) to avoid slowdown
    let highlighted: string
    try {
      let result
      if (lang && hljs.getLanguage(lang)) {
        result = hljs.highlight(code, { language: lang })
      } else if (!lang && code.length < 3000) {
        result = hljs.highlightAuto(code, ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'xml', 'sql', 'yaml'])
      }
      highlighted = result ? result.value : code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    } catch {
      highlighted = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    const i = blocks.length
    // Only show Apply/Insert buttons when an active file path is available
    const hasActiveFile = !!(props.getActiveRelPath?.())
    const insertBtn = hasActiveFile && props.insertTextAtCursor
      ? `<button class="ai-code-insert-btn" data-code="${encoded}" title="Insert at cursor">Insert</button>`
      : ''
    const applyBtn = hasActiveFile
      ? `<button class="ai-code-apply-btn" data-code="${encoded}" title="Apply to current open file">Apply</button>`
      : ''
    // Collapse code blocks that exceed 30 lines
    const lineCount = code.split('\n').length
    const isLong = lineCount > 30
    const foldAttr = isLong ? ' data-folded="true"' : ''
    const toggleBtn = isLong
      ? `<button class="ai-code-fold-btn" data-lines="${lineCount}">▶ Expand (${lineCount} lines)</button>`
      : ''
    const isShell = ['sh', 'bash', 'zsh', 'fish', 'shell'].includes((lang ?? '').toLowerCase())
    const runBtn = isShell
      ? `<button class="ai-code-run-btn" data-code="${encoded}" title="Run in workspace">▶ Run</button>`
      : ''
    const LANG_EXT: Record<string, string> = {
      ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'py', python: 'py',
      rb: 'rb', go: 'go', rs: 'rs', java: 'java', kt: 'kt', swift: 'swift',
      cpp: 'cpp', c: 'c', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', html: 'html',
      css: 'css', scss: 'scss', sql: 'sql', md: 'md', vue: 'vue',
    }
    const ext = lang ? (LANG_EXT[lang.toLowerCase()] ?? 'txt') : 'txt'
    const saveBtn = window.agentTeam?.saveJson
      ? `<button class="ai-code-save-btn" data-code="${encoded}" data-ext="${ext}" title="Save to file">Save</button>`
      : ''
    // Wrap each line in a span for CSS line-number counters
    const numberedLines = highlighted
      .split('\n')
      .map((line) => `<span class="code-ln">${line}</span>`)
      .join('\n')
    blocks.push(
      `<div class="ai-code-wrap"${foldAttr}>` +
      `<div class="ai-code-header">` +
      `<span class="ai-code-lang">${langLabel}</span>` +
      `${runBtn}` +
      `${saveBtn}` +
      `${insertBtn}` +
      `${applyBtn}` +
      `<button class="ai-code-copy-btn" data-code="${encoded}">Copy</button>` +
      `</div>` +
      `${toggleBtn}` +
      `<pre class="ai-code-block hljs"${isLong ? ' style="display:none"' : ''}><code class="has-line-numbers">${numberedLines}</code></pre>` +
      `</div>`,
    )
    return `\x00B${i}\x00`
  })
  // HTML-escape non-code-block content to prevent XSS via v-html
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 2. Line-by-line: headings, lists, blockquotes, tables, blank lines
  const lines = text.split('\n')
  const parts: string[] = []
  let inUl = false, inOl = false, inBlockquote = false, inTable = false
  const tableRows: string[][] = []
  let tableHasHeader = false

  const flushList = () => {
    if (inUl) { parts.push('</ul>'); inUl = false }
    if (inOl) { parts.push('</ol>'); inOl = false }
  }
  const flushBlockquote = () => {
    if (inBlockquote) { parts.push('</blockquote>'); inBlockquote = false }
  }
  const flushTable = () => {
    if (!inTable) return
    inTable = false
    if (tableRows.length === 0) { tableRows.length = 0; return }
    let html = '<table class="ai-table"><tbody>'
    tableRows.forEach((cells, ri) => {
      const tag = (ri === 0 && tableHasHeader) ? 'th' : 'td'
      if (ri === 1 && tableHasHeader) return // skip separator row
      html += '<tr>' + cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>'
    })
    html += '</tbody></table>'
    parts.push(html)
    tableRows.length = 0
    tableHasHeader = false
  }
  const flushAll = () => { flushList(); flushBlockquote(); flushTable() }

  const isTableRow = (l: string) => /^\|.+\|/.test(l.trim())
  const isSepRow = (l: string) => /^\|[\s\-:|]+\|/.test(l.trim())
  const splitCells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|')

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Code block placeholder (whole line)
    if (/^\x00B\d+\x00$/.test(line.trim())) {
      flushAll(); parts.push(line.trim()); continue
    }
    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushAll(); parts.push('<hr class="ai-hr">'); continue
    }
    // Heading: #, ##, ###, ####
    const hm = line.match(/^(#{1,4})\s+(.+)/)
    if (hm) {
      flushAll()
      const lvl = Math.min(hm[1].length + 1, 5)
      parts.push(`<h${lvl} class="ai-h">${hm[2]}</h${lvl}>`)
      continue
    }
    // Table detection: current or next line is a separator row
    if (isTableRow(line)) {
      const nextLine = lines[li + 1] || ''
      if (!inTable) {
        flushList(); flushBlockquote()
        inTable = true
        tableRows.push(splitCells(line))
        if (isSepRow(nextLine)) tableHasHeader = true
      } else if (isSepRow(line)) {
        // separator row — already marked, skip it
        tableRows.push(splitCells(line))
      } else {
        tableRows.push(splitCells(line))
      }
      continue
    }
    if (inTable) { flushTable() }
    // Blockquote
    const bqm = line.match(/^>\s?(.*)/)
    if (bqm) {
      flushList()
      if (!inBlockquote) { parts.push('<blockquote class="ai-blockquote">'); inBlockquote = true }
      parts.push(bqm[1] === '' ? '<br>' : bqm[1] + '<br>')
      continue
    }
    if (inBlockquote && line.trim() === '') { flushBlockquote(); parts.push('<br>'); continue }
    flushBlockquote()
    // Task list items: - [ ] or - [x]
    const taskm = line.match(/^[*\-+]\s+\[([ xX])\]\s+(.+)/)
    if (taskm) {
      const checked = taskm[1].toLowerCase() === 'x'
      if (inOl) { parts.push('</ol>'); inOl = false }
      if (!inUl) { parts.push('<ul class="ai-ul ai-task-list">'); inUl = true }
      parts.push(`<li class="ai-task-item"><input type="checkbox" ${checked ? 'checked' : ''} disabled> ${taskm[2]}</li>`)
      continue
    }
    // Unordered list
    const ulm = line.match(/^[*\-+]\s+(.+)/)
    if (ulm) {
      if (inOl) { parts.push('</ol>'); inOl = false }
      if (!inUl) { parts.push('<ul class="ai-ul">'); inUl = true }
      parts.push(`<li>${ulm[1]}</li>`)
      continue
    }
    // Ordered list
    const olm = line.match(/^\d+[.)]\s+(.+)/)
    if (olm) {
      if (inUl) { parts.push('</ul>'); inUl = false }
      if (!inOl) { parts.push('<ol class="ai-ol">'); inOl = true }
      parts.push(`<li>${olm[1]}</li>`)
      continue
    }
    flushList()
    parts.push(line === '' ? '<br>' : line + '<br>')
  }
  flushAll()

  let html = parts.join('')

  // 3. Inline transforms (safe: never match inside code blocks — those are placeholders now)
  // Bold
  html = html.replace(/\*\*([^*<\n]+)\*\*/g, '<strong>$1</strong>')
  // Italic (only single *, guard against **)
  html = html.replace(/(?<!\*)\*([^*<\n]+)\*(?!\*)/g, '<em>$1</em>')
  // Strikethrough
  html = html.replace(/~~([^~<\n]+)~~/g, '<del>$1</del>')
  // Inline code — file paths (optionally :line) become clickable links
  const FILE_PATH_RE = /^((?:\.{0,2}\/)?[\w.\-/ ]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|rb|java|kt|swift|c|cpp|cs|php|sh|md|json|yaml|yml|toml|html|css|scss|sql))(?::(\d+))?$/
  html = html.replace(/`([^`\n]+)`/g, (_, c) => {
    const escaped = c.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const m = c.trim().match(FILE_PATH_RE)
    if (m && c.includes('/')) {
      const lineAttr = m[2] ? ` data-line="${m[2]}"` : ''
      const lineLabel = m[2] ? `<span class="ai-file-ref-line">:${m[2]}</span>` : ''
      return `<code class="ai-inline-code ai-file-ref" data-path="${m[1]}"${lineAttr}>${escaped.replace(/:(\d+)$/, '')}${lineLabel}</code>`
    }
    return `<code class="ai-inline-code">${escaped}</code>`
  })
  // Auto-link URLs (not inside existing tags)
  html = html.replace(/(?<![="'])https?:\/\/[^\s<>"')\]]+/g,
    (url) => `<a class="ai-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  )

  // 4. Restore code blocks
  html = html.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[Number(i)])

  return html
}

// ── Diff rendering ─────────────────────────────────────────────────────────────
function renderDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<div class="diff-add">${escaped}</div>`
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        return `<div class="diff-del">${escaped}</div>`
      } else if (line.startsWith('@@')) {
        return `<div class="diff-hunk">${escaped}</div>`
      }
      return `<div class="diff-ctx">${escaped}</div>`
    })
    .join('')
}

// ── Compute unified diff from new_content ─────────────────────────────────────
function makeDiff(filePath: string, newContent: string): string {
  // We can't run diff in the renderer; produce a simple "whole file replacement" diff header.
  const lines = newContent.split('\n')
  const added = lines.map((l) => `+${l}`).join('\n')
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${added}`
}

// ── Scroll to bottom ───────────────────────────────────────────────────────────
async function scrollBottom(force = false): Promise<void> {
  await nextTick()
  if (messagesEl.value && (autoScroll.value || force)) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

function onMessagesScroll(): void {
  if (!messagesEl.value) return
  const el = messagesEl.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  autoScroll.value = atBottom
}

// ── Build tree string from flat file paths ────────────────────────────────────
function buildFileTree(files: string[]): string {
  type Node = { [key: string]: Node | null }
  const root: Node = {}
  for (const f of files) {
    const parts = f.split('/')
    let cur = root
    for (const part of parts) {
      if (!cur[part]) cur[part] = {}
      cur = cur[part] as Node
    }
  }
  const lines: string[] = []
  function walk(node: Node, prefix: string): void {
    const keys = Object.keys(node).sort((a, b) => {
      const aDir = Object.keys(node[a] as Node).length > 0
      const bDir = Object.keys(node[b] as Node).length > 0
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.localeCompare(b)
    })
    keys.forEach((key, i) => {
      const isLast = i === keys.length - 1
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${key}`)
      const child = node[key] as Node
      if (child && Object.keys(child).length > 0) {
        walk(child, prefix + (isLast ? '    ' : '│   '))
      }
    })
  }
  walk(root, '')
  return lines.join('\n')
}

// ── Tool call human-readable summary + icon ──────────────────────────────────
function getToolIcon(name: string): string {
  switch (name) {
    case 'read_file':      return '▤'
    case 'search_files':   return '⌕'
    case 'edit_file':      return '✎'
    case 'run_command':    return '▶'
    case 'list_directory': return '⊞'
    default:               return '⚙'
  }
}

function getToolSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name
  const inp = input as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'read_file':       return `Reading: ${str(inp.file_path)}`
    case 'search_files':    return `Searching: "${str(inp.query)}"${inp.file_pattern ? ` in ${inp.file_pattern}` : ''}`
    case 'edit_file':       return `Editing: ${str(inp.file_path)}`
    case 'run_command':     return `Running: ${str(inp.command)}`
    case 'list_directory':  return `Listing: ${str(inp.path) || '.'}`
    default:                return name
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg: string): void {
  toastMsg.value = msg
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastMsg.value = '' }, 3000)
}

// ── Settings fetch/save ────────────────────────────────────────────────────────
function fetchSettings(): void {
  props.backend.send('ai.chat.settings.get', {}).catch(() => {/* ignore */})
}

function saveSettings(): void {
  const payload: Record<string, unknown> = {
    provider: settingsProvider.value,
    anthropic_api_key: settingsApiKey.value,
    model: settingsModel.value,
    ollama_base_url: settingsOllamaUrl.value,
    system_prompt: settingsSystemPrompt.value,
    max_tokens: Math.max(256, Math.min(16000, Number(settingsMaxTokens.value) || 4096)),
  }
  if (settingsTemperature.value !== null) {
    payload.temperature = Math.max(0, Math.min(1, settingsTemperature.value))
  }
  props.backend.send('ai.chat.settings.set', payload).catch(() => {/* ignore */})
  localStorage.setItem('ai-chat-auto-accept', settingsAutoAccept.value ? 'true' : 'false')
  showSettings.value = false
  showToast('Settings saved')
}

// ── Send message ───────────────────────────────────────────────────────────────
async function sendMessage(): Promise<void> {
  const rawText = inputText.value.trim()
  if (!rawText && contextChips.value.length === 0) return
  if (sending.value) return

  // /help — show all available slash commands and @ contexts
  if (rawText === '/help') {
    inputText.value = ''
    messages.value.push({ role: 'user', content: '/help', timestamp: Date.now() })
    const cmdList = SLASH_COMMANDS.filter((c) => c.id !== '/help')
      .map((c) => `**${c.id}** — ${c.description}`)
      .join('\n')
    const ctxList = AT_OPTIONS_STATIC
      .map((o) => `**${o.id}** — ${o.label.split(' — ')[1] ?? ''}`)
      .join('\n')
    const helpText = `## Slash Commands\n${cmdList}\n\n## Context Providers (@)\n${ctxList}\n\n_Tip: type \`@filename:10-50\` to include specific lines from a file._`
    messages.value.push({ role: 'assistant', content: helpText, timestamp: Date.now() })
    return
  }

  // /continue — append "Please continue" to ask AI to keep going after truncation
  if (rawText === '/continue') {
    inputText.value = 'Please continue from where you left off.'
    void sendMessage()
    return
  }

  // /test — run test suite and show output
  if (rawText === '/test' || rawText.startsWith('/test ')) {
    if (!props.workspacePath) { showToast('/test requires an open workspace'); return }
    const extra = rawText.slice('/test'.length).trim()
    // Detect test runner: vitest if vitest.config exists, else npm test
    let testCmd = 'npm test -- --no-coverage 2>&1 | tail -80'
    try {
      const hasPkg = await props.backend.send<{ok:boolean;content?:string}>('fs.read_file', {
        workspace_path: props.workspacePath, rel_path: 'package.json',
      })
      const pkg = JSON.parse(hasPkg.payload?.content ?? '{}') as Record<string, unknown>
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
      const deps = (pkg.dependencies ?? {}) as Record<string, string>
      if ('vitest' in devDeps || 'vitest' in deps) {
        testCmd = `npx vitest run ${extra} 2>&1 | tail -100`
      } else if (extra) {
        testCmd = `npm test -- ${extra} 2>&1 | tail -100`
      }
    } catch { /* keep default */ }
    inputText.value = ''
    messages.value.push({ role: 'user', content: `/test${extra ? ' ' + extra : ''}`, timestamp: Date.now() })
    showToast('Running tests…')
    try {
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: testCmd, workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const exitCode = r?.exit_code ?? 0
      const out = r?.output?.trim() ?? '(no output)'
      const status = exitCode === 0 ? '✓ Tests passed' : `✗ Tests failed (exit ${exitCode})`
      const content = `${status}\n\`\`\`\n${out}\n\`\`\``
      messages.value.push({ role: 'assistant', content, timestamp: Date.now() })
    } catch {
      messages.value.push({ role: 'assistant', content: 'Test command failed', isError: true, timestamp: Date.now() })
    }
    return
  }

  // /run <cmd> — execute shell command and add output as message
  if (rawText.startsWith('/run ')) {
    const cmd = rawText.slice('/run '.length).trim()
    if (!cmd) { showToast('Usage: /run <command>'); return }
    if (!props.workspacePath) { showToast('/run requires an open workspace'); return }
    if (!window.confirm(`Run in workspace?\n\n${cmd}`)) return
    inputText.value = ''
    messages.value.push({ role: 'user', content: `/run ${cmd}`, timestamp: Date.now() })
    try {
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: cmd, workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const out = r?.ok
        ? `\`\`\`\n${r.output ?? '(no output)'}\n\`\`\`\n_Exit code: ${r.exit_code ?? 0}_`
        : `Error: ${r?.error ?? 'unknown'}`
      messages.value.push({ role: 'assistant', content: out, timestamp: Date.now() })
    } catch { messages.value.push({ role: 'assistant', content: 'Command failed', isError: true, timestamp: Date.now() }) }
    return
  }

  followUps.value = []
  streamTickInterval = window.setInterval(() => { streamNow.value = Date.now() }, 500)

  // Build user content with context chips prepended
  const imageChips = contextChips.value.filter((c) => c.imageData)
  let textContent = ''
  for (const chip of contextChips.value) {
    if (!chip.imageData) textContent += `[Context: ${chip.label}]\n${chip.content}\n\n`
  }
  if (rawText) textContent += `[User]: ${rawText}`
  const displayText = rawText || contextChips.value.map((c) => c.label).join(' ')

  // If images are present, build a multimodal content array for Anthropic
  type ContentBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  let sentContent: string | ContentBlock[]
  if (imageChips.length > 0) {
    const blocks: ContentBlock[] = []
    for (const ic of imageChips) {
      const dataUrl = ic.imageData!
      const sep = dataUrl.indexOf(',')
      const meta = dataUrl.slice(5, sep)  // e.g. "image/png;base64"
      const mediaType = meta.split(';')[0]
      const b64 = dataUrl.slice(sep + 1)
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } })
    }
    if (textContent.trim()) blocks.push({ type: 'text', text: textContent })
    sentContent = blocks
  } else {
    sentContent = textContent || displayText
  }

  // Keep the in-memory list bounded so a very long session doesn't exhaust memory.
  if (messages.value.length >= MAX_MESSAGES) messages.value.splice(0, messages.value.length - MAX_MESSAGES + 1)
  messages.value.push({ role: 'user', content: displayText, rawContent: sentContent, timestamp: Date.now() })
  // Auto-name thread from first user message when still "New chat"
  const curThread = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (curThread && curThread.title === 'New chat' && rawText) {
    const stripped = rawText.replace(/^\/\S+\s*/, '').trim()
    const firstLine = (stripped || rawText).split('\n')[0].trim()
    curThread.title = firstLine.slice(0, 50) + (firstLine.length > 50 ? '…' : '')
  }
  // Keep pinned chips across sends; clear the rest
  contextChips.value = contextChips.value.filter((c) => c.pinned)
  if (rawText) {
    inputHistory.push(rawText)
    if (inputHistory.length > 50) inputHistory.shift()
    historyIdx = -1
    historySavedDraft = ''
  }
  inputText.value = ''
  sending.value = true

  const sessionId = crypto.randomUUID()
  currentSessionId.value = sessionId

  // Build messages history for backend — use rawContent so AI sees actual @chip content
  const history = messages.value.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.rawContent ?? m.content,
  }))
  history.push({ role: 'user', content: sentContent })

  // Push placeholder assistant message for streaming
  messages.value.push({ role: 'assistant', content: '', streaming: true, thinking: true, cards: [], model: settingsModel.value, timestamp: Date.now() })
  autoScroll.value = true
  await scrollBottom(true)

  try {
    const lengthHint = RESPONSE_LENGTH_HINTS[responseLength.value]
    await props.backend.send('ai.chat.start', {
      session_id: sessionId,
      messages: history,
      workspace_path: props.workspacePath,
      ...(lengthHint ? { system_suffix: lengthHint } : {}),
    })
  } catch {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false; last.thinking = false
      last.isError = true; last.errorMsg = 'Unable to connect to backend'
    }
    sending.value = false
    currentSessionId.value = null
  }
}

// ── Stop streaming ─────────────────────────────────────────────────────────────
function stopStreaming(): void {
  if (!sending.value) return
  props.backend.send('ai.chat.stop', { session_id: currentSessionId.value ?? '' }).catch(() => {/* ignore */})
  const last = messages.value[messages.value.length - 1]
  if (last?.streaming) { last.streaming = false; last.thinking = false }
  sending.value = false
  currentSessionId.value = null
  if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
}

// ── Clear conversation (clear current thread) ──────────────────────────────────
function clearConversation(): void {
  if (messages.value.length > 0 && !window.confirm('Clear all messages in this chat?')) return
  if (sending.value) stopStreaming()
  messages.value = []
  expandedMsgIdxs.value = new Set(); expandedDiffs.value = new Set()
  // Also reset the title so it auto-updates on next message
  const idx = allThreads.value.findIndex((t) => t.id === currentThreadId.value)
  if (idx !== -1) allThreads.value[idx].title = 'New chat'
  saveCurrentThread()
}

// ── Edit a previous user message (truncate history from that point) ────────────
function editMessage(idx: number): void {
  if (sending.value) stopStreaming()
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  // Put original display text back into the input box
  inputText.value = msg.content
  // Remove this message and everything after it
  messages.value.splice(idx)
  saveCurrentThread()
  nextTick(() => textareaEl.value?.focus())
}

// ── Fork conversation from a message (create a new thread from this point) ────
function forkFromMessage(idx: number): void {
  if (sending.value) return
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  // Save a new thread with messages UP TO (not including) this message
  const forkHistory = messages.value.slice(0, idx).filter((m) => !m.streaming)
  const baseTitle = (allThreads.value.find((t) => t.id === currentThreadId.value)?.title ?? 'Chat') + ' (fork)'
  const newThread: ChatThread = {
    id: crypto.randomUUID(),
    title: baseTitle.slice(0, 60),
    messages: forkHistory,
    updatedAt: Date.now(),
  }
  allThreads.value.unshift(newThread)
  saveCurrentThread()
  // Switch to the new thread with the forked message in the input box
  switchThread(newThread.id)
  inputText.value = msg.content
  nextTick(() => textareaEl.value?.focus())
  showToast('Forked to new chat')
}

// ── Copy message ───────────────────────────────────────────────────────────────
// ── Export conversation ────────────────────────────────────────────────────────
async function exportConversation(format: 'markdown' | 'json' = 'markdown'): Promise<void> {
  const msgs = messages.value.filter((m) => !m.streaming)
  if (msgs.length === 0) {
    showToast('No messages to export')
    return
  }
  let content: string
  let defaultName: string
  if (format === 'json') {
    const data = msgs.map((m) => ({ role: m.role, content: m.content, model: m.model, timestamp: m.timestamp }))
    content = JSON.stringify({ messages: data, exportedAt: new Date().toISOString() }, null, 2)
    defaultName = 'ai-chat-export.json'
  } else {
    let md = '# AI Chat Export\n\n'
    for (const msg of msgs) {
      const roleLabel = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` (${msg.model})` : ''}`
      md += `### ${roleLabel}\n\n${msg.content}\n\n---\n\n`
    }
    content = md
    defaultName = 'ai-chat-export.md'
  }
  try {
    const r = await window.agentTeam?.saveJson({ defaultName, content, title: 'Export chat' })
    if (r && !r.ok && !r.canceled) showToast('Export failed')
    else if (r?.ok) showToast('Chat exported')
  } catch { showToast('Export failed') }
}

function copyMessage(content: string): void {
  const plain = content.replace(/<[^>]+>/g, '')
  navigator.clipboard.writeText(plain).then(() => showToast('Copied')).catch(() => showToast('Copy failed'))
}

function quoteMessage(content: string): void {
  // Use window selection if present, else use first 300 chars of message
  const sel = window.getSelection()?.toString().trim() || ''
  const snippet = sel || content.replace(/```[\s\S]*?```/g, '[code block]').replace(/\n{3,}/g, '\n\n').trim().slice(0, 300)
  const quoted = snippet.split('\n').map((l) => `> ${l}`).join('\n')
  inputText.value = (inputText.value ? inputText.value + '\n\n' : '') + quoted + '\n\n'
  nextTick(() => {
    textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
  })
  showToast('Quoted — add your question below')
}

// ── Regenerate last AI response ────────────────────────────────────────────────
async function regenerate(): Promise<void> {
  if (sending.value) return
  // Find last user message index
  let lastUserIdx = -1
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return
  // Keep only up to and including the last user message
  messages.value = messages.value.slice(0, lastUserIdx + 1)
  sending.value = true

  const sessionId = crypto.randomUUID()
  currentSessionId.value = sessionId

  const history = messages.value.map((m) => ({ role: m.role, content: m.rawContent ?? m.content }))
  messages.value.push({ role: 'assistant', content: '', streaming: true, thinking: true, cards: [], model: settingsModel.value, timestamp: Date.now() })
  autoScroll.value = true
  await scrollBottom(true)

  try {
    await props.backend.send('ai.chat.start', {
      session_id: sessionId,
      messages: history,
      workspace_path: props.workspacePath,
    })
  } catch {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false; last.thinking = false
      last.isError = true; last.errorMsg = 'Unable to connect to backend'
    }
    sending.value = false
    currentSessionId.value = null
  }
}

// ── Retry after error ──────────────────────────────────────────────────────────
function retryAfterError(): void {
  // Remove the error assistant message and regenerate
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && last.isError) messages.value.pop()
  void regenerate()
}

const lastAssistantIdx = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') return i
  }
  return -1
})

// Active tool being executed during streaming (first pending tool_call card)
const activeToolCard = computed(() => {
  const idx = lastAssistantIdx.value
  if (idx === -1) return null
  const msg = messages.value[idx]
  if (!msg.streaming) return null
  for (let i = (msg.cards ?? []).length - 1; i >= 0; i--) {
    const c = msg.cards![i]
    if (c.kind === 'tool_call' && c.result == null) return c
  }
  return null
})

// ── Diff expand/collapse ──────────────────────────────────────────────────────
const expandedDiffs = ref(new Set<string>())
function isDiffExpanded(toolId: string): boolean { return expandedDiffs.value.has(toolId) }
function toggleDiff(toolId: string): void {
  if (expandedDiffs.value.has(toolId)) expandedDiffs.value.delete(toolId)
  else expandedDiffs.value.add(toolId)
  expandedDiffs.value = new Set(expandedDiffs.value)
}

const pendingEditsInLastMsg = computed<EditProposalCard[]>(() => {
  const idx = lastAssistantIdx.value
  if (idx === -1) return []
  const msg = messages.value[idx]
  return (msg.cards ?? []).filter((c): c is EditProposalCard =>
    c.kind === 'edit_proposal' && !c.accepted && !c.discarded,
  )
})

// ── Accept edit ────────────────────────────────────────────────────────────────
async function acceptEdit(card: EditProposalCard): Promise<void> {
  try {
    await props.backend.send('ai.chat.accept_edit', {
      workspace_path: props.workspacePath,
      file_path: card.file_path,
      new_content: card.new_content,
    })
    card.accepted = true
    showToast(`Applied: ${card.file_path}`)
  } catch {
    showToast('Apply failed')
  }
}

function discardEdit(card: EditProposalCard): void {
  card.discarded = true
}

async function acceptAllEdits(): Promise<void> {
  for (const card of pendingEditsInLastMsg.value) {
    await acceptEdit(card)
  }
}

function discardAllEdits(): void {
  for (const card of pendingEditsInLastMsg.value) {
    card.discarded = true
  }
}

// ── Command proposal ──────────────────────────────────────────────────────────
async function approveCommand(card: CommandProposalCard): Promise<void> {
  card.status = 'approved'
  await props.backend.send('ai.chat.approve_command', {
    session_id: currentSessionId.value ?? '',
    tool_id: card.tool_id,
  }).catch(() => { card.status = 'pending' })
}

async function rejectCommand(card: CommandProposalCard): Promise<void> {
  card.status = 'rejected'
  await props.backend.send('ai.chat.reject_command', {
    session_id: currentSessionId.value ?? '',
    tool_id: card.tool_id,
  }).catch(() => { card.status = 'pending' })
}

// ── Backend event listeners ────────────────────────────────────────────────────
let unsubChunk: (() => void) | null = null
let unsubToolCall: (() => void) | null = null
let unsubToolResult: (() => void) | null = null
let unsubCommandProposal: (() => void) | null = null
let unsubDone: (() => void) | null = null
let unsubError: (() => void) | null = null
let unsubSettingsGet: (() => void) | null = null

function setupListeners(): void {
  unsubChunk = props.backend.on('ai.chat.chunk', (payload) => {
    const p = payload as { session_id: string; text: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && last.streaming) {
      if (last.thinking) last.responseStartMs = Date.now()
      last.thinking = false
      last.content += p.text
      void scrollBottom()
    }
  })

  unsubToolCall = props.backend.on('ai.chat.tool_call', (payload) => {
    const p = payload as { session_id: string; tool_name: string; tool_input: unknown; tool_id: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.thinking = false
      if (!last.cards) last.cards = []
      last.cards.push({
        kind: 'tool_call',
        tool_id: p.tool_id,
        tool_name: p.tool_name,
        tool_input: p.tool_input,
        collapsed: false,
      })
      void scrollBottom()
    }
  })

  unsubToolResult = props.backend.on('ai.chat.tool_result', (payload) => {
    const p = payload as { session_id: string; tool_id: string; result: unknown }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (!last?.cards) return
    for (const card of last.cards) {
      if (card.tool_id === p.tool_id) {
        if (card.kind === 'tool_call') {
          const resultStr = typeof p.result === 'string'
            ? p.result
            : JSON.stringify(p.result)
          // Check if this is an edit_file result (backend returns JSON string)
          let resultObj: Record<string, unknown> | null = null
          if (card.tool_name === 'edit_file') {
            try {
              const parsed = typeof p.result === 'string' ? JSON.parse(p.result) : p.result
              if (parsed && typeof parsed === 'object') resultObj = parsed as Record<string, unknown>
            } catch { /* not JSON, treat as plain result */ }
          }
          if (
            resultObj !== null &&
            typeof resultObj.file_path === 'string' &&
            typeof resultObj.new_content === 'string'
          ) {
            // Replace tool_call card with edit_proposal card
            const idx = last.cards.indexOf(card)
            // Prefer the real unified diff from the backend (difflib); fall back to synthetic
            const diffStr = typeof resultObj.diff === 'string' && resultObj.diff
              ? resultObj.diff
              : makeDiff(resultObj.file_path, resultObj.new_content)
            const editCard: EditProposalCard = {
              kind: 'edit_proposal',
              tool_id: p.tool_id,
              file_path: resultObj.file_path,
              new_content: resultObj.new_content,
              diff: diffStr,
              accepted: false,
              discarded: false,
            }
            last.cards.splice(idx, 1, editCard)
            // Auto-accept mode: apply edit immediately without user confirmation
            if (settingsAutoAccept.value) {
              void acceptEdit(editCard)
            }
          } else {
            card.result = resultStr.slice(0, 200) + (resultStr.length > 200 ? '…' : '')
            card.collapsed = true
          }
          void scrollBottom()
        }
        break
      }
    }
  })

  unsubDone = props.backend.on('ai.chat.done', (payload) => {
    const p = payload as { session_id: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.streaming) {
      last.streaming = false; last.thinking = false
      if (last.responseStartMs) last.elapsedMs = Date.now() - last.responseStartMs
      followUps.value = extractFollowUps(last.content)
      // Detect conventional commit message in response
      const commitMatch = last.content.match(/^(?:```\w*\n?)?((?:feat|fix|chore|docs|style|refactor|test|perf|build|ci|revert)(?:\([^)]+\))?!?: .+)(?:\n|$)/m)
      if (commitMatch) last.commitMsg = commitMatch[1].trim()
    }
    // Auto-generate thread title from first user message
    const curThread = allThreads.value.find((t) => t.id === currentThreadId.value)
    if (curThread && curThread.title === 'New chat' && messages.value.length === 2) {
      const firstUser = messages.value[0]
      if (firstUser?.role === 'user' && firstUser.content.trim()) {
        const raw = firstUser.content.replace(/@\S+/g, '').trim()
        curThread.title = raw.length > 50 ? raw.slice(0, 47) + '…' : raw || 'New chat'
      }
    }
    sending.value = false
    currentSessionId.value = null
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
  })

  unsubError = props.backend.on('ai.chat.error', (payload) => {
    const p = payload as { session_id: string; message: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false
      last.thinking = false
      last.isError = true
      last.errorMsg = p.message
    }
    sending.value = false
    currentSessionId.value = null
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
    void scrollBottom()
  })

  unsubCommandProposal = props.backend.on('ai.chat.command_proposal', (payload) => {
    const p = payload as { session_id: string; tool_id: string; command: string; cwd: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      if (!last.cards) last.cards = []
      // Replace the matching tool_call card (if present) with a command_proposal card
      const existingIdx = last.cards.findIndex((c) => c.tool_id === p.tool_id)
      const card: CommandProposalCard = {
        kind: 'command_proposal',
        tool_id: p.tool_id,
        command: p.command,
        cwd: p.cwd,
        status: 'pending',
      }
      if (existingIdx !== -1) last.cards.splice(existingIdx, 1, card)
      else last.cards.push(card)
      void scrollBottom()
    }
  })

  unsubSettingsGet = props.backend.on('ai.chat.settings', (payload) => {
    const p = payload as {
      provider?: string; anthropic_api_key?: string; model?: string
      ollama_base_url?: string; system_prompt?: string; max_tokens?: number; temperature?: number
    }
    if (p.provider === 'anthropic' || p.provider === 'ollama') settingsProvider.value = p.provider
    if (p.anthropic_api_key) settingsApiKey.value = p.anthropic_api_key
    if (p.model) settingsModel.value = p.model
    if (p.ollama_base_url) settingsOllamaUrl.value = p.ollama_base_url
    // Use !== undefined so clearing system_prompt to "" is properly reflected in UI
    if (p.system_prompt !== undefined) settingsSystemPrompt.value = p.system_prompt
    if (p.max_tokens) settingsMaxTokens.value = p.max_tokens
    if (p.temperature !== undefined) settingsTemperature.value = p.temperature
  })
}

function teardownListeners(): void {
  unsubChunk?.()
  unsubToolCall?.()
  unsubToolResult?.()
  unsubCommandProposal?.()
  unsubDone?.()
  unsubError?.()
  unsubSettingsGet?.()
}

const workspaceRulesFile = ref<string | null>(null)

async function detectWorkspaceRules(): Promise<void> {
  const RULE_FILES = [
    '.cursor/rules', '.cursor/rules.md', 'AGENTS.md',
    '.ai/rules.md', '.ai/instructions.md', '.github/copilot-instructions.md',
  ]
  for (const rf of RULE_FILES) {
    try {
      interface ReadResp { ok: boolean; content?: string }
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: rf,
      })
      if (resp.payload?.ok && resp.payload.content) {
        workspaceRulesFile.value = rf
        return
      }
    } catch { /* file not found */ }
  }
  workspaceRulesFile.value = null
}

onMounted(() => {
  setupListeners()
  fetchSettings()
  loadThreads()
  void detectWorkspaceRules()
})
watch(() => props.workspacePath, () => { void detectWorkspaceRules() })
watch(() => props.backend.status.value, (s) => {
  if ((s === 'disconnected' || s === 'error') && sending.value) stopStreaming()
})

onUnmounted(() => {
  teardownListeners()
  if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
  if (toastTimer !== null) clearTimeout(toastTimer)
  if (saveTimer !== null) clearTimeout(saveTimer)
})

// ── @context system ────────────────────────────────────────────────────────────
function onTextareaInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  const val = el.value
  const cur = el.selectionStart ?? val.length
  const beforeCursor = val.slice(0, cur)

  // ── Slash command menu (/command at start of input) ───────────────────────
  if (val.startsWith('/') && !val.includes(' ')) {
    showAtMenu.value = false
    const fragment = val.slice(1).toLowerCase()
    slashMenuFilter.value = fragment
    slashMenuIdx.value = 0
    slashOptions.value = SLASH_COMMANDS.filter((c) => c.id.slice(1).startsWith(fragment))
    showSlashMenu.value = slashOptions.value.length > 0
    return
  }
  showSlashMenu.value = false

  // ── @ context menu ────────────────────────────────────────────────────────
  const atIdx = beforeCursor.lastIndexOf('@')
  if (atIdx === -1) { showAtMenu.value = false; return }

  const fragment = beforeCursor.slice(atIdx + 1)
  // Allow spaces only inside @codebase <query>
  const isCodebaseQuery = /^codebase\s+\S/i.test(fragment)
  const isFolderPath = /^folder:/i.test(fragment)
  if (fragment.includes(' ') && !isCodebaseQuery) { showAtMenu.value = false; return }

  atMenuFilter.value = fragment
  atMenuIdx.value = 0
  showAtMenu.value = true

  if (isCodebaseQuery) {
    const cbQuery = fragment.slice(fragment.indexOf(' ') + 1).trim()
    atOptions.value = [{ id: `@codebase:${cbQuery}`, label: `@codebase search: "${cbQuery}"` }]
    return
  }

  if (isFolderPath) {
    const folderPath = fragment.slice('folder:'.length).trim()
    atOptions.value = [{ id: `@folder:${folderPath}`, label: `@folder: "${folderPath}" (add all files)` }]
    return
  }

  const isUrlFragment = /^url:https?:\/\//i.test(fragment)
  if (isUrlFragment) {
    const urlVal = fragment.slice('url:'.length).trim()
    atOptions.value = [{ id: `@url:${urlVal}`, label: `@url: fetch "${urlVal.slice(0, 60)}"` }]
    return
  }

  // @symbol:functionName — find a symbol definition across the codebase
  const isSymbolQuery = /^symbol:/i.test(fragment)
  if (isSymbolQuery) {
    const symbolName = fragment.slice('symbol:'.length).trim()
    if (symbolName.length >= 1) {
      atOptions.value = [{ id: `@symbol:${symbolName}`, label: `@symbol: search for "${symbolName}"` }]
    } else {
      atOptions.value = [{ id: '@symbol', label: '@symbol — type a function or class name' }]
    }
    return
  }

  // @file:lineRange — e.g., @App.vue:10-50 or @src/foo.ts:25
  const lineRangeMatch = /^(.+):(\d+)(?:-(\d+))?$/.exec(fragment)
  if (lineRangeMatch) {
    const filePath = lineRangeMatch[1]
    const lineSpec = lineRangeMatch[3] ? `${lineRangeMatch[2]}-${lineRangeMatch[3]}` : lineRangeMatch[2]
    const fileName = filePath.split('/').pop() ?? filePath
    atOptions.value = [{ id: `${filePath}:${lineSpec}`, label: `@${fileName}:${lineSpec} — lines ${lineSpec}` }]
    return
  }

  const lower = fragment.toLowerCase()
  const filtered: AtOption[] = AT_OPTIONS_STATIC.filter(
    (o) => o.label.toLowerCase().includes(lower) || o.id.toLowerCase().includes(lower),
  )
  for (const item of atDirItems.value) {
    if (item.label.toLowerCase().includes(lower)) filtered.push(item)
  }
  // Prepend recent files when no query (or just '@')
  if (!lower || lower === '@') {
    const recent: AtOption[] = recentAtFiles.value
      .filter((f) => !filtered.some((d) => d.id === f))
      .map((f) => ({ id: f, label: `@${f.split('/').pop()} · recent` }))
      .slice(0, 5)
    atOptions.value = [...filtered, ...recent]
  } else {
    atOptions.value = filtered.length ? filtered : AT_OPTIONS_STATIC
  }

  if (fragment.length >= 1 && !fragment.startsWith('@')) {
    void searchFiles(fragment)
  }
}

function selectSlashCommand(cmd: SlashCommand): void {
  showSlashMenu.value = false
  if (cmd.id === '/run') {
    // Let user type the command after /run
    inputText.value = '/run '
    nextTick(() => { textareaEl.value?.focus() })
    return
  }
  if (cmd.id === '/summarize') {
    if (messages.value.length < 2) { showToast('Nothing to summarize yet'); return }
    const count = messages.value.length
    inputText.value = `Summarize our conversation so far (${count} messages) into 3-5 bullet points covering the main topics, decisions, and any code changes made. Be concise.`
    void sendMessage()
    return
  }
  if (cmd.id === '/clear') {
    inputText.value = ''
    clearConversation()
    return
  }
  if (cmd.id === '/export') {
    inputText.value = ''
    const fmt = window.confirm('Export as Markdown?\n\nOK = Markdown (.md)\nCancel = JSON (.json)') ? 'markdown' : 'json'
    void exportConversation(fmt as 'markdown' | 'json')
    return
  }
  // /commit: auto-add @git chip so AI sees the staged diff (falls back to unstaged)
  if (cmd.id === '/commit') {
    inputText.value = cmd.template
    void (async () => {
      try {
        interface DiffResp { ok: boolean; diff?: string }
        // Prefer staged diff (what git commit will actually include); fall back to unstaged
        let resp = await props.backend.send<DiffResp>('git.diff_all', {
          workspace_path: props.workspacePath,
          staged: true,
        })
        let diff = resp.payload?.diff
        let label = '@git(staged)'
        let header = '// git diff --staged'
        if (!diff) {
          resp = await props.backend.send<DiffResp>('git.diff_all', {
            workspace_path: props.workspacePath,
            staged: false,
          })
          diff = resp.payload?.diff
          label = '@git(diff)'
          header = '// git diff (unstaged)'
        }
        if (diff) {
          contextChips.value.push({
            id: crypto.randomUUID(),
            label,
            content: `${header}\n${diff}`,
          })
        }
      } catch {/* ignore */}
      await nextTick()
      textareaEl.value?.focus()
    })()
    return
  }
  // /diff: auto-add @git chip and set prompt
  if (cmd.id === '/diff') {
    inputText.value = 'Explain these changes and their potential impact on the codebase:'
    void (async () => {
      try {
        interface DiffResp { ok: boolean; diff?: string }
        let resp = await props.backend.send<DiffResp>('git.diff_all', {
          workspace_path: props.workspacePath,
          staged: true,
        })
        let diff = resp.payload?.diff
        let label = '@git(staged)'
        let header = '// git diff --staged'
        if (!diff) {
          resp = await props.backend.send<DiffResp>('git.diff_all', {
            workspace_path: props.workspacePath,
            staged: false,
          })
          diff = resp.payload?.diff
          label = '@git(diff)'
          header = '// git diff (unstaged)'
        }
        if (!diff) {
          showToast('No changes found'); return
        }
        contextChips.value.push({ id: crypto.randomUUID(), label, content: `${header}\n${diff}` })
      } catch { showToast('/diff: git unavailable') }
      await nextTick()
      textareaEl.value?.focus()
    })()
    return
  }

  inputText.value = cmd.template + ' '

  // Auto-inject current file chip for code-focused commands when no chip exists yet
  const CODE_CMDS = new Set(['/explain', '/fix', '/tests', '/doc', '/review', '/optimize', '/refactor', '/debug', '/improve'])
  if (CODE_CMDS.has(cmd.id) && contextChips.value.length === 0) {
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (relPath && content !== undefined) {
      const ext = relPath.split('.').pop() ?? ''
      const label = `@${relPath.split('/').pop()}`
      if (!contextChips.value.some((c) => c.label === label)) {
        contextChips.value.push({
          id: crypto.randomUUID(),
          label,
          content: `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``,
        })
      }
    }
  }

  nextTick(() => {
    textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
  })
}

async function searchFiles(query: string): Promise<void> {
  try {
    interface FlatResp { ok: boolean; files?: string[] }
    const lower = query.toLowerCase()
    const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
      workspace_path: props.workspacePath,
      query,
    })
    const files: string[] = resp.payload?.files ?? []
    const found: AtOption[] = files.map((f) => ({ id: f, label: `@${f}` }))

    atDirItems.value = found.slice(0, 15)
    const filtered: AtOption[] = [
      ...AT_OPTIONS_STATIC.filter((o) => o.label.toLowerCase().includes(lower)),
      ...atDirItems.value,
    ]
    atOptions.value = filtered.length ? filtered : AT_OPTIONS_STATIC
  } catch {
    // ignore
  }
}

async function selectAtOption(option: AtOption): Promise<void> {
  // Remove the @fragment from textarea
  const el = textareaEl.value
  if (!el) { showAtMenu.value = false; return }
  const val = el.value
  const cur = el.selectionStart ?? val.length
  const beforeCursor = val.slice(0, cur)
  const atIdx = beforeCursor.lastIndexOf('@')

  let chipLabel = ''
  let chipContent = ''

  if (option.id === '@file') {
    const relPath = props.getActiveRelPath?.() ?? ''
    const content = props.getEditorContent?.() ?? ''
    const ext = relPath.split('.').pop() ?? ''
    chipLabel = relPath ? `@${relPath.split('/').pop()}` : '@file'
    chipContent = relPath
      ? `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``
      : content
  } else if (option.id === '@selection') {
    const selected = props.getEditorSelection?.() ?? ''
    const relPath = props.getActiveRelPath?.() ?? ''
    const ext = relPath.split('.').pop() ?? ''
    chipLabel = '@selection'
    if (selected) {
      chipContent = relPath
        ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${selected}\n\`\`\``
        : selected
    } else {
      // Fall back to full file content when nothing is selected
      const content = props.getEditorContent?.() ?? ''
      chipContent = relPath
        ? `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``
        : content
    }
  } else if (option.id === '@git') {
    chipLabel = '@git'
    try {
      interface DiffResp { ok: boolean; diff?: string }
      const resp = await props.backend.send<DiffResp>('git.diff_all', {
        workspace_path: props.workspacePath,
        staged: false,
      })
      chipContent = resp.payload?.diff ? `// git diff (unstaged)\n${resp.payload.diff}` : '// git diff: no changes'
    } catch {
      chipContent = '// git diff: unavailable'
    }
  } else if (option.id === '@git:staged') {
    chipLabel = '@git:staged'
    try {
      interface DiffResp { ok: boolean; diff?: string }
      const resp = await props.backend.send<DiffResp>('git.diff_all', {
        workspace_path: props.workspacePath,
        staged: true,
      })
      chipContent = resp.payload?.diff ? `// git diff --cached (staged)\n${resp.payload.diff}` : '// git diff --cached: nothing staged'
    } catch {
      chipContent = '// @git:staged: unavailable'
    }
  } else if (option.id === '@git:log') {
    chipLabel = '@git:log'
    try {
      interface ShellResp { ok: boolean; output?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git log --oneline -20 2>&1',
        workspace_path: props.workspacePath,
      })
      const out = (resp.payload?.output ?? '').trim()
      chipContent = out ? `// git log (last 20 commits):\n${out}` : '// git log: no commits'
    } catch {
      chipContent = '// @git:log: unavailable'
    }
  } else if (option.id === '@git:branch') {
    chipLabel = '@git:branch'
    try {
      interface ShellResp { ok: boolean; output?: string }
      const branchResp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git branch --show-current 2>&1 && git log -1 --pretty="%h %s (%ar, %an)" 2>&1 && git status --short 2>&1 | head -20',
        workspace_path: props.workspacePath,
      })
      chipContent = (branchResp.payload?.output ?? '').trim()
        ? `// git branch info:\n${(branchResp.payload?.output ?? '').trim()}`
        : '// git branch: no info'
    } catch {
      chipContent = '// @git:branch: unavailable'
    }
  } else if (option.id === '@git:blame') {
    const relPath = props.getActiveRelPath?.()
    if (!relPath) {
      showToast('@git:blame requires an open file'); return
    }
    // Strict path validation: only safe chars, no .. segments, no leading -
    if (!/^[A-Za-z0-9_./-]+$/.test(relPath) || relPath.split('/').some(s => s === '..' || s === '' || s.startsWith('-'))) {
      showToast('Invalid file path for git blame'); return
    }
    chipLabel = `@git:blame(${relPath.split('/').pop()})`
    try {
      interface ShellResp { ok: boolean; output?: string }
      showToast('Running git blame…')
      const blameResp = await props.backend.send<ShellResp>('shell.run', {
        command: `git blame --line-porcelain -- "${relPath}" 2>&1 | grep -E "^(author |summary |[0-9a-f]{40} )" | awk '/^[0-9a-f]{40}/{h=$1} /^author /{a=substr($0,8)} /^summary /{s=substr($0,9); print h" "a": "s}' | sort -u | head -60`,
        workspace_path: props.workspacePath,
      })
      const out = (blameResp.payload?.output ?? '').trim()
      if (!out) {
        // Fallback: simple blame summary
        const fallback = await props.backend.send<ShellResp>('shell.run', {
          command: `git blame --date=short -- "${relPath}" 2>&1 | head -80`,
          workspace_path: props.workspacePath,
        })
        chipContent = (fallback.payload?.output ?? '').trim()
          ? `// git blame: ${relPath}\n${(fallback.payload?.output ?? '').trim()}`
          : `// git blame: ${relPath}: no history`
      } else {
        chipContent = `// git blame summary: ${relPath}\n// (unique commit→author→message)\n${out}`
      }
    } catch {
      chipContent = `// @git:blame: unavailable`
    }
  } else if (option.id === '@codebase') {
    // Static option selected without a query — replace with a prompt hint in input
    const newVal = val.slice(0, atIdx) + '@codebase ' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    // Position cursor after '@codebase '
    const pos = atIdx + '@codebase '.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@codebase:')) {
    const query = option.id.slice('@codebase:'.length)
    chipLabel = `@codebase:${query}`
    try {
      interface SearchMatch { line: number; col: number; text: string }
      interface SearchResp { ok: boolean; results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
      const resp = await props.backend.send<SearchResp>('search.find_in_files', {
        workspace_path: props.workspacePath,
        query,
        is_regex: false,
        case_sensitive: false,
        max_results: 30,
      })
      const results = resp.payload?.results ?? []
      if (results.length === 0) {
        chipContent = `// @codebase search "${query}": no results`
      } else {
        chipContent = `// @codebase search "${query}" — ${results.length} files\n`
        for (const r of results.slice(0, 8)) {
          chipContent += `\n// ${r.rel_path}\n`
          for (const m of r.matches.slice(0, 5)) {
            chipContent += `${m.line}: ${m.text}\n`
          }
        }
      }
    } catch {
      chipContent = `// @codebase search "${query}": unavailable`
    }
  } else if (option.id === '@folder') {
    // Prompt user to specify a sub-directory by rewriting textarea
    const newVal = val.slice(0, atIdx) + '@folder:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@folder:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@folder:')) {
    const folderPath = option.id.slice('@folder:'.length).trim()
    chipLabel = `@folder:${folderPath}`
    try {
      interface FlatResp { ok: boolean; files?: string[] }
      const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
        workspace_path: props.workspacePath,
        query: '',
      })
      const allFiles = resp.payload?.files ?? []
      // Filter to files under the specified folder
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/'
      const matching = allFiles.filter((f) => f.startsWith(prefix) || f.startsWith(folderPath + '/') || f === folderPath)
      if (matching.length === 0) {
        chipContent = `// @folder:${folderPath}: no files found`
      } else {
        const MAX_FILES = 10
        const taken = matching.slice(0, MAX_FILES)
        const results: string[] = []
        for (const filePath of taken) {
          try {
            interface ReadResp { ok: boolean; content?: string }
            const fr = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: filePath })
            const ext = filePath.split('.').pop() ?? ''
            results.push(`// ${filePath}\n\`\`\`${ext}\n${(fr.payload?.content ?? '').slice(0, 2000)}\n\`\`\``)
          } catch { /* skip unreadable files */ }
        }
        chipContent = `// @folder:${folderPath} (${taken.length} files${matching.length > MAX_FILES ? `, showing ${MAX_FILES}` : ''})\n\n${results.join('\n\n')}`
      }
    } catch {
      chipContent = `// @folder:${folderPath}: unavailable`
    }
  } else if (option.id === '@problems') {
    chipLabel = '@problems'
    if (!props.workspacePath) {
      chipContent = '// @problems: no workspace open'
    } else {
      try {
        showToast('Running type check…')
        interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
        const resp = await props.backend.send<ShellResp>('shell.run', {
          command: 'npx vue-tsc --noEmit 2>&1 | head -120',
          workspace_path: props.workspacePath,
        })
        const out = (resp.payload?.output ?? '').trim()
        if (!out || resp.payload?.exit_code === 0) {
          chipContent = '// @problems: no TypeScript errors found ✓'
        } else {
          chipContent = `// TypeScript errors in workspace:\n${out}`
        }
      } catch {
        chipContent = '// @problems: type check unavailable'
      }
    }
  } else if (option.id === '@url') {
    // Prompt user to type URL by rewriting textarea
    const newVal = val.slice(0, atIdx) + '@url:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@url:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@url:')) {
    const url = option.id.slice('@url:'.length).trim()
    chipLabel = `@url:${url.replace(/^https?:\/\//, '').slice(0, 40)}`
    // Validate: only allow http/https and reject obviously private/internal hosts
    let parsedUrl: URL
    try { parsedUrl = new URL(url) } catch { chipContent = '// @url: invalid URL'; /* falls through */ parsedUrl = null as unknown as URL }
    if (!parsedUrl) {
      // chipContent already set above
    } else if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      chipContent = '// @url: only http/https URLs are allowed'
    } else {
      const host = parsedUrl.hostname.toLowerCase()
      const BLOCKED = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.6[4-9]\.|100\.[7-9]\d\.|fc00:|fe80:)/
      if (BLOCKED.test(host)) {
        chipContent = `// @url: private/internal addresses are not allowed (${host})`
      } else {
        try {
          showToast('Fetching URL…')
          // redirect:'error' prevents server redirect bypassing host allowlist
          const resp = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
          // Stream body with hard 256 KB cap — Content-Length is untrustworthy
          const reader = resp.body?.getReader()
          let bodyText = ''
          if (reader) {
            let total = 0
            const dec = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > 262_144) { await reader.cancel(); bodyText = ''; break }
              bodyText += dec.decode(value, { stream: true })
            }
          }
          if (!bodyText) {
            chipContent = '// @url: response too large or unreadable (limit 256 KB)'
          } else {
            const text = bodyText
            // Use DOMParser for proper HTML-to-text (handles entities, avoids regex bypass)
            const doc = new DOMParser().parseFromString(text.slice(0, 512_000), 'text/html')
            doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove())
            // Normalize invisible/bidi override Unicode that could be used for prompt injection
            const raw = (doc.body?.textContent ?? doc.documentElement.textContent ?? '')
              .replace(/[ ---​-‏‪-‮﻿]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim()
              .slice(0, 4000)
              // Prevent escaping the untrusted fence tag
              .replace(/<\/?untrusted_web_content[^>]*>/gi, '')
            chipContent = `<untrusted_web_content url="${url}">\n${raw}\n</untrusted_web_content>`
          }
        } catch {
          chipContent = `// @url: failed to fetch ${url}`
        }
      }
    }
  } else if (option.id === '@clipboard') {
    chipLabel = '@clipboard'
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        showToast('Clipboard is empty'); return
      }
      chipContent = `// Clipboard content:\n${text.slice(0, 5000)}`
    } catch {
      chipContent = '// @clipboard: read failed (check browser permissions)'
    }
  } else if (option.id === '@tree') {
    chipLabel = '@tree'
    if (!props.workspacePath) {
      chipContent = '// @tree: no workspace open'
    } else {
      try {
        interface FlatResp { ok: boolean; files?: string[] }
        const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
          workspace_path: props.workspacePath,
          query: '',
        })
        const files = (resp.payload?.files ?? []).slice(0, 300)
        // Build tree string from flat file list
        const tree = buildFileTree(files)
        chipContent = `// Workspace file tree:\n${tree}`
      } catch {
        chipContent = '// @tree: unavailable'
      }
    }
  } else if (option.id === '@symbol') {
    // Prompt user to type symbol name
    const newVal = val.slice(0, atIdx) + '@symbol:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@symbol:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@symbol:')) {
    const symbolName = option.id.slice('@symbol:'.length).trim()
    chipLabel = `@symbol:${symbolName}`
    if (!props.workspacePath) {
      chipContent = '// @symbol: no workspace open'
    } else {
      try {
        showToast(`Searching for "${symbolName}"…`)
        interface SearchMatch { line: number; col: number; text: string }
        interface SearchResp { ok: boolean; results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
        // Search for function/class/const definitions containing the symbol name
        const resp = await props.backend.send<SearchResp>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query: symbolName,
          is_regex: false,
          case_sensitive: true,
          max_results: 20,
        })
        const results = resp.payload?.results ?? []
        // Filter to definition-looking lines (function/class/const/type/export)
        const DEF_RE = /^\s*(export\s+)?(default\s+)?(function|class|const|let|var|type|interface|def|async\s+function)\s/
        const defs: Array<{ path: string; line: number; text: string }> = []
        for (const r of results) {
          for (const m of r.matches) {
            if (DEF_RE.test(m.text) || m.text.includes(`${symbolName}(`)) {
              defs.push({ path: r.rel_path, line: m.line, text: m.text.trim() })
            }
          }
        }
        if (defs.length === 0) {
          chipContent = `// @symbol:${symbolName}: no definition found\n// (tried: function/class/const patterns)\n// Raw matches: ${results.length} files`
        } else {
          // For each definition, read context (10 lines around it)
          const parts: string[] = []
          for (const d of defs.slice(0, 4)) {
            try {
              interface ReadResp { ok: boolean; content?: string }
              const fr = await props.backend.send<ReadResp>('fs.read_file', {
                workspace_path: props.workspacePath,
                rel_path: d.path,
              })
              const allLines = (fr.payload?.content ?? '').split('\n')
              const start = Math.max(0, d.line - 2)
              const end = Math.min(allLines.length, d.line + 20)
              const ext = d.path.split('.').pop() ?? ''
              parts.push(`// ${d.path}:${d.line}\n\`\`\`${ext}\n${allLines.slice(start, end).join('\n')}\n\`\`\``)
            } catch { parts.push(`// ${d.path}:${d.line}\n${d.text}`) }
          }
          chipContent = `// @symbol:${symbolName} — ${defs.length} definition(s)\n\n${parts.join('\n\n')}`
        }
      } catch {
        chipContent = `// @symbol:${symbolName}: unavailable`
      }
    }
  } else if (/^[^@].+:\d+(?:-\d+)?$/.test(option.id)) {
    // @file:lineRange — e.g., "src/App.vue:10-50"
    const lineMatch = /^(.+):(\d+)(?:-(\d+))?$/.exec(option.id)!
    const filePath = lineMatch[1]
    const startLine = parseInt(lineMatch[2]) - 1
    const endLine = lineMatch[3] ? parseInt(lineMatch[3]) - 1 : startLine
    const lineSpec = lineMatch[3] ? `${lineMatch[2]}-${lineMatch[3]}` : lineMatch[2]
    chipLabel = `@${filePath.split('/').pop()}:${lineSpec}`
    try {
      interface ReadResp { ok: boolean; content?: string }
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: filePath,
      })
      const allLines = (resp.payload?.content ?? '').split('\n')
      const sliced = allLines.slice(startLine, endLine + 1)
      const ext = filePath.split('.').pop() ?? ''
      chipContent = `// ${filePath} (lines ${lineSpec})\n\`\`\`${ext}\n${sliced.join('\n')}\n\`\`\``
    } catch {
      chipContent = `// ${filePath}:${lineSpec}\n(unable to read)`
    }
  } else {
    // It's a file path
    chipLabel = `@${option.id.split('/').pop()}`
    // Fetch file content
    try {
      interface ReadResp { ok: boolean; content?: string }
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: option.id,
      })
      chipContent = `// ${option.id}\n${resp.payload?.content ?? ''}`
    } catch {
      chipContent = `// ${option.id}\n(unable to read)`
    }
  }

  if (contextChips.value.some((c) => c.label === chipLabel)) return
  contextChips.value.push({ id: crypto.randomUUID(), label: chipLabel, content: chipContent })

  // Remove @fragment from textarea
  const newVal = val.slice(0, atIdx) + val.slice(cur)
  inputText.value = newVal
  showAtMenu.value = false

  await nextTick()
  el.focus()
}

function removeChip(id: string): void {
  contextChips.value = contextChips.value.filter((c) => c.id !== id)
}

// ── Drag & drop file → context chip ──────────────────────────────────────────
const isDraggingOver = ref(false)

function onDragover(e: DragEvent): void {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
    isDraggingOver.value = true
  }
}
function onDragleave(): void { isDraggingOver.value = false }

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  isDraggingOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  for (const file of files.slice(0, 5)) {
    // Electron exposes the real absolute path via getPathForFile
    const absPath = window.agentTeam?.getPathForFile(file) ?? ''
    // Compute path relative to workspace
    const sep = props.workspacePath.endsWith('/') ? '' : '/'
    const prefix = props.workspacePath + sep
    const relPath = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath
    if (!relPath) continue
    try {
      interface ReadResp { ok: boolean; content?: string }
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: relPath,
      })
      const label = `@${relPath.split('/').pop()}`
      const ext = relPath.split('.').pop() ?? ''
      if (contextChips.value.some((c) => c.label === label)) continue
      const fileContent = (resp.payload?.content ?? '').slice(0, 50_000)
      contextChips.value.push({
        id: crypto.randomUUID(),
        label,
        content: `// File: ${relPath}\n\`\`\`${ext}\n${fileContent}\n\`\`\``,
      })
    } catch {
      showToast(`Unable to read: ${relPath}`)
    }
  }
}

async function onTextareaPaste(e: ClipboardEvent): Promise<void> {
  const items = Array.from(e.clipboardData?.items ?? [])
  const imageItem = items.find((it) => it.type.startsWith('image/'))
  if (!imageItem) return
  e.preventDefault()
  const file = imageItem.getAsFile()
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    const chipCount = contextChips.value.filter((c) => c.imageData).length + 1
    contextChips.value.push({
      id: crypto.randomUUID(),
      label: `@image${chipCount > 1 ? chipCount : ''}`,
      content: `[Image pasted: ${file.type}, ${Math.round(file.size / 1024)}KB]`,
      imageData: dataUrl,
    })
    showToast('Image added as context')
  }
  reader.readAsDataURL(file)
}

function onTextareaKeydown(e: KeyboardEvent): void {
  if (showSlashMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashMenuIdx.value = (slashMenuIdx.value + 1) % slashOptions.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashMenuIdx.value = (slashMenuIdx.value - 1 + slashOptions.value.length) % slashOptions.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const cmd = slashOptions.value[slashMenuIdx.value]
      if (cmd) selectSlashCommand(cmd)
      return
    }
    if (e.key === 'Escape') {
      showSlashMenu.value = false
      return
    }
  }

  if (showAtMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      atMenuIdx.value = (atMenuIdx.value + 1) % atOptions.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      atMenuIdx.value = (atMenuIdx.value - 1 + atOptions.value.length) % atOptions.value.length
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = atOptions.value[atMenuIdx.value]
      if (opt) void selectAtOption(opt)
      return
    }
    if (e.key === 'Escape') {
      showAtMenu.value = false
      return
    }
  }

  if (e.key === 'Escape' && previewChipId.value) {
    previewChipId.value = null
    return
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendMessage()
  }
  // Prompt history: Up/Down arrow when not in menus
  if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const el = textareaEl.value
    if (el && inputHistory.length > 0 && el.selectionStart === 0) {
      e.preventDefault()
      if (historyIdx === -1) {
        historySavedDraft = inputText.value  // save draft before first navigation
        historyIdx = inputHistory.length - 1
      } else if (historyIdx > 0) historyIdx--
      inputText.value = inputHistory[historyIdx]
      nextTick(() => { if (el) { el.selectionStart = el.selectionEnd = el.value.length } })
    }
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !e.ctrlKey && !e.metaKey && historyIdx >= 0) {
    e.preventDefault()
    if (historyIdx < inputHistory.length - 1) {
      historyIdx++
      inputText.value = inputHistory[historyIdx]
    } else {
      historyIdx = -1
      inputText.value = historySavedDraft  // restore the draft that was in progress
      historySavedDraft = ''
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    openSearch()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault()
    newThread()
  }
  // Ctrl+Shift+K — clear current conversation
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    clearConversation()
  }
  // Ctrl+Shift+A — add current file as @file context chip
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('No file open'); return }
    const content = props.getEditorContent?.() ?? ''
    const fileName = relPath.split('/').pop() ?? relPath
    if (content && !contextChips.value.some((c) => c.label.includes(fileName))) {
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${fileName}`, content: `// File: ${relPath}\n${content}` })
      showToast(`Added @${fileName} to context`)
    }
  }
  // Ctrl+Enter — regenerate last AI response (when not sending)
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !sending.value && !e.shiftKey) {
    if (inputText.value.trim() === '' && lastAssistantIdx.value >= 0) {
      e.preventDefault()
      void regenerate()
    }
  }
}

// Auto-resize textarea
watch(inputText, async () => {
  await nextTick()
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
})

// Close @ / slash menus on click outside
function onClickOutside(e: MouseEvent): void {
  if (atMenuEl.value && !atMenuEl.value.contains(e.target as Node)) {
    showAtMenu.value = false
  }
  if (slashMenuEl.value && !slashMenuEl.value.contains(e.target as Node)) {
    showSlashMenu.value = false
  }
  const modelBar = document.querySelector('.ai-model-bar')
  if (modelBar && !modelBar.contains(e.target as Node)) {
    showModelPicker.value = false
  }
}

onMounted(() => document.addEventListener('click', onClickOutside))
onUnmounted(() => document.removeEventListener('click', onClickOutside))

defineExpose({
  focusInput: () => { textareaEl.value?.focus() },
  addContextChip: (label: string, content: string) => {
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content })
    }
    void nextTick(() => textareaEl.value?.focus())
  },
})

// ── Copy all messages to clipboard ────────────────────────────────────────────
function copyAllMessages(): void {
  const msgs = messages.value.filter((m) => !m.streaming && m.content)
  if (!msgs.length) { showToast('No messages to copy'); return }
  let md = ''
  for (const m of msgs) {
    const label = m.role === 'user' ? '**You**' : `**AI**${m.model ? ` (${m.model})` : ''}`
    md += `${label}:\n${m.content}\n\n---\n\n`
  }
  navigator.clipboard.writeText(md.trim()).then(() => showToast('Conversation copied')).catch(() => showToast('Copy failed'))
}

// ── Message bookmarks ─────────────────────────────────────────────────────────
function toggleBookmark(mi: number): void {
  const msg = messages.value[mi]
  if (msg) { msg.bookmarked = !msg.bookmarked; saveCurrentThread() }
}

// ── Message feedback ──────────────────────────────────────────────────────────
function toggleFeedback(mi: number, type: 'up' | 'down'): void {
  const msg = messages.value[mi]
  if (!msg) return
  msg.feedback = msg.feedback === type ? undefined : type
  saveCurrentThread()
}

// ── Message date separators ────────────────────────────────────────────────────
function showDateSep(mi: number): boolean {
  const ts = messages.value[mi]?.timestamp
  if (!ts) return false
  if (mi === 0) return true
  const prevTs = messages.value[mi - 1]?.timestamp
  if (!prevTs) return true
  return new Date(ts).toDateString() !== new Date(prevTs).toDateString()
}
function getDateLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="ai-chat">
    <!-- Messages list -->
    <div ref="messagesEl" class="ai-messages" @click="onMessagesClick" @scroll.passive="onMessagesScroll">
      <div v-if="messages.length === 0" class="ai-empty">
        <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" style="opacity:.3">
          <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
        </svg>
        <p class="ai-empty-title">AI assistant ready</p>
        <p class="ai-empty-hint">@ to add context &nbsp;·&nbsp; / for commands &nbsp;·&nbsp; Enter to send</p>
        <div class="ai-empty-suggestions">
          <button class="ai-empty-btn" @click="inputText = '/explain '; nextTick(() => textareaEl?.focus())">/explain — explain code</button>
          <button class="ai-empty-btn" @click="inputText = '/fix '; nextTick(() => textareaEl?.focus())">/fix — find and fix issues</button>
          <button class="ai-empty-btn" @click="inputText = '/tests '; nextTick(() => textareaEl?.focus())">/tests — generate unit tests</button>
          <button class="ai-empty-btn" @click="inputText = '/review '; nextTick(() => textareaEl?.focus())">/review — code review</button>
        </div>
      </div>

      <template v-for="(msg, mi) in messages" :key="mi">
        <!-- Date separator -->
        <div v-if="msg.timestamp && showDateSep(mi)" class="ai-date-sep">
          <span class="ai-date-sep-label">{{ getDateLabel(msg.timestamp) }}</span>
        </div>
      <div
        class="ai-msg-wrap ai-msg"
        :class="[msg.role, { 'search-match': isSearchMatch(mi), 'search-active': isSearchActive(mi) }]"
      >
        <!-- Bubble -->
        <div class="ai-bubble" :class="msg.role">
          <!-- Text content -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-if="msg.content"
            class="ai-text"
            :class="{ 'ai-text-folded': isMsgFolded(mi, msg.content) }"
            v-html="renderWithSearchHighlight(msg.content)"
          />
          <button
            v-if="msg.content && !msg.streaming && msg.content.split('\n').length > MSG_FOLD_LINE_THRESHOLD"
            class="ai-fold-btn"
            @click="toggleMsgFold(mi)"
          >{{ isMsgFolded(mi, msg.content) ? `▼ Show more (${msg.content.split('\n').length} lines)` : '▲ Show less' }}</button>

          <!-- Cards (tool calls / edit proposals) -->
          <template v-if="msg.cards">
            <template v-for="(card, ci) in msg.cards" :key="ci">
              <!-- Tool call card -->
              <div v-if="card.kind === 'tool_call'" class="ai-tool-card" :class="{ 'ai-tool-pending': card.result == null }">
                <div class="ai-tool-header" @click="card.collapsed = !card.collapsed">
                  <span class="ai-tool-icon">{{ getToolIcon(card.tool_name) }}</span>
                  <span class="ai-tool-name">{{ getToolSummary(card.tool_name, card.tool_input) }}</span>
                  <span v-if="card.result == null" class="ai-tool-spinner" />
                  <span v-else class="ai-tool-done">✓</span>
                  <span class="ai-tool-toggle">{{ card.collapsed ? '▶' : '▼' }}</span>
                </div>
                <div v-if="!card.collapsed" class="ai-tool-body">
                  <pre class="ai-tool-pre">{{ JSON.stringify(card.tool_input, null, 2) }}</pre>
                  <div v-if="card.result != null" class="ai-tool-result">
                    <span class="ai-tool-result-label">Result: </span>{{ card.result }}
                  </div>
                </div>
              </div>

              <!-- Command proposal card -->
              <div v-else-if="card.kind === 'command_proposal'" class="ai-cmd-card" :class="card.status">
                <div class="ai-cmd-header">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>
                  <span class="ai-cmd-label">Run command</span>
                  <span v-if="card.status === 'approved'" class="ai-cmd-status approved">Executed ✓</span>
                  <span v-else-if="card.status === 'rejected'" class="ai-cmd-status rejected">Rejected ✕</span>
                  <div v-else class="ai-cmd-actions">
                    <button class="ai-cmd-btn approve" @click="approveCommand(card)">Run</button>
                    <button class="ai-cmd-btn reject" @click="rejectCommand(card)">Reject</button>
                  </div>
                </div>
                <pre class="ai-cmd-pre">$ {{ card.command }}{{ card.cwd ? `\n# cwd: ${card.cwd}` : '' }}</pre>
              </div>

              <!-- Edit proposal card -->
              <div v-else-if="card.kind === 'edit_proposal' && !card.discarded" class="ai-edit-card">
                <div class="ai-edit-header" @click="toggleDiff(card.tool_id)" style="cursor:pointer">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
                  <span class="ai-edit-path">{{ card.file_path }}</span>
                  <span class="ai-diff-stat">
                    <span class="diff-add-count">+{{ card.diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length }}</span>
                    <span class="diff-del-count"> −{{ card.diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length }}</span>
                  </span>
                  <span class="ai-diff-toggle-icon">{{ isDiffExpanded(card.tool_id) ? '▾' : '▸' }}</span>
                  <div v-if="!card.accepted" class="ai-edit-actions" @click.stop>
                    <button class="ai-edit-btn accept" @click="acceptEdit(card)">Accept</button>
                    <button class="ai-edit-btn discard" @click="discardEdit(card)">Discard</button>
                  </div>
                  <span v-else class="ai-edit-accepted">Applied ✓</span>
                </div>
                <div v-if="isDiffExpanded(card.tool_id)" class="ai-diff-view" v-html="renderDiff(card.diff)" />
              </div>
            </template>
          </template>

          <!-- Thinking indicator (before first chunk) -->
          <div v-if="msg.thinking" class="ai-thinking">
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-label">Thinking…</span>
          </div>
          <span v-else-if="msg.streaming" class="ai-cursor">▍</span>
          <span v-if="msg.streaming && msg.content.length > 0" class="ai-stream-tokens">
            ~{{ Math.ceil(msg.content.length / 4) }}t
            <template v-if="msg.responseStartMs && streamNow - msg.responseStartMs > 500">
              · {{ Math.round(Math.ceil(msg.content.length / 4) / ((streamNow - msg.responseStartMs) / 1000)) }}t/s
            </template>
          </span>

          <!-- Error card -->
          <div v-if="msg.isError" class="ai-error-card">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">
              <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
            </svg>
            <span class="ai-error-msg">{{ msg.errorMsg || 'An error occurred' }}</span>
            <button class="ai-error-retry" @click="retryAfterError">Retry</button>
          </div>
        </div>
        <!-- Detected commit message — show "Run Commit" button -->
        <div v-if="msg.role === 'assistant' && msg.commitMsg && !msg.streaming" class="ai-commit-action">
          <span class="ai-commit-msg-preview">{{ msg.commitMsg }}</span>
          <button class="ai-commit-run-btn" title="Run git commit with this message" @click="runCommit(msg)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z"/></svg>
            Run git commit
          </button>
        </div>
        <!-- Accept All / Reject All bar for last assistant message -->
        <div
          v-if="msg.role === 'assistant' && mi === lastAssistantIdx && pendingEditsInLastMsg.length >= 2"
          class="ai-bulk-actions"
        >
          <button class="ai-bulk-btn accept" @click="acceptAllEdits">Accept All ({{ pendingEditsInLastMsg.length }})</button>
          <button class="ai-bulk-btn discard" @click="discardAllEdits">Reject All</button>
        </div>
        <!-- Message action bar (copy / regenerate / model badge) -->
        <div class="ai-msg-actions" :class="msg.role">
          <span v-if="msg.role === 'assistant' && msg.model" class="ai-model-badge">{{ msg.model }}</span>
          <button
            v-if="msg.role === 'user' && !sending"
            class="ai-msg-action-btn"
            title="Edit & resend"
            @click="editMessage(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'user' && !sending && mi > 0"
            class="ai-msg-action-btn"
            title="Fork — continue from here in a new chat"
            @click="forkFromMessage(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878Zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>
          </button>
          <button class="ai-msg-action-btn" title="Copy" @click="copyMessage(msg.content)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && mi === lastAssistantIdx && !sending"
            class="ai-msg-action-btn"
            title="Regenerate"
            @click="regenerate"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && !msg.streaming"
            class="ai-msg-action-btn"
            title="Quote selected text (or full message) in input"
            @click="quoteMessage(msg.content)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2a1 1 0 0 1 1 1v1h1a1 1 0 0 1 0 2h-1v6h1a1 1 0 0 1 0 2h-1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1H2a1 1 0 0 1 0-2h1V6H2a1 1 0 0 1 0-2h1V3a1 1 0 0 1 1-1h8Zm-1 2H5v8h6V4Zm-4 2a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3A.5.5 0 0 1 7 6Zm2 0a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3A.5.5 0 0 1 9 6Z"/></svg>
          </button>
          <template v-if="msg.role === 'assistant' && !msg.streaming">
            <button
              class="ai-msg-action-btn ai-feedback-btn"
              :class="{ 'ai-feedback-up': msg.feedback === 'up' }"
              title="Good response"
              @click="toggleFeedback(mi, 'up')"
            >👍</button>
            <button
              class="ai-msg-action-btn ai-feedback-btn"
              :class="{ 'ai-feedback-down': msg.feedback === 'down' }"
              title="Bad response"
              @click="toggleFeedback(mi, 'down')"
            >👎</button>
          </template>
          <button
            class="ai-msg-action-btn"
            :class="{ 'ai-bookmark-active': msg.bookmarked }"
            :title="msg.bookmarked ? 'Remove bookmark' : 'Bookmark'"
            @click="toggleBookmark(mi)"
          >{{ msg.bookmarked ? '★' : '☆' }}</button>
          <span v-if="msg.elapsedMs" class="ai-msg-elapsed">{{ (msg.elapsedMs / 1000).toFixed(1) }}s</span>
          <span v-if="msg.role === 'assistant' && !msg.streaming && msg.content.length > 100" class="ai-msg-elapsed">~{{ Math.ceil(msg.content.length / 4).toLocaleString() }}t</span>
          <span v-if="msg.timestamp" class="ai-msg-time">
            {{ new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
          </span>
        </div>
        <span v-if="msg.bookmarked" class="ai-bookmark-indicator" title="Bookmarked">★</span>
      </div>
      </template>
    </div>

    <!-- Scroll-to-bottom button (shown when user has scrolled up during streaming) -->
    <button
      v-if="sending && !autoScroll"
      class="ai-scroll-to-bottom"
      title="Scroll to bottom"
      @click="autoScroll = true; scrollBottom(true)"
    >
      ↓ Scroll to bottom
    </button>

    <!-- Active tool status banner -->
    <div v-if="activeToolCard" class="ai-active-tool-banner">
      <span class="ai-active-tool-icon">{{ getToolIcon(activeToolCard.tool_name) }}</span>
      <span class="ai-active-tool-text">{{ getToolSummary(activeToolCard.tool_name, activeToolCard.tool_input) }}</span>
      <span class="ai-active-tool-spinner" />
    </div>

    <!-- Follow-up suggestions -->
    <div v-if="followUps.length && !sending" class="ai-followups">
      <button
        v-for="(q, qi) in followUps"
        :key="qi"
        class="ai-followup-btn"
        @click="inputText = q; followUps = []; nextTick(() => textareaEl?.focus())"
      >{{ q }}</button>
    </div>

    <!-- Search bar -->
    <div v-if="showSearch" class="ai-search-bar">
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="ai-search-input"
        placeholder="Search chat…"
        @keydown.escape="closeSearch"
        @keydown.enter.prevent="searchNav(1)"
      />
      <span class="ai-search-count">
        {{ searchMatches.length ? `${searchMatchIdx + 1}/${searchMatches.length}` : 'No results' }}
      </span>
      <button class="ai-search-nav" title="Previous" @click="searchNav(-1)">↑</button>
      <button class="ai-search-nav" title="Next" @click="searchNav(1)">↓</button>
      <button class="ai-search-close" @click="closeSearch">✕</button>
    </div>

    <!-- Input area -->
    <div
      class="ai-input-area"
      :class="{ 'ai-drop-active': isDraggingOver }"
      @dragover="onDragover"
      @dragleave="onDragleave"
      @drop="onDrop"
    >
      <!-- Context chips -->
      <div v-if="contextChips.length" class="ai-chips">
        <span
          v-for="chip in contextChips"
          :key="chip.id"
          class="ai-chip"
          :class="{ 'ai-chip-active': previewChipId === chip.id, 'ai-chip-image': !!chip.imageData, 'ai-chip-pinned': chip.pinned }"
          @click.stop="previewChipId = previewChipId === chip.id ? null : chip.id"
        >
          <img v-if="chip.imageData" :src="chip.imageData" class="ai-chip-thumb" alt="pasted image" />
          {{ chip.label }}
          <span v-if="!chip.imageData" class="ai-chip-tokens">~{{ Math.ceil(chip.content.length / 4) > 999 ? (Math.ceil(chip.content.length / 4000)).toFixed(0) + 'k' : Math.ceil(chip.content.length / 4) }}t</span>
          <button class="ai-chip-pin" :title="chip.pinned ? 'Unpin context' : 'Pin — keep in future messages'" @click.stop="chip.pinned = !chip.pinned">{{ chip.pinned ? '📌' : '·' }}</button>
          <button class="ai-chip-remove" @click.stop="removeChip(chip.id)">×</button>
        </span>
        <!-- Chip preview popover -->
        <div v-if="previewChip" class="ai-chip-popover" @click.stop>
          <div class="ai-chip-popover-header">
            <span class="ai-chip-popover-label">{{ previewChip.label }}</span>
            <span v-if="!previewChip.imageData" class="ai-chip-popover-tokens">~{{ Math.ceil(previewChip.content.length / 4).toLocaleString() }} tokens</span>
            <button class="ai-chip-popover-close" @click="previewChipId = null">×</button>
          </div>
          <img v-if="previewChip.imageData" :src="previewChip.imageData" class="ai-chip-popover-img" alt="pasted image" />
          <pre v-else class="ai-chip-popover-content">{{ previewChip.content.slice(0, 1200) }}{{ previewChip.content.length > 1200 ? '\n…' : '' }}</pre>
        </div>
      </div>

      <!-- Slash command menu -->
      <div v-if="showSlashMenu" ref="slashMenuEl" class="ai-at-menu ai-slash-menu">
        <div
          v-for="(cmd, i) in slashOptions"
          :key="cmd.id"
          class="ai-at-item ai-slash-item"
          :class="{ active: i === slashMenuIdx }"
          @mousedown.prevent="selectSlashCommand(cmd)"
          @mouseover="slashMenuIdx = i"
        >
          <span class="ai-slash-name">{{ cmd.label }}</span>
          <span class="ai-slash-desc">{{ cmd.description }}</span>
        </div>
      </div>

      <!-- @ menu -->
      <div v-if="showAtMenu" ref="atMenuEl" class="ai-at-menu">
        <div
          v-for="(opt, i) in atOptions"
          :key="opt.id"
          class="ai-at-item"
          :class="{ active: i === atMenuIdx }"
          @mousedown.prevent="selectAtOption(opt)"
          @mouseover="atMenuIdx = i"
        >
          {{ opt.label }}
        </div>
      </div>

      <!-- Model quick-picker badge -->
      <div class="ai-model-bar">
        <span
          v-if="workspaceRulesFile"
          class="ai-rules-badge"
          :title="`Workspace rules active from ${workspaceRulesFile}`"
          @click="showSettings = true"
        >✦ rules</span>
        <button class="ai-model-badge-btn" :title="`Model: ${settingsModel} (click to change)`" @click="showModelPicker = !showModelPicker">
          <span class="ai-model-badge-icon">⬡</span>
          <span class="ai-model-badge-name">{{ settingsModel.split('/').pop()?.replace('claude-', '').replace('-20', ' 20') }}</span>
          <span class="ai-model-badge-caret">{{ showModelPicker ? '▲' : '▼' }}</span>
        </button>
        <div v-if="showModelPicker" class="ai-model-picker-menu">
          <div
            v-for="m in currentModelOptions"
            :key="m"
            class="ai-model-picker-item"
            :class="{ active: m === settingsModel }"
            @click="settingsModel = m; showModelPicker = false; saveSettings()"
          >{{ m }}</div>
        </div>
      </div>

      <!-- Context window usage bar (shown when > 30%) -->
      <div v-if="ctxUsagePct > 30" class="ai-ctx-bar" :class="ctxUsageLevel" :title="`~${conversationTokenEstimate.toLocaleString()} / ${CTX_MAX_TOKENS.toLocaleString()} tokens`">
        <div class="ai-ctx-bar-track">
          <div class="ai-ctx-bar-fill" :style="{ width: ctxUsagePct + '%' }" />
        </div>
        <span class="ai-ctx-label">context {{ ctxUsagePct }}%</span>
        <button v-if="ctxUsagePct >= 80" class="ai-ctx-new-btn" title="Start new chat to free context" @click="newThread">+ New chat</button>
      </div>

      <div class="ai-input-row">
        <div class="ai-textarea-wrap">
          <textarea
            ref="textareaEl"
            v-model="inputText"
            class="ai-textarea"
            placeholder="Type a message… (@ to insert context, Enter to send, Shift+Enter for new line)"
            :disabled="sending"
            rows="1"
            @input="onTextareaInput"
            @keydown="onTextareaKeydown"
            @paste="onTextareaPaste"
          />
          <span v-if="inputCharCount > 200" class="ai-char-count" :class="{ warn: inputCharCount > 2000 }">
            {{ inputCharCount.toLocaleString() }} chars · ~{{ inputTokenEstimate.toLocaleString() }} tokens
          </span>
        </div>
        <div class="ai-input-btns">
          <button
            v-if="!sending"
            class="ai-send-btn"
            :disabled="!inputText.trim() && contextChips.length === 0"
            title="Send (Enter)"
            @click="sendMessage"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13 5.5a1.343 1.343 0 0 1 0 2.564l-13 5.5a1.342 1.342 0 0 1-1.85-1.463L.989 8Zm.603-5.353L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.603L13.5 8 1.592 2.647Z"/>
            </svg>
          </button>
          <button
            v-else
            class="ai-stop-btn"
            title="Stop"
            @click="stopStreaming"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            title="New chat"
            @click="newThread"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            title="Chat history"
            :class="{ active: showThreads }"
            @click="showThreads = !showThreads; if (!showThreads) threadSearchQuery = ''"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            title="Search chat (Ctrl+F)"
            :disabled="messages.length === 0"
            @click="openSearch"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            title="Copy conversation to clipboard"
            :disabled="messages.length === 0"
            @click="copyAllMessages"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            title="Clear chat"
            :disabled="messages.length === 0"
            @click="clearConversation"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
            </svg>
          </button>
          <button
            class="ai-response-length-btn"
            :title="`Response length: ${RESPONSE_LENGTH_LABELS[responseLength]} (click to cycle)`"
            @click="cycleResponseLength"
          >{{ RESPONSE_LENGTH_LABELS[responseLength] }}</button>
          <button
            class="ai-settings-btn"
            title="Keyboard shortcuts (?)"
            @click="showShortcuts = !showShortcuts"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM5 8.5H2.75a.75.75 0 0 1 0-1.5H5a.75.75 0 0 1 0 1.5Zm2.5 2h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm0-4h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm5.75 4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Zm0-4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            title="Settings"
            @click="showSettings = !showSettings"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 9.99 1.409v.526c0 .384.214.706.535.862a6.98 6.98 0 0 1 .606.331c.316.19.693.16.965-.066l.372-.323a1.402 1.402 0 0 1 1.947.162l.739.845c.45.515.433 1.28-.037 1.773l-.365.388c-.224.238-.285.58-.152.892.144.343.27.694.374 1.052.098.339.364.59.706.643l.529.082c.764.119 1.282.823 1.2 1.593l-.116 1.112c-.076.729-.7 1.263-1.437 1.178l-.531-.065c-.345-.042-.668.163-.805.481a6.887 6.887 0 0 1-.376 1.053c-.134.312-.072.654.153.892l.365.388c.469.494.486 1.258.037 1.773l-.74.845a1.402 1.402 0 0 1-1.947.162l-.373-.324c-.272-.225-.648-.255-.963-.065-.198.12-.408.228-.61.331a.993.993 0 0 0-.535.862v.526c0 .764-.546 1.314-1.289 1.378A8.2 8.2 0 0 1 8 16a8.2 8.2 0 0 1-.701-.031C6.556 15.905 6.01 15.355 6.01 14.591v-.526a.993.993 0 0 0-.535-.862 6.942 6.942 0 0 1-.607-.331c-.315-.19-.691-.16-.963.065l-.373.324a1.402 1.402 0 0 1-1.947-.162l-.739-.845c-.45-.515-.433-1.28.037-1.773l.365-.388c.224-.238.285-.58.152-.892a6.933 6.933 0 0 1-.374-1.053c-.098-.339-.364-.59-.706-.643l-.529-.082C.236 9.177-.282 8.473-.2 7.703l.116-1.112C-.008 5.862.616 5.328 1.353 5.413l.531.065c.345.042.668-.163.805-.481A6.887 6.887 0 0 1 3.065 3.944c.134-.312.072-.654-.153-.892L2.547 2.664C2.078 2.17 2.061 1.406 2.51.891l.74-.845A1.402 1.402 0 0 1 5.197.884l.372.323c.272.226.649.256.965.066a6.98 6.98 0 0 1 .606-.331A.993.993 0 0 0 7.675 1.935V1.409C7.675.645 8.221.095 8.964.031 8.977.01 8.988 0 9 0H8ZM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Thread list panel -->
    <div v-if="showThreads" class="ai-threads-panel">
      <div class="ai-threads-header">
        <span>Chat history ({{ allThreads.length }})</span>
        <button class="ai-settings-close" @click="showThreads = false; threadSearchQuery = ''">✕</button>
      </div>
      <div class="ai-threads-search">
        <input
          v-model="threadSearchQuery"
          class="ai-search-input"
          placeholder="Search chats…"
          @keydown.escape="showThreads = false; threadSearchQuery = ''"
        />
      </div>
      <div class="ai-threads-list">
        <div v-if="!filteredThreads.length" class="ai-threads-empty">No results</div>
        <template v-for="item in groupedThreads" :key="item.kind === 'label' ? 'label-' + item.label : item.thread.id">
          <div v-if="item.kind === 'label'" class="ai-thread-group-label">{{ item.label }}</div>
          <div
            v-else
            class="ai-thread-item"
            :class="{ active: item.thread.id === currentThreadId }"
            @click="switchThread(item.thread.id)"
          >
            <div class="ai-thread-main">
              <input
                v-if="renamingThreadId === item.thread.id"
                v-model="renamingTitle"
                class="ai-thread-rename-input"
                @click.stop
                @keydown.enter.prevent="finishRenameThread"
                @keydown.escape.prevent="cancelRenameThread"
                @blur="finishRenameThread"
              />
              <span
                v-else
                class="ai-thread-title"
                title="Double-click to rename"
                @dblclick.stop="startRenameThread(item.thread.id, item.thread.title, $event)"
              >{{ item.thread.title }}</span>
              <span v-if="threadSearchQuery && !item.thread.title.toLowerCase().includes(threadSearchQuery.toLowerCase())" class="ai-thread-snippet">{{ getThreadMatchSnippet(item.thread, threadSearchQuery) }}</span>
            </div>
            <div class="ai-thread-meta">
              <span v-if="item.thread.messages.length" class="ai-thread-count">{{ item.thread.messages.length }}</span>
              <span class="ai-thread-time">{{ new Date(item.thread.updatedAt).toLocaleDateString() }}</span>
              <button class="ai-thread-pin" :title="item.thread.pinned ? 'Unpin' : 'Pin'" @click.stop="togglePinThread(item.thread.id, $event)">{{ item.thread.pinned ? '📌' : '⊙' }}</button>
              <button class="ai-thread-del" title="Delete" @click.stop="deleteThread(item.thread.id)">✕</button>
            </div>
            <div v-if="item.thread.messages.length && renamingThreadId !== item.thread.id" class="ai-thread-preview">
              {{ item.thread.messages[item.thread.messages.length - 1]?.content.replace(/[#`*_~>]/g, '').trim().slice(0, 60) }}
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Settings panel -->
    <div v-if="showSettings" class="ai-settings">
      <div class="ai-settings-header">
        <span>AI Settings</span>
        <button class="ai-settings-close" @click="showSettings = false">✕</button>
      </div>
      <div class="ai-settings-body">
        <div class="ai-settings-row">
          <label class="ai-settings-label">Provider</label>
          <div class="ai-settings-radios">
            <label>
              <input v-model="settingsProvider" type="radio" value="anthropic" />
              Anthropic
            </label>
            <label>
              <input v-model="settingsProvider" type="radio" value="ollama" />
              Ollama
            </label>
          </div>
        </div>
        <div v-if="settingsProvider === 'anthropic'" class="ai-settings-row">
          <label class="ai-settings-label">API Key</label>
          <input v-model="settingsApiKey" type="password" class="ai-settings-input" placeholder="sk-ant-…" />
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Model</label>
          <select v-model="selectedModelKey" class="ai-settings-select">
            <option v-for="m in currentModelOptions" :key="m" :value="m">{{ m }}</option>
            <option value="custom">Custom…</option>
          </select>
          <input
            v-if="modelIsCustom"
            v-model="settingsModel"
            type="text"
            class="ai-settings-input ai-settings-input--custom"
            placeholder="Enter model ID"
          />
        </div>
        <div v-if="settingsProvider === 'ollama'" class="ai-settings-row">
          <label class="ai-settings-label">Ollama URL</label>
          <input v-model="settingsOllamaUrl" type="text" class="ai-settings-input" placeholder="http://localhost:11434" />
        </div>
        <div class="ai-settings-row ai-settings-row--column">
          <label class="ai-settings-label">System Prompt</label>
          <textarea
            v-model="settingsSystemPrompt"
            class="ai-settings-textarea"
            rows="4"
            placeholder="You are a helpful AI coding assistant."
          />
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Agent mode</label>
          <label class="ai-toggle-label">
            <input v-model="settingsAutoAccept" type="checkbox" />
            Auto-accept file edits
          </label>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Max response tokens (256–16000)</label>
          <div class="ai-tokens-row">
            <input v-model.number="settingsMaxTokens" type="range" min="256" max="16000" step="256" class="ai-tokens-slider" />
            <span class="ai-tokens-val">{{ settingsMaxTokens.toLocaleString() }}</span>
          </div>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Temperature (0 = precise, 1 = creative)</label>
          <div class="ai-tokens-row">
            <label class="ai-toggle-label" style="margin-right:8px">
              <input type="checkbox" :checked="settingsTemperature === null" @change="settingsTemperature = settingsTemperature === null ? 0.7 : null" />
              Use default
            </label>
            <template v-if="settingsTemperature !== null">
              <input v-model.number="settingsTemperature" type="range" min="0" max="1" step="0.05" class="ai-tokens-slider" />
              <span class="ai-tokens-val">{{ (settingsTemperature ?? 0).toFixed(2) }}</span>
            </template>
          </div>
        </div>
        <div v-if="workspaceRulesFile" class="ai-settings-row ai-rules-notice">
          <span class="ai-rules-icon">✦</span>
          <span>Workspace rules auto-applied from <code>{{ workspaceRulesFile }}</code></span>
        </div>
        <div v-else class="ai-settings-row ai-rules-notice ai-rules-missing">
          <span>No workspace rules found. Create <code>AGENTS.md</code> or <code>.cursor/rules</code> to add project-specific AI instructions.</span>
        </div>
        <div class="ai-settings-footer">
          <button class="ai-settings-save" @click="saveSettings">Save</button>
        </div>
      </div>
    </div>

    <!-- Keyboard shortcuts panel -->
    <div v-if="showShortcuts" class="ai-shortcuts-panel">
      <div class="ai-shortcuts-header">
        <span>Keyboard Shortcuts</span>
        <button class="ai-settings-close" @click="showShortcuts = false">✕</button>
      </div>
      <table class="ai-shortcuts-table">
        <tbody>
          <tr><td><kbd>Enter</kbd></td><td>Send message</td></tr>
          <tr><td><kbd>Shift+Enter</kbd></td><td>New line</td></tr>
          <tr><td><kbd>↑ / ↓</kbd></td><td>Browse input history</td></tr>
          <tr><td><kbd>Ctrl+L</kbd></td><td>Focus AI chat input</td></tr>
          <tr><td><kbd>Ctrl+N</kbd></td><td>New chat</td></tr>
          <tr><td><kbd>Ctrl+Shift+K</kbd></td><td>Clear current conversation</td></tr>
          <tr><td><kbd>Ctrl+Shift+A</kbd></td><td>Add current file to context</td></tr>
          <tr><td><kbd>Ctrl+F</kbd></td><td>Search chat</td></tr>
          <tr><td><kbd>Ctrl+Enter</kbd></td><td>Regenerate last response (empty input)</td></tr>
          <tr><td><kbd>@</kbd></td><td>Insert context (file, selection, git)</td></tr>
          <tr><td><kbd>/</kbd></td><td>Slash commands (/explain, /fix…)</td></tr>
          <tr><td><kbd>Escape</kbd></td><td>Close menu / search bar</td></tr>
          <tr><td>Drag file</td><td>Add file to context</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Toast -->
    <div v-if="toastMsg" class="ai-toast">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
.ai-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-bright);
  position: relative;
  overflow: hidden;
}

/* ── Messages ─────────────────────────────────────────────────────────────── */
.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}
.ai-messages::-webkit-scrollbar { width: 6px; }
.ai-messages::-webkit-scrollbar-track { background: transparent; }
.ai-messages::-webkit-scrollbar-thumb { background: var(--border-muted); border-radius: 3px; }

.ai-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.ai-empty p { margin: 0; }
.ai-empty-title { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.ai-empty-hint { font-size: 11px; opacity: 0.7; }
.ai-empty-suggestions {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 8px;
}
.ai-empty-btn {
  padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-muted);
  background: var(--bg-subtle); color: var(--text-secondary); font-size: 11.5px;
  cursor: pointer; white-space: nowrap;
}
.ai-empty-btn:hover { border-color: var(--accent-emphasis); color: var(--accent-fg); background: var(--bg-inset); }

.ai-msg-wrap { display: flex; flex-direction: column; position: relative; }
.ai-msg-wrap.user { align-items: flex-end; }
.ai-msg-wrap.assistant { align-items: flex-start; }

/* Message action bar — model badge always visible; buttons hidden until hover */
.ai-msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  padding: 0 4px;
}
.ai-msg-actions.user { justify-content: flex-end; }
.ai-msg-actions.assistant { justify-content: flex-start; }
.ai-model-badge {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.6;
  font-family: ui-monospace, Menlo, monospace;
  padding: 1px 5px;
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  margin-right: 2px;
  white-space: nowrap;
}
.ai-msg-action-btn {
  opacity: 0;
  transition: opacity 0.15s;
  background: none;
  border: none;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 4px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
}
.ai-msg-wrap:hover .ai-msg-action-btn { opacity: 1; }
.ai-msg-action-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-msg-time {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s;
  user-select: none;
}
.ai-msg-wrap:hover .ai-msg-time { opacity: 1; }
.ai-msg-elapsed { font-size: 10px; color: var(--text-muted); opacity: 0.55; user-select: none; }
.ai-feedback-btn { font-size: 11px; opacity: 0.3; }
.ai-feedback-btn:hover { opacity: 0.9; }
.ai-feedback-up { opacity: 1 !important; filter: none; }
.ai-feedback-down { opacity: 1 !important; filter: none; }
.ai-bookmark-active { color: #f0c040 !important; opacity: 1 !important; }
.ai-bookmark-indicator {
  position: absolute; top: 2px; right: 4px;
  font-size: 11px; color: #f0c040; pointer-events: none; user-select: none;
}
.ai-followups {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 10px 2px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-canvas);
}
.ai-followup-btn {
  text-align: left;
  background: none;
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11.5px;
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-followup-btn:hover { border-color: var(--accent-emphasis); color: var(--accent-fg); }
.ai-followup-btn::before { content: '↩ '; opacity: 0.45; font-size: 10px; }

.ai-active-tool-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
}
.ai-active-tool-icon { font-size: 13px; }
.ai-active-tool-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-active-tool-spinner {
  width: 10px; height: 10px;
  border: 1.5px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  border-radius: 50%;
  animation: ai-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.ai-scroll-to-bottom {
  position: absolute;
  bottom: 130px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
  border: none;
  border-radius: 12px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
}
.ai-scroll-to-bottom:hover { opacity: 0.85; }

.ai-bubble {
  max-width: 90%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}
.ai-bubble.user {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
  border-bottom-right-radius: 3px;
}
.ai-bubble.assistant {
  background: var(--bg-subtle);
  color: var(--text-bright);
  border-bottom-left-radius: 3px;
}

.ai-date-sep {
  display: flex; align-items: center; gap: 8px; margin: 12px 8px 4px;
  color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
}
.ai-date-sep::before, .ai-date-sep::after {
  content: ''; flex: 1; height: 1px; background: var(--border-muted);
}
.ai-date-sep-label { white-space: nowrap; user-select: none; }
.ai-stream-tokens { font-size: 10px; color: var(--text-muted); opacity: 0.55; margin-left: 4px; user-select: none; }
.ai-text-folded { max-height: 320px; overflow: hidden; position: relative; }
.ai-text-folded::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 60px;
  background: linear-gradient(transparent, var(--bg-bubble-assistant, #1c2128));
  pointer-events: none;
}
.ai-fold-btn {
  display: block; width: 100%; padding: 4px 0; margin-top: 2px;
  font-size: 11px; color: var(--accent-fg, #58a6ff);
  background: none; border: none; cursor: pointer; text-align: center;
}
.ai-fold-btn:hover { text-decoration: underline; }

.ai-text :deep(.ai-code-wrap) {
  margin: 6px 0;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
}
.ai-text :deep(.ai-code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ai-text :deep(.ai-code-lang) {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10.5px;
  color: var(--text-muted);
  text-transform: lowercase;
}
.ai-text :deep(.ai-code-copy-btn) {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}
.ai-text :deep(.ai-code-copy-btn:hover) {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-text :deep(.ai-code-fold-btn) {
  display: block;
  width: 100%;
  padding: 4px 10px;
  background: var(--bg-muted);
  border: none;
  border-top: 1px solid var(--border-muted);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  text-align: left;
  letter-spacing: 0.02em;
}
.ai-text :deep(.ai-code-fold-btn:hover) { color: var(--text-bright); background: var(--bg-subtle); }
.ai-text :deep(.ai-code-save-btn) {
  background: none; border: 1px solid var(--text-muted);
  border-radius: 4px; color: var(--text-secondary);
  cursor: pointer; font-size: 11px; padding: 2px 7px; margin-left: 2px;
}
.ai-text :deep(.ai-code-save-btn:hover) { border-color: var(--text-bright); color: var(--text-bright); }
.ai-text :deep(.ai-code-run-btn) {
  background: none; border: 1px solid var(--warning-fg, #d29922);
  border-radius: 4px; color: var(--warning-fg, #d29922);
  cursor: pointer; font-size: 11px; padding: 2px 7px; margin-left: 2px;
}
.ai-text :deep(.ai-code-run-btn:hover) { background: var(--warning-fg, #d29922); color: #fff; }
.ai-text :deep(.ai-code-run-btn:disabled) { opacity: 0.6; cursor: default; }
.ai-text :deep(.ai-code-apply-btn),
.ai-text :deep(.ai-code-insert-btn) {
  background: none;
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  color: var(--accent-fg);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 7px;
  margin-left: 2px;
}
.ai-text :deep(.ai-code-apply-btn:hover) {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
}
.ai-text :deep(.ai-code-insert-btn) {
  border-color: var(--success-fg, #3fb950);
  color: var(--success-fg, #3fb950);
}
.ai-text :deep(.ai-code-insert-btn:hover) {
  background: var(--success-fg, #3fb950);
  color: #fff;
}
.ai-text :deep(pre.ai-code-block) {
  background: var(--bg-muted);
  border-radius: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 11.5px;
  margin: 0;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  white-space: pre;
}
.ai-text :deep(code.has-line-numbers) {
  counter-reset: code-line;
}
.ai-text :deep(code.has-line-numbers .code-ln) {
  counter-increment: code-line;
  display: block;
}
.ai-text :deep(code.has-line-numbers .code-ln::before) {
  content: counter(code-line);
  display: inline-block;
  width: 2.5ch;
  margin-right: 12px;
  color: var(--text-muted);
  opacity: 0.4;
  text-align: right;
  user-select: none;
  font-size: 0.9em;
}
.ai-text :deep(code.ai-inline-code) {
  background: var(--bg-muted);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 0.9em;
}
.ai-text :deep(a.ai-link) {
  color: var(--accent-fg);
  text-decoration: underline;
  word-break: break-all;
}
.ai-text :deep(a.ai-link:hover) { opacity: 0.8; }
.ai-text :deep(code.ai-file-ref) {
  cursor: pointer;
  color: var(--accent-fg, #58a6ff);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.ai-text :deep(code.ai-file-ref:hover) { background: var(--bg-subtle); }
.ai-text :deep(.ai-file-ref-line) { opacity: 0.65; font-size: 0.85em; }
.ai-text :deep(ul.ai-ul),
.ai-text :deep(ol.ai-ol) {
  margin: 4px 0 4px 18px;
  padding: 0;
  line-height: 1.6;
}
.ai-text :deep(ul.ai-ul) { list-style: disc; }
.ai-text :deep(ol.ai-ol) { list-style: decimal; }
.ai-text :deep(h2.ai-h),
.ai-text :deep(h3.ai-h),
.ai-text :deep(h4.ai-h),
.ai-text :deep(h5.ai-h) {
  margin: 8px 0 2px;
  font-weight: 600;
  line-height: 1.3;
}
.ai-text :deep(h2.ai-h) { font-size: 1.1em; }
.ai-text :deep(h3.ai-h) { font-size: 1.0em; }
.ai-text :deep(h4.ai-h),
.ai-text :deep(h5.ai-h) { font-size: 0.95em; color: var(--text-secondary); }
.ai-text :deep(hr.ai-hr) {
  border: none;
  border-top: 1px solid var(--border-muted);
  margin: 8px 0;
}
.ai-text :deep(ul.ai-task-list) { list-style: none; padding-left: 4px; }
.ai-text :deep(li.ai-task-item) { display: flex; align-items: baseline; gap: 6px; }
.ai-text :deep(li.ai-task-item input[type="checkbox"]) { margin: 0; flex-shrink: 0; }
.ai-text :deep(blockquote.ai-blockquote) {
  border-left: 3px solid var(--accent-fg);
  margin: 4px 0;
  padding: 2px 10px;
  color: var(--text-secondary);
  font-style: italic;
}
.ai-text :deep(table.ai-table) {
  border-collapse: collapse;
  font-size: 12px;
  margin: 6px 0;
  max-width: 100%;
  overflow-x: auto;
  display: block;
}
.ai-text :deep(table.ai-table th),
.ai-text :deep(table.ai-table td) {
  border: 1px solid var(--border-muted);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}
.ai-text :deep(table.ai-table th) {
  background: var(--surface-1);
  font-weight: 600;
}

.ai-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--accent-fg);
  vertical-align: text-bottom;
  animation: blink 0.9s step-end infinite;
  margin-left: 2px;
}
@keyframes blink { 50% { opacity: 0 } }

/* ── Thinking indicator ───────────────────────────────────────────────────── */
.ai-thinking {
  display: flex;
  gap: 4px;
  padding: 4px 2px;
  align-items: center;
}
.ai-thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: ai-bounce 1.2s ease-in-out infinite;
}
.ai-thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.ai-thinking-dot:nth-child(3) { animation-delay: 0.4s; }
.ai-thinking-label { font-size: 11px; color: var(--text-muted); font-style: italic; margin-left: 4px; }
@keyframes ai-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ── Error card ──────────────────────────────────────────────────────────── */
.ai-error-card {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger-fg, #cf222e) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger-fg, #cf222e) 30%, transparent);
  color: var(--danger-fg, #cf222e);
  font-size: 12.5px;
}
.ai-error-msg { flex: 1; word-break: break-word; }
.ai-error-retry {
  background: var(--danger-fg, #cf222e);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.ai-error-retry:hover { opacity: 0.85; }

/* ── Detected commit message action bar ──────────────────────────────────── */
.ai-commit-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--accent-emphasis) 8%, transparent);
  border-top: 1px solid var(--border-muted);
  font-size: 11.5px;
}
.ai-commit-msg-preview {
  flex: 1;
  font-family: ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-commit-run-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #1a7f37;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.ai-commit-run-btn:hover { background: #2ea043; }

/* ── Accept All / Reject All bar ─────────────────────────────────────────── */
.ai-bulk-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
}
.ai-bulk-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  cursor: pointer;
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-bulk-btn.accept {
  background: var(--success-emphasis, #1a7f37);
  color: #fff;
  border-color: transparent;
}
.ai-bulk-btn.discard {
  background: var(--danger-emphasis, #cf222e);
  color: #fff;
  border-color: transparent;
}

/* ── Tool call card ────────────────────────────────────────────────────────── */
.ai-tool-card {
  margin-top: 6px;
  border-left: 4px solid var(--accent-emphasis);
  background: var(--bg-muted);
  border-radius: 0 5px 5px 0;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 9px;
  cursor: pointer;
  user-select: none;
}
.ai-tool-header:hover { background: var(--bg-subtle); }
.ai-tool-icon { font-size: 13px; flex-shrink: 0; opacity: 0.8; }
.ai-tool-name { font-family: ui-monospace, Menlo, monospace; color: var(--accent-fg); font-weight: 600; flex: 1; }
.ai-tool-toggle { color: var(--text-muted); font-size: 10px; }
.ai-tool-done { color: #2ea043; font-size: 11px; flex-shrink: 0; }
.ai-tool-pending { border-color: var(--accent-muted); }
@keyframes ai-spin { to { transform: rotate(360deg); } }
.ai-tool-spinner {
  display: inline-block; width: 10px; height: 10px; flex-shrink: 0;
  border: 2px solid var(--accent-muted); border-top-color: var(--accent-fg);
  border-radius: 50%; animation: ai-spin 0.7s linear infinite;
}
.ai-tool-body { padding: 0 9px 8px; }
.ai-tool-pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  max-height: 160px;
  overflow-y: auto;
}
.ai-tool-result { margin-top: 6px; color: var(--text-muted); font-size: 11px; }
.ai-tool-result-label { color: var(--accent-fg); font-weight: 600; margin-right: 4px; }

/* ── Edit proposal card ────────────────────────────────────────────────────── */
.ai-edit-card {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-edit-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
  flex-wrap: wrap;
}
.ai-edit-path {
  flex: 1;
  font-family: ui-monospace, Menlo, monospace;
  color: var(--accent-fg);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-edit-actions { display: flex; gap: 6px; margin-left: auto; }
.ai-edit-btn {
  padding: 3px 10px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
}
.ai-edit-btn.accept { background: #1a7f37; color: #fff; }
.ai-edit-btn.accept:hover { background: #2ea043; }
.ai-edit-btn.discard { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-muted); }
.ai-edit-btn.discard:hover { background: var(--bg-muted); }
.ai-edit-accepted { font-size: 11px; color: #3fb950; margin-left: auto; }
.ai-diff-stat { font-size: 10px; margin-left: 4px; }
.diff-add-count { color: #3fb950; }
.diff-del-count { color: #f85149; }
.ai-diff-toggle-icon { font-size: 10px; color: var(--text-muted); margin-left: 2px; }

.ai-diff-view {
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-base);
  padding: 6px 0;
}
.ai-diff-view :deep(.diff-add) { background: rgba(46, 160, 67, 0.15); color: #56d364; padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-del) { background: rgba(248, 81, 73, 0.15); color: #f85149; padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-hunk) { color: var(--accent-fg); background: rgba(79, 140, 201, 0.1); padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-ctx) { color: var(--text-muted); padding: 0 8px; white-space: pre; }

/* ── Command proposal card ─────────────────────────────────────────────────── */
.ai-cmd-card {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-left: 4px solid #e3b341;
  border-radius: 0 6px 6px 0;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-cmd-card.approved { border-left-color: #3fb950; }
.ai-cmd-card.rejected { border-left-color: var(--text-muted); opacity: 0.6; }
.ai-cmd-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ai-cmd-label { font-weight: 600; color: #e3b341; flex: 1; }
.ai-cmd-card.approved .ai-cmd-label { color: #3fb950; }
.ai-cmd-card.rejected .ai-cmd-label { color: var(--text-muted); }
.ai-cmd-actions { display: flex; gap: 6px; }
.ai-cmd-btn {
  padding: 3px 10px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
}
.ai-cmd-btn.approve { background: #1a7f37; color: #fff; }
.ai-cmd-btn.approve:hover { background: #2ea043; }
.ai-cmd-btn.reject { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-muted); }
.ai-cmd-btn.reject:hover { background: var(--bg-muted); }
.ai-cmd-status { font-size: 11px; }
.ai-cmd-status.approved { color: #3fb950; }
.ai-cmd-status.rejected { color: var(--text-muted); }
.ai-cmd-pre {
  margin: 0;
  padding: 7px 10px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-base);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── Input area ────────────────────────────────────────────────────────────── */
.ai-input-area {
  flex-shrink: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  position: relative;
  transition: box-shadow 0.12s;
}
.ai-input-area.ai-drop-active {
  box-shadow: inset 0 0 0 2px var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 6%, var(--bg-subtle));
}

.ai-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
  font-size: 11px;
  font-weight: 500;
}
.ai-chip-remove {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  opacity: 0.7;
}
.ai-chip-remove:hover { opacity: 1; }
.ai-chip-tokens { font-size: 9px; opacity: 0.55; margin: 0 3px 0 1px; letter-spacing: 0.02em; }
.ai-chip { cursor: pointer; }
.ai-chip:hover { filter: brightness(1.15); }
.ai-chip-active { outline: 2px solid rgba(255,255,255,0.5); }
.ai-chip-image { padding: 2px 6px 2px 3px; }
.ai-chip-thumb { width: 22px; height: 16px; object-fit: cover; border-radius: 3px; vertical-align: middle; flex-shrink: 0; }
.ai-chip-popover-img { display: block; max-width: 100%; max-height: 300px; object-fit: contain; margin: 8px auto; }
.ai-chip-pinned { outline: 1.5px solid rgba(255,255,255,0.6); }
.ai-chip-pin { border: none; background: transparent; color: inherit; cursor: pointer; padding: 0; font-size: 11px; line-height: 1; opacity: 0.6; }
.ai-chip-pin:hover { opacity: 1; }

.ai-chip-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,.55);
  z-index: 12;
  overflow: hidden;
}
.ai-chip-popover-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
  font-size: 12px;
}
.ai-chip-popover-label { font-weight: 600; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-chip-popover-tokens { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.ai-chip-popover-close {
  border: none; background: transparent; color: var(--text-muted);
  cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; flex-shrink: 0;
}
.ai-chip-popover-close:hover { color: var(--text-primary); }
.ai-chip-popover-content {
  margin: 0;
  padding: 8px 10px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}

.ai-at-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 10px;
  right: 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  overflow: hidden;
  z-index: 10;
  max-height: 200px;
  overflow-y: auto;
}
.ai-at-item {
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-bright);
}
.ai-at-item:hover, .ai-at-item.active { background: var(--bg-muted); }

.ai-slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.ai-slash-name {
  font-family: ui-monospace, Menlo, monospace;
  color: var(--accent-fg);
  font-weight: 600;
  font-size: 12px;
  min-width: 80px;
}
.ai-slash-desc {
  color: var(--text-muted);
  font-size: 11.5px;
}

.ai-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.ai-textarea-wrap {
  flex: 1;
  position: relative;
}
.ai-char-count {
  position: absolute;
  bottom: 5px;
  right: 8px;
  font-size: 10px;
  color: var(--text-muted);
  pointer-events: none;
  font-family: ui-monospace, monospace;
}
.ai-char-count.warn { color: var(--danger-fg, #cf222e); }

/* Model picker bar */
.ai-model-bar { position: relative; display: flex; align-items: center; padding: 2px 8px 0; gap: 4px; }
.ai-rules-badge {
  font-size: 10px;
  color: var(--accent-fg);
  opacity: 0.7;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent-emphasis) 12%, transparent);
  letter-spacing: 0.02em;
}
.ai-rules-badge:hover { opacity: 1; }
.ai-model-badge-btn {
  display: flex; align-items: center; gap: 4px;
  background: none; border: 1px solid var(--border-muted); border-radius: 10px;
  padding: 2px 8px; cursor: pointer; color: var(--text-secondary); font-size: 11px;
  transition: border-color 0.15s;
}
.ai-model-badge-btn:hover { border-color: var(--accent-fg); color: var(--text-bright); }
.ai-model-badge-icon { font-size: 10px; opacity: 0.6; }
.ai-model-badge-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-model-badge-caret { font-size: 8px; opacity: 0.6; }
.ai-model-picker-menu {
  position: absolute; bottom: calc(100% + 4px); left: 8px;
  background: var(--bg-overlay); border: 1px solid var(--border-muted); border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3); z-index: 200; min-width: 200px; overflow: hidden;
}
.ai-model-picker-item {
  padding: 7px 12px; font-size: 12px; cursor: pointer; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ai-model-picker-item:hover { background: var(--bg-muted); color: var(--text-bright); }
.ai-model-picker-item.active { color: var(--accent-fg); font-weight: 600; }

/* Context window bar */
.ai-ctx-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
}
.ai-ctx-bar-track {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--border-muted);
  overflow: hidden;
}
.ai-ctx-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent-emphasis);
  transition: width 0.3s ease;
}
.ai-ctx-bar.warn .ai-ctx-bar-fill { background: #d29922; }
.ai-ctx-bar.danger .ai-ctx-bar-fill { background: var(--danger-fg, #cf222e); }
.ai-ctx-label { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.ai-ctx-bar.warn .ai-ctx-label { color: #d29922; }
.ai-ctx-bar.danger .ai-ctx-label { color: var(--danger-fg, #cf222e); }
.ai-ctx-new-btn {
  margin-left: auto; padding: 1px 6px; font-size: 10px;
  background: none; border: 1px solid currentColor; border-radius: 3px;
  color: inherit; cursor: pointer; white-space: nowrap;
}
.ai-ctx-new-btn:hover { background: color-mix(in srgb, currentColor 15%, transparent); }

.ai-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 60px;
  max-height: 200px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  line-height: 1.5;
  font-family: inherit;
  outline: none;
  overflow-y: auto;
}
.ai-textarea:focus { border-color: var(--accent-emphasis); }
.ai-textarea:disabled { opacity: 0.6; }
.ai-textarea::placeholder { color: var(--text-muted); }

.ai-input-btns {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.ai-send-btn, .ai-stop-btn, .ai-settings-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ai-send-btn {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
}
.ai-send-btn:hover:not(:disabled) { opacity: 0.85; }
.ai-send-btn:disabled { opacity: 0.4; cursor: default; }
.ai-stop-btn {
  background: #b91c1c;
  color: #fff;
}
.ai-stop-btn:hover { background: #dc2626; }
.ai-settings-btn {
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.ai-settings-btn:hover:not(:disabled) { color: var(--text-bright); }
.ai-settings-btn:disabled { opacity: 0.3; cursor: default; }

.ai-response-length-btn {
  background: var(--bg-muted);
  color: var(--text-secondary);
  border: none;
  border-radius: 3px;
  padding: 2px 5px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
  white-space: nowrap;
  height: 22px;
}
.ai-response-length-btn:hover { color: var(--accent-fg); }

/* ── Search bar ─────────────────────────────────────────────────────────────── */
.ai-search-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-muted);
  flex-shrink: 0;
}
.ai-search-input {
  flex: 1;
  padding: 3px 7px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12px;
  outline: none;
}
.ai-search-input:focus { border-color: var(--accent-emphasis); }
.ai-search-count { font-size: 11px; color: var(--text-muted); min-width: 52px; text-align: center; }
.ai-search-nav {
  background: none;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
}
.ai-search-nav:hover { color: var(--text-bright); }
.ai-search-close { background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 13px; line-height: 1; padding: 2px 4px; }
.ai-search-close:hover { color: var(--text-bright); }
.ai-msg-wrap.search-match .ai-bubble { outline: 1px solid var(--accent-emphasis); opacity: 0.7; }
.ai-msg-wrap.search-active .ai-bubble { outline: 2px solid var(--accent-emphasis); opacity: 1; }
.ai-text :deep(mark.ai-search-highlight) {
  background: rgba(255, 213, 0, 0.35);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.ai-msg-wrap.search-active .ai-text :deep(mark.ai-search-highlight) {
  background: rgba(255, 165, 0, 0.5);
}

/* ── Settings panel ────────────────────────────────────────────────────────── */
.ai-settings {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  box-shadow: 0 -8px 24px rgba(0,0,0,.4);
}
.ai-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
}
.ai-settings-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
}
.ai-settings-close:hover { color: var(--text-bright); }
.ai-settings-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
.ai-settings-row { display: flex; flex-direction: column; gap: 4px; }
.ai-settings-label { font-size: 11px; color: var(--text-muted); }
.ai-toggle-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-bright); cursor: pointer; }
.ai-settings-radios {
  display: flex;
  gap: 12px;
  font-size: 12.5px;
  color: var(--text-bright);
}
.ai-settings-radios label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.ai-settings-input {
  padding: 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
}
.ai-settings-input:focus { border-color: var(--accent-emphasis); }
.ai-settings-select {
  padding: 5px 28px 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236e7681' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  cursor: pointer;
  width: 100%;
}
.ai-settings-select:focus { border-color: var(--accent-emphasis); }
.ai-settings-input--custom { margin-top: 5px; }
.ai-settings-row--column { flex-direction: column; }
.ai-settings-textarea {
  padding: 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
  width: 100%;
  box-sizing: border-box;
}
.ai-settings-textarea:focus { border-color: var(--accent-emphasis); }
.ai-settings-footer { display: flex; justify-content: flex-end; }
.ai-tokens-row { display: flex; align-items: center; gap: 8px; }
.ai-tokens-slider { flex: 1; accent-color: var(--accent-emphasis); }
.ai-tokens-val { font-size: 12px; color: var(--text-bright); min-width: 48px; text-align: right; }
.ai-rules-notice {
  font-size: 11px;
  color: var(--text-muted);
  gap: 5px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.ai-rules-notice code { font-size: 10.5px; background: var(--bg-muted); padding: 0 3px; border-radius: 2px; }
.ai-rules-icon { color: var(--accent-fg); flex-shrink: 0; }
.ai-rules-missing { opacity: 0.6; }
.ai-settings-save {
  padding: 5px 16px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis, #fff);
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.ai-settings-save:hover { opacity: 0.85; }

/* ── Toast ─────────────────────────────────────────────────────────────────── */
/* ── Shortcuts panel ─────────────────────────────────────────────────────── */
/* ── Thread list panel ────────────────────────────────────────────────────── */
.ai-threads-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  max-height: 60%;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  display: flex;
  flex-direction: column;
}
.ai-threads-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.ai-threads-search { padding: 6px 10px 4px; flex-shrink: 0; }
.ai-threads-empty { padding: 10px 14px; font-size: 12px; color: var(--text-muted); text-align: center; }
.ai-threads-list { overflow-y: auto; flex: 1; }
.ai-thread-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.1s;
}
.ai-thread-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ai-thread-snippet { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; }
.ai-thread-meta { display: flex; align-items: center; gap: 4px; }
.ai-thread-item:hover { background: var(--bg-muted); }
.ai-thread-item.active { background: color-mix(in srgb, var(--accent-emphasis) 12%, transparent); }
.ai-thread-title { flex: 1; font-size: 12.5px; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ai-thread-preview { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 0; }
.ai-thread-group-label {
  padding: 5px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  opacity: 0.6;
  user-select: none;
}
.ai-thread-rename-input { flex: 1; font-size: 12.5px; background: var(--bg-input); border: 1px solid var(--accent-emphasis); border-radius: 3px; color: var(--text-bright); padding: 1px 4px; outline: none; min-width: 0; }
.ai-thread-count { font-size: 10px; color: var(--text-on-emphasis, #fff); background: var(--accent-muted); padding: 1px 5px; border-radius: 8px; white-space: nowrap; flex-shrink: 0; }
.ai-thread-time { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.ai-thread-del { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; }
.ai-thread-del:hover { color: var(--danger-fg, #cf222e); background: color-mix(in srgb, var(--danger-fg, #cf222e) 10%, transparent); }
.ai-thread-pin { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.ai-thread-item:hover .ai-thread-pin { opacity: 1; }
.ai-thread-pin:hover { color: var(--accent-fg); }
.ai-thread-pin-indicator { font-size: 10px; flex-shrink: 0; }
.ai-settings-btn.active { color: var(--accent-fg); }

.ai-shortcuts-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  padding: 0 0 8px;
}
.ai-shortcuts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
}
.ai-shortcuts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--text-secondary);
}
.ai-shortcuts-table td { padding: 3px 14px; }
.ai-shortcuts-table td:first-child { width: 40%; }
kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 11px;
  font-family: monospace;
}

.ai-toast {
  position: absolute;
  bottom: 90px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-muted);
  border: 1px solid var(--border-muted);
  color: var(--text-bright);
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 30;
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
}
</style>

<style>
/* highlight.js GitHub Dark theme — token colours */
.hljs { background: transparent; }
.hljs-comment,.hljs-quote { color: #8b949e; font-style: italic; }
.hljs-keyword,.hljs-selector-tag,.hljs-addition { color: #ff7b72; }
.hljs-number,.hljs-string,.hljs-meta .hljs-meta-string,.hljs-literal,.hljs-doctag,.hljs-regexp { color: #a5d6ff; }
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class { color: #d2a8ff; font-weight: 600; }
.hljs-attribute,.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-class .hljs-title,.hljs-type { color: #ffa657; }
.hljs-symbol,.hljs-bullet,.hljs-subst,.hljs-meta,.hljs-selector-attr,.hljs-selector-pseudo { color: #79c0ff; }
.hljs-built_in,.hljs-deletion { color: #ffa657; }
.hljs-formula { background: #161b22; }
.hljs-strong { font-weight: bold; }
.hljs-emphasis { font-style: italic; }
.hljs-tag { color: #7ee787; }
.hljs-punctuation { color: #8b949e; }
.hljs-string { color: #a5d6ff; }
.hljs-operator,.hljs-params { color: #e6edf3; }
</style>
