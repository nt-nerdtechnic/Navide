import { ref } from 'vue'
import { i18n } from '../i18n'

const LANGUAGE_KEY = 'agent-team:language'
const SUPPORTED = new Set(['zh-TW', 'en-US'])

function normalizeLocale(raw: string): string {
  if (/^zh-(TW|Hant|HK)/i.test(raw) || /^zh/i.test(raw)) return 'zh-TW'
  if (/^en/i.test(raw)) return 'en-US'
  return 'zh-TW'
}

function readLocal(): string | null {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY)
    return v && SUPPORTED.has(v) ? v : null
  } catch {
    return null
  }
}

function writeLocal(value: string): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, value)
  } catch {
    // storage unavailable — non-fatal
  }
}

// Module-level singleton — shared across every component that calls useSettings().
const language = ref<string>(i18n.global.locale.value as string)

function loadLanguage(backendFallback?: { language?: string }): void {
  const local = readLocal()
  if (local) {
    language.value = local
    i18n.global.locale.value = local as 'zh-TW' | 'en-US'
    return
  }
  const backend = backendFallback?.language && SUPPORTED.has(backendFallback.language)
    ? backendFallback.language
    : null
  const next = backend ?? normalizeLocale(navigator.language)
  language.value = next
  i18n.global.locale.value = next as 'zh-TW' | 'en-US'
  if (backend) writeLocal(next)
}

function setLanguage(locale: string): void {
  if (!SUPPORTED.has(locale)) return
  language.value = locale
  i18n.global.locale.value = locale as 'zh-TW' | 'en-US'
  writeLocal(locale)
  window.agentTeam?.broadcastLanguageChange?.(locale)
}

async function syncToBackend(
  sender: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  workspacePath: string,
): Promise<void> {
  if (!workspacePath) return
  try {
    await sender('project.set_language', {
      workspace_path: workspacePath,
      language: language.value,
    })
  } catch {
    // backup only — ignore failures
  }
}

export function useSettings() {
  return { language, loadLanguage, setLanguage, syncToBackend }
}
