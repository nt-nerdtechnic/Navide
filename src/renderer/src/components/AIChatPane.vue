<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  embedded?: boolean
  active?: boolean
  getEditorContent?: () => string
  getActiveRelPath?: () => string
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
  rawContent?: string  // full content sent to AI (includes @chip file/git content)
  streaming?: boolean
  thinking?: boolean   // true until first chunk arrives
  model?: string
  timestamp?: number   // ms since epoch
  isError?: boolean    // true when last chunk was an error
  errorMsg?: string
  cards?: Array<ToolCallCard | EditProposalCard | CommandProposalCard>
}

// ── State ──────────────────────────────────────────────────────────────────────
const messages = ref<ChatMessage[]>([])
const inputText = ref('')
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

// ── Conversation persistence (localStorage) ────────────────────────────────────
const historyKey = computed(() => `ai-chat-history:${props.workspacePath}`)

function loadHistory(): void {
  try {
    const raw = localStorage.getItem(historyKey.value)
    if (!raw) return
    const saved = JSON.parse(raw) as ChatMessage[]
    // Drop any incomplete streaming messages from a previous session
    messages.value = saved.filter((m) => !m.streaming).slice(-100)
  } catch { /* ignore corrupt storage */ }
}

function saveHistory(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      const toSave = messages.value.filter((m) => !m.streaming).slice(-100)
      localStorage.setItem(historyKey.value, JSON.stringify(toSave))
    } catch { /* quota or serialization error */ }
  }, 1000)
}

watch(messages, saveHistory, { deep: true })

// ── Settings ───────────────────────────────────────────────────────────────────
const settingsProvider = ref<'anthropic' | 'ollama'>('anthropic')
const settingsApiKey = ref('')
const settingsModel = ref('claude-sonnet-4-6')
const settingsOllamaUrl = ref('http://localhost:11434')
const settingsSystemPrompt = ref('You are a helpful AI coding assistant.')

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

// Input char counter + token estimate (shown when > 200 chars)
const inputCharCount = computed(() => inputText.value.length)
const inputTokenEstimate = computed(() => Math.ceil(inputCharCount.value / 4))

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

// ── Context chips (@mentions) ──────────────────────────────────────────────────
interface ContextChip {
  id: string
  label: string
  content: string
}
const contextChips = ref<ContextChip[]>([])
const showAtMenu = ref(false)
const atMenuFilter = ref('')
const atMenuIdx = ref(0)
const atMenuEl = ref<HTMLElement | null>(null)

interface AtOption { id: string; label: string }
const AT_OPTIONS_STATIC: AtOption[] = [
  { id: '@file', label: '@file — 目前開啟的檔案' },
  { id: '@selection', label: '@selection — 編輯器選取內容' },
  { id: '@git', label: '@git — 目前 git diff (unstaged)' },
]
const atDirItems = ref<AtOption[]>([])

const atOptions = ref<AtOption[]>([...AT_OPTIONS_STATIC])

// ── Slash commands ────────────────────────────────────────────────────────────
interface SlashCommand { id: string; label: string; description: string; template: string }
const SLASH_COMMANDS: SlashCommand[] = [
  { id: '/explain', label: '/explain', description: '解釋程式碼', template: '請詳細解釋以下程式碼的功能與邏輯：' },
  { id: '/fix',     label: '/fix',     description: '修復問題',   template: '請找出並修復以下程式碼中的問題：' },
  { id: '/tests',   label: '/tests',   description: '生成測試',   template: '請為以下程式碼撰寫完整的單元測試：' },
  { id: '/doc',     label: '/doc',     description: '撰寫文件',   template: '請為以下程式碼撰寫清晰的文件與說明：' },
  { id: '/review',   label: '/review',   description: '程式碼審查', template: '請對以下程式碼進行 code review，指出潛在問題與改善建議：' },
  { id: '/optimize', label: '/optimize', description: '效能優化',   template: '請分析以下程式碼的效能瓶頸，並提供優化建議與改善版本：' },
  { id: '/refactor', label: '/refactor', description: '重構程式碼', template: '請對以下程式碼進行重構，提升可讀性與維護性，保持功能不變：' },
  { id: '/clear',    label: '/clear',    description: '清除對話',   template: '' },
  { id: '/export',   label: '/export',   description: '匯出對話',   template: '' },
]
const showSlashMenu = ref(false)
const slashMenuFilter = ref('')
const slashMenuIdx = ref(0)
const slashMenuEl = ref<HTMLElement | null>(null)
const slashOptions = ref<SlashCommand[]>([...SLASH_COMMANDS])

// ── Code-block copy via event delegation ─────────────────────────────────────
function onMessagesClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLButtonElement>('.ai-code-copy-btn')
  if (!btn) return
  try {
    const code = decodeURIComponent(escape(atob(btn.dataset.code ?? '')))
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!'
      window.setTimeout(() => { btn.textContent = 'Copy' }, 1500)
    }).catch(() => {/* ignore */})
  } catch {/* ignore */}
}

// ── Markdown lite renderer ─────────────────────────────────────────────────────
function renderMarkdownLite(rawText: string): string {
  // 1. Extract fenced code blocks so they are never touched by inline transforms
  const blocks: string[] = []
  let text = rawText.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const safe = code.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const langLabel = lang || 'code'
    // Encode raw code for copy button (btoa with URI encode for unicode safety)
    const encoded = btoa(unescape(encodeURIComponent(code.trim())))
    const i = blocks.length
    blocks.push(
      `<div class="ai-code-wrap">` +
      `<div class="ai-code-header">` +
      `<span class="ai-code-lang">${langLabel}</span>` +
      `<button class="ai-code-copy-btn" data-code="${encoded}">Copy</button>` +
      `</div>` +
      `<pre class="ai-code-block"><code>${safe}</code></pre>` +
      `</div>`,
    )
    return `\x00B${i}\x00`
  })
  // HTML-escape non-code-block content to prevent XSS via v-html
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 2. Line-by-line: headings, lists, blank lines
  const lines = text.split('\n')
  const parts: string[] = []
  let inUl = false, inOl = false
  const flushList = () => {
    if (inUl) { parts.push('</ul>'); inUl = false }
    if (inOl) { parts.push('</ol>'); inOl = false }
  }
  for (const line of lines) {
    // Code block placeholder (whole line)
    if (/^\x00B\d+\x00$/.test(line.trim())) {
      flushList(); parts.push(line.trim()); continue
    }
    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushList(); parts.push('<hr class="ai-hr">'); continue
    }
    // Heading: #, ##, ###, ####
    const hm = line.match(/^(#{1,4})\s+(.+)/)
    if (hm) {
      flushList()
      const lvl = Math.min(hm[1].length + 1, 5)
      parts.push(`<h${lvl} class="ai-h">${hm[2]}</h${lvl}>`)
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
  flushList()

  let html = parts.join('')

  // 3. Inline transforms (safe: never match inside code blocks — those are placeholders now)
  // Bold
  html = html.replace(/\*\*([^*<\n]+)\*\*/g, '<strong>$1</strong>')
  // Italic (only single *, guard against **)
  html = html.replace(/(?<!\*)\*([^*<\n]+)\*(?!\*)/g, '<em>$1</em>')
  // Strikethrough
  html = html.replace(/~~([^~<\n]+)~~/g, '<del>$1</del>')
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_, c) =>
    `<code class="ai-inline-code">${c.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`,
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

// ── Tool call human-readable summary ─────────────────────────────────────────
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
  props.backend.send('ai.chat.settings.set', {
    provider: settingsProvider.value,
    anthropic_api_key: settingsApiKey.value,
    model: settingsModel.value,
    ollama_base_url: settingsOllamaUrl.value,
    system_prompt: settingsSystemPrompt.value,
  }).catch(() => {/* ignore */})
  showSettings.value = false
  showToast('設定已儲存')
}

// ── Send message ───────────────────────────────────────────────────────────────
async function sendMessage(): Promise<void> {
  const rawText = inputText.value.trim()
  if (!rawText && contextChips.value.length === 0) return
  if (sending.value) return

  // Build user content with context chips prepended
  let fullContent = ''
  for (const chip of contextChips.value) {
    fullContent += `[Context: ${chip.label}]\n${chip.content}\n\n`
  }
  if (rawText) {
    fullContent += `[User]: ${rawText}`
  }
  const displayText = rawText || contextChips.value.map((c) => c.label).join(' ')
  const sentContent = fullContent || displayText

  messages.value.push({ role: 'user', content: displayText, rawContent: sentContent, timestamp: Date.now() })
  contextChips.value = []
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
    await props.backend.send('ai.chat.start', {
      session_id: sessionId,
      messages: history,
      workspace_path: props.workspacePath,
    })
  } catch {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false; last.thinking = false
      last.isError = true; last.errorMsg = '無法連線到後端'
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
}

// ── Clear conversation ─────────────────────────────────────────────────────────
function clearConversation(): void {
  if (sending.value) stopStreaming()
  messages.value = []
  localStorage.removeItem(historyKey.value)
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
  saveHistory()
  nextTick(() => textareaEl.value?.focus())
}

// ── Copy message ───────────────────────────────────────────────────────────────
// ── Export conversation ────────────────────────────────────────────────────────
async function exportConversation(): Promise<void> {
  if (messages.value.filter((m) => !m.streaming).length === 0) {
    showToast('沒有對話可匯出')
    return
  }
  let md = '# AI Chat Export\n\n'
  for (const msg of messages.value) {
    if (msg.streaming) continue
    const roleLabel = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` (${msg.model})` : ''}`
    md += `### ${roleLabel}\n\n${msg.content}\n\n---\n\n`
  }
  try {
    const r = await window.agentTeam?.saveJson({ defaultName: 'ai-chat-export.md', content: md, title: '匯出對話' })
    if (r && !r.ok && !r.canceled) showToast('匯出失敗')
    else if (r?.ok) showToast('對話已匯出')
  } catch { showToast('匯出失敗') }
}

function copyMessage(content: string): void {
  const plain = content.replace(/```[\s\S]*?```/g, (m) => m).replace(/<[^>]+>/g, '')
  navigator.clipboard.writeText(plain).then(() => showToast('已複製')).catch(() => showToast('複製失敗'))
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
      last.isError = true; last.errorMsg = '無法連線到後端'
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
    showToast(`已套用：${card.file_path}`)
  } catch {
    showToast('套用失敗')
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
    if (last?.streaming) { last.streaming = false; last.thinking = false }
    sending.value = false
    currentSessionId.value = null
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
      ollama_base_url?: string; system_prompt?: string
    }
    if (p.provider === 'anthropic' || p.provider === 'ollama') settingsProvider.value = p.provider
    if (p.anthropic_api_key) settingsApiKey.value = p.anthropic_api_key
    if (p.model) settingsModel.value = p.model
    if (p.ollama_base_url) settingsOllamaUrl.value = p.ollama_base_url
    // Use !== undefined so clearing system_prompt to "" is properly reflected in UI
    if (p.system_prompt !== undefined) settingsSystemPrompt.value = p.system_prompt
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

onMounted(() => {
  setupListeners()
  fetchSettings()
  loadHistory()
})

onUnmounted(() => {
  teardownListeners()
  if (toastTimer !== null) clearTimeout(toastTimer)
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
  if (fragment.includes(' ')) { showAtMenu.value = false; return }

  atMenuFilter.value = fragment
  atMenuIdx.value = 0
  showAtMenu.value = true

  const lower = fragment.toLowerCase()
  const filtered: AtOption[] = AT_OPTIONS_STATIC.filter(
    (o) => o.label.toLowerCase().includes(lower) || o.id.toLowerCase().includes(lower),
  )
  for (const item of atDirItems.value) {
    if (item.label.toLowerCase().includes(lower)) filtered.push(item)
  }
  atOptions.value = filtered.length ? filtered : AT_OPTIONS_STATIC

  if (fragment.length >= 1 && !fragment.startsWith('@')) {
    void searchFiles(fragment)
  }
}

function selectSlashCommand(cmd: SlashCommand): void {
  showSlashMenu.value = false
  if (cmd.id === '/clear') {
    inputText.value = ''
    clearConversation()
    return
  }
  if (cmd.id === '/export') {
    inputText.value = ''
    void exportConversation()
    return
  }
  inputText.value = cmd.template + ' '
  nextTick(() => {
    textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
  })
}

async function searchFiles(query: string): Promise<void> {
  try {
    interface LsResp { ok: boolean; entries?: Array<{ name: string; is_dir: boolean; rel_path: string }> }
    const lower = query.toLowerCase()
    const found: AtOption[] = []

    // BFS over directory tree up to 2 levels deep to find matching files
    const dirsToVisit = ['', ...await _listSubdirs('')]
    await Promise.all(dirsToVisit.map(async (dir) => {
      const resp = await props.backend.send<LsResp>('fs.list_dir', {
        workspace_path: props.workspacePath,
        rel_path: dir,
        show_hidden: false,
      })
      for (const e of resp.payload?.entries ?? []) {
        if (!e.is_dir && e.name.toLowerCase().includes(lower)) {
          found.push({ id: e.rel_path, label: `@${e.rel_path}` })
        }
      }
    }))

    atDirItems.value = found.slice(0, 12)
    const filtered: AtOption[] = [
      ...AT_OPTIONS_STATIC.filter((o) => o.label.toLowerCase().includes(lower)),
      ...atDirItems.value,
    ]
    atOptions.value = filtered.length ? filtered : AT_OPTIONS_STATIC
  } catch {
    // ignore
  }
}

async function _listSubdirs(relPath: string): Promise<string[]> {
  interface LsResp { ok: boolean; entries?: Array<{ name: string; is_dir: boolean; rel_path: string }> }
  try {
    const resp = await props.backend.send<LsResp>('fs.list_dir', {
      workspace_path: props.workspacePath,
      rel_path: relPath,
      show_hidden: false,
    })
    return (resp.payload?.entries ?? [])
      .filter((e) => e.is_dir)
      .map((e) => e.rel_path)
  } catch {
    return []
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
    chipLabel = relPath ? `@${relPath.split('/').pop()}` : '@file'
    chipContent = relPath ? `// ${relPath}\n${content}` : content
  } else if (option.id === '@selection') {
    const content = props.getEditorContent?.() ?? ''
    chipLabel = '@selection'
    chipContent = content
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
      contextChips.value.push({
        id: crypto.randomUUID(),
        label,
        content: `// ${relPath}\n${resp.payload?.content ?? ''}`,
      })
    } catch {
      showToast(`無法讀取：${relPath}`)
    }
  }
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

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendMessage()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    openSearch()
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
}

onMounted(() => document.addEventListener('click', onClickOutside))
onUnmounted(() => document.removeEventListener('click', onClickOutside))
</script>

<template>
  <div class="ai-chat">
    <!-- Messages list -->
    <div ref="messagesEl" class="ai-messages" @click="onMessagesClick" @scroll.passive="onMessagesScroll">
      <div v-if="messages.length === 0" class="ai-empty">
        <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" style="opacity:.35">
          <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
        </svg>
        <p>AI 助理就緒，輸入訊息或 @ 注入 context</p>
      </div>

      <div
        v-for="(msg, mi) in messages"
        :key="mi"
        class="ai-msg-wrap ai-msg"
        :class="[msg.role, { 'search-match': isSearchMatch(mi), 'search-active': isSearchActive(mi) }]"
      >
        <!-- Bubble -->
        <div class="ai-bubble" :class="msg.role">
          <!-- Text content -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-if="msg.content" class="ai-text" v-html="renderMarkdownLite(msg.content)" />

          <!-- Cards (tool calls / edit proposals) -->
          <template v-if="msg.cards">
            <template v-for="(card, ci) in msg.cards" :key="ci">
              <!-- Tool call card -->
              <div v-if="card.kind === 'tool_call'" class="ai-tool-card">
                <div class="ai-tool-header" @click="card.collapsed = !card.collapsed">
                  <span class="ai-tool-name">⚙ {{ getToolSummary(card.tool_name, card.tool_input) }}</span>
                  <span class="ai-tool-toggle">{{ card.collapsed ? '▶' : '▼' }}</span>
                </div>
                <div v-if="!card.collapsed" class="ai-tool-body">
                  <pre class="ai-tool-pre">{{ JSON.stringify(card.tool_input, null, 2) }}</pre>
                  <div v-if="card.result != null" class="ai-tool-result">
                    <span class="ai-tool-result-label">結果：</span>{{ card.result }}
                  </div>
                </div>
              </div>

              <!-- Command proposal card -->
              <div v-else-if="card.kind === 'command_proposal'" class="ai-cmd-card" :class="card.status">
                <div class="ai-cmd-header">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>
                  <span class="ai-cmd-label">執行命令</span>
                  <span v-if="card.status === 'approved'" class="ai-cmd-status approved">已執行 ✓</span>
                  <span v-else-if="card.status === 'rejected'" class="ai-cmd-status rejected">已拒絕 ✕</span>
                  <div v-else class="ai-cmd-actions">
                    <button class="ai-cmd-btn approve" @click="approveCommand(card)">執行</button>
                    <button class="ai-cmd-btn reject" @click="rejectCommand(card)">拒絕</button>
                  </div>
                </div>
                <pre class="ai-cmd-pre">$ {{ card.command }}{{ card.cwd ? `\n# cwd: ${card.cwd}` : '' }}</pre>
              </div>

              <!-- Edit proposal card -->
              <div v-else-if="card.kind === 'edit_proposal' && !card.discarded" class="ai-edit-card">
                <div class="ai-edit-header">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
                  <span class="ai-edit-path">{{ card.file_path }}</span>
                  <div v-if="!card.accepted" class="ai-edit-actions">
                    <button class="ai-edit-btn accept" @click="acceptEdit(card)">Accept</button>
                    <button class="ai-edit-btn discard" @click="discardEdit(card)">Discard</button>
                  </div>
                  <span v-else class="ai-edit-accepted">已套用 ✓</span>
                </div>
                <div class="ai-diff-view" v-html="renderDiff(card.diff)" />
              </div>
            </template>
          </template>

          <!-- Thinking indicator (before first chunk) -->
          <div v-if="msg.thinking" class="ai-thinking">
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
          </div>
          <span v-else-if="msg.streaming" class="ai-cursor">▍</span>

          <!-- Error card -->
          <div v-if="msg.isError" class="ai-error-card">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">
              <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
            </svg>
            <span class="ai-error-msg">{{ msg.errorMsg || '發生錯誤' }}</span>
            <button class="ai-error-retry" @click="retryAfterError">重試</button>
          </div>
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
            title="編輯並重送"
            @click="editMessage(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
          </button>
          <button class="ai-msg-action-btn" title="複製" @click="copyMessage(msg.content)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && mi === lastAssistantIdx && !sending"
            class="ai-msg-action-btn"
            title="重新生成"
            @click="regenerate"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
          </button>
          <span v-if="msg.timestamp" class="ai-msg-time">
            {{ new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Scroll-to-bottom button (shown when user has scrolled up during streaming) -->
    <button
      v-if="sending && !autoScroll"
      class="ai-scroll-to-bottom"
      title="捲到最新"
      @click="autoScroll = true; scrollBottom(true)"
    >
      ↓ 捲到最新
    </button>

    <!-- Search bar -->
    <div v-if="showSearch" class="ai-search-bar">
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="ai-search-input"
        placeholder="搜尋對話…"
        @keydown.escape="closeSearch"
        @keydown.enter.prevent="searchNav(1)"
      />
      <span class="ai-search-count">
        {{ searchMatches.length ? `${searchMatchIdx + 1}/${searchMatches.length}` : '無結果' }}
      </span>
      <button class="ai-search-nav" title="上一個" @click="searchNav(-1)">↑</button>
      <button class="ai-search-nav" title="下一個" @click="searchNav(1)">↓</button>
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
        >
          {{ chip.label }}
          <button class="ai-chip-remove" @click="removeChip(chip.id)">×</button>
        </span>
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

      <div class="ai-input-row">
        <div class="ai-textarea-wrap">
          <textarea
            ref="textareaEl"
            v-model="inputText"
            class="ai-textarea"
            placeholder="輸入訊息… (@ 注入 context，Enter 送出，Shift+Enter 換行)"
            :disabled="sending"
            rows="1"
            @input="onTextareaInput"
            @keydown="onTextareaKeydown"
          />
          <span v-if="inputCharCount > 200" class="ai-char-count" :class="{ warn: inputCharCount > 2000 }">
            {{ inputCharCount.toLocaleString() }} 字 · ~{{ inputTokenEstimate.toLocaleString() }} tokens
          </span>
        </div>
        <div class="ai-input-btns">
          <button
            v-if="!sending"
            class="ai-send-btn"
            :disabled="!inputText.trim() && contextChips.length === 0"
            title="送出 (Enter)"
            @click="sendMessage"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13 5.5a1.343 1.343 0 0 1 0 2.564l-13 5.5a1.342 1.342 0 0 1-1.85-1.463L.989 8Zm.603-5.353L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.603L13.5 8 1.592 2.647Z"/>
            </svg>
          </button>
          <button
            v-else
            class="ai-stop-btn"
            title="停止"
            @click="stopStreaming"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            title="搜尋對話 (Ctrl+F)"
            :disabled="messages.length === 0"
            @click="openSearch"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            title="清除對話"
            :disabled="messages.length === 0"
            @click="clearConversation"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            title="快捷鍵 (?)"
            @click="showShortcuts = !showShortcuts"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM5 8.5H2.75a.75.75 0 0 1 0-1.5H5a.75.75 0 0 1 0 1.5Zm2.5 2h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm0-4h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm5.75 4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Zm0-4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            title="設定"
            @click="showSettings = !showSettings"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 9.99 1.409v.526c0 .384.214.706.535.862a6.98 6.98 0 0 1 .606.331c.316.19.693.16.965-.066l.372-.323a1.402 1.402 0 0 1 1.947.162l.739.845c.45.515.433 1.28-.037 1.773l-.365.388c-.224.238-.285.58-.152.892.144.343.27.694.374 1.052.098.339.364.59.706.643l.529.082c.764.119 1.282.823 1.2 1.593l-.116 1.112c-.076.729-.7 1.263-1.437 1.178l-.531-.065c-.345-.042-.668.163-.805.481a6.887 6.887 0 0 1-.376 1.053c-.134.312-.072.654.153.892l.365.388c.469.494.486 1.258.037 1.773l-.74.845a1.402 1.402 0 0 1-1.947.162l-.373-.324c-.272-.225-.648-.255-.963-.065-.198.12-.408.228-.61.331a.993.993 0 0 0-.535.862v.526c0 .764-.546 1.314-1.289 1.378A8.2 8.2 0 0 1 8 16a8.2 8.2 0 0 1-.701-.031C6.556 15.905 6.01 15.355 6.01 14.591v-.526a.993.993 0 0 0-.535-.862 6.942 6.942 0 0 1-.607-.331c-.315-.19-.691-.16-.963.065l-.373.324a1.402 1.402 0 0 1-1.947-.162l-.739-.845c-.45-.515-.433-1.28.037-1.773l.365-.388c.224-.238.285-.58.152-.892a6.933 6.933 0 0 1-.374-1.053c-.098-.339-.364-.59-.706-.643l-.529-.082C.236 9.177-.282 8.473-.2 7.703l.116-1.112C-.008 5.862.616 5.328 1.353 5.413l.531.065c.345.042.668-.163.805-.481A6.887 6.887 0 0 1 3.065 3.944c.134-.312.072-.654-.153-.892L2.547 2.664C2.078 2.17 2.061 1.406 2.51.891l.74-.845A1.402 1.402 0 0 1 5.197.884l.372.323c.272.226.649.256.965.066a6.98 6.98 0 0 1 .606-.331A.993.993 0 0 0 7.675 1.935V1.409C7.675.645 8.221.095 8.964.031 8.977.01 8.988 0 9 0H8ZM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Settings panel -->
    <div v-if="showSettings" class="ai-settings">
      <div class="ai-settings-header">
        <span>AI 設定</span>
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
            <option value="custom">自訂…</option>
          </select>
          <input
            v-if="modelIsCustom"
            v-model="settingsModel"
            type="text"
            class="ai-settings-input ai-settings-input--custom"
            placeholder="輸入 model ID"
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
        <div class="ai-settings-footer">
          <button class="ai-settings-save" @click="saveSettings">儲存</button>
        </div>
      </div>
    </div>

    <!-- Keyboard shortcuts panel -->
    <div v-if="showShortcuts" class="ai-shortcuts-panel">
      <div class="ai-shortcuts-header">
        <span>鍵盤快捷鍵</span>
        <button class="ai-settings-close" @click="showShortcuts = false">✕</button>
      </div>
      <table class="ai-shortcuts-table">
        <tbody>
          <tr><td><kbd>Enter</kbd></td><td>送出訊息</td></tr>
          <tr><td><kbd>Shift+Enter</kbd></td><td>換行</td></tr>
          <tr><td><kbd>Ctrl+F</kbd></td><td>搜尋對話</td></tr>
          <tr><td><kbd>@</kbd></td><td>插入 context（檔案、selection、git）</td></tr>
          <tr><td><kbd>/</kbd></td><td>Slash 指令（/explain、/fix…）</td></tr>
          <tr><td><kbd>Escape</kbd></td><td>關閉選單 / 搜尋列</td></tr>
          <tr><td>拖曳檔案</td><td>將檔案加入 context</td></tr>
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
}
.ai-empty p { margin: 0; }

.ai-msg-wrap { display: flex; flex-direction: column; }
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
.ai-text :deep(code.ai-inline-code) {
  background: var(--bg-muted);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 0.9em;
}
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
.ai-tool-name { font-family: ui-monospace, Menlo, monospace; color: var(--accent-fg); font-weight: 600; }
.ai-tool-toggle { color: var(--text-muted); font-size: 10px; }
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
