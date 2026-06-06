import { createI18n } from 'vue-i18n'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'

const LANGUAGE_KEY = 'agent-team:language'

function getInitialLocale(): string {
  const saved = localStorage.getItem(LANGUAGE_KEY)
  if (saved === 'zh-TW' || saved === 'en-US') return saved
  const browser = navigator.language
  if (/^zh-(TW|Hant|HK)/i.test(browser) || /^zh/i.test(browser)) return 'zh-TW'
  if (/^en/i.test(browser)) return 'en-US'
  return 'zh-TW'
}

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-TW',
  messages: {
    'zh-TW': zhTW,
    'en-US': enUS,
  },
})
