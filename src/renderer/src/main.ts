import { createApp } from 'vue'
import { i18n } from './i18n'

// Theme token layers — order matters: primitives → semantic roles → theme overrides.
import './styles/tokens/base.css'
import './styles/tokens/semantic.css'
import './styles/tokens/themes/dark-midnight.css'
import './styles/tokens/themes/dark-forest.css'
import './styles/tokens/themes/light.css'
import './styles/tokens/themes/high-contrast.css'

import App from './App.vue'
import RolesManagerApp from './RolesManagerApp.vue'
import StagesEditorApp from './StagesEditorApp.vue'
import EditorWindowApp from './EditorWindowApp.vue'

// Window-type dispatcher: Electron main appends `?window=roles`, `?window=stages`,
// or `?window=editor` for secondary windows. Default is the main shell.
const params = new URLSearchParams(window.location.search)
const which = params.get('window') ?? 'main'

const Root =
  which === 'roles'
    ? RolesManagerApp
    : which === 'stages'
      ? StagesEditorApp
      : which === 'editor'
        ? EditorWindowApp
        : App

// ── Fail-loud diagnostics ─────────────────────────────────────────────────────
// Secondary windows render into their own renderer; if mount throws the window
// goes silently black. Surface the error on-screen + console — but ONLY when the
// app actually failed to render (so benign transient rejections, e.g. a
// pre-connect "ws not open", never wipe a working UI).
function logErr(label: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[renderer:${which}] ${label}`, err)
}

function showFatalIfBlank(label: string, err: unknown): void {
  logErr(label, err)
  const host = document.getElementById('app')
  // Only take over the screen when nothing has rendered into #app.
  if (!host || host.childElementCount > 0) return
  const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
  const box = document.createElement('pre')
  box.style.cssText =
    'margin:0;padding:16px;height:100vh;overflow:auto;background:#1a0d0d;color:#ff9a9a;' +
    'font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;'
  box.textContent = `⚠ ${label} (window=${which})\n\n${detail}`
  host.replaceChildren(box)
}

// Uncaught sync errors can blank a window before mount; promise rejections are
// usually benign (network/ws timing) so they only log.
window.addEventListener('error', (e) => showFatalIfBlank('Uncaught error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => logErr('Unhandled promise rejection', e.reason))

try {
  const app = createApp(Root)
  app.use(i18n)
  app.config.errorHandler = (err, _instance, info) => showFatalIfBlank(`Vue error (${info})`, err)
  app.mount('#app')
} catch (err) {
  showFatalIfBlank('App failed to mount', err)
}
