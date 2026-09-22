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

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-TW',
  messages: {
    'zh-TW': zhTW,
    'en-US': enUS,
    'ja-JP': jaJP,
  },
})

export { default as enUSMessages } from './locales/en-US.json'
export { default as zhTWMessages } from './locales/zh-TW.json'
export { default as jaJPMessages } from './locales/ja-JP.json'
