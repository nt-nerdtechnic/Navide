/// <reference types="vite/client" />
import { createI18n } from 'vue-i18n'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import { settingsGet } from '../../shared'

const LANGUAGE_KEY = 'agent-team:language'

function getInitialLocale(): string {
  // Synchronous read from the bootstrap-seeded settings cache — available
  // before first paint, so the initial locale never flashes.
  const saved = settingsGet<string | null>(LANGUAGE_KEY, null)
  if (saved === 'zh-TW' || saved === 'en-US' || saved === 'ja-JP') return saved
  const browser = navigator.language
  if (/^zh-(TW|Hant|HK)/i.test(browser) || /^zh/i.test(browser)) return 'zh-TW'
  if (/^en/i.test(browser)) return 'en-US'
  if (/^ja/i.test(browser)) return 'ja-JP'
  return 'zh-TW'
}

const messages = {
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
}

function createInstance() {
  return createI18n({
    legacy: false,
    locale: getInitialLocale(),
    fallbackLocale: 'zh-TW',
    messages,
  })
}

// Vite HMR re-runs this module whenever a locale file is edited. A second
// createI18n() would leave the app rendering through the instance main.ts
// installed while later importers (useSettings) switch the locale on the new
// one, so picking a language would stop reaching the screen. Keep the
// installed instance across reloads and only swap in the edited messages.
const hotData = import.meta.hot?.data as { i18n?: unknown } | undefined
export const i18n: ReturnType<typeof createInstance> =
  (hotData?.i18n as ReturnType<typeof createInstance> | undefined) ?? createInstance()
if (hotData) {
  hotData.i18n = i18n
  for (const [locale, bundle] of Object.entries(messages)) i18n.global.setLocaleMessage(locale, bundle)
}

export { default as enUSMessages } from './locales/en-US.json'
export { default as zhTWMessages } from './locales/zh-TW.json'
export { default as jaJPMessages } from './locales/ja-JP.json'
