// Mini-IDE plugin entry — Phase 2 M4.
//
// Mounts the UNMODIFIED EditorWindowApp.vue inside the isolated plugin
// WebContentsView. It boots exactly like the secondary editor window
// (src/renderer/src/main.ts, `?window=editor`): the same theme-token CSS layers
// and i18n, then `createApp(EditorWindowApp).mount('#app')`.
//
// The one difference is invisible to the app source: the plugin build aliases
// `composables/useBackend` to `./capabilityBackend`, so every `send`/`on` inside
// EditorWindowApp, AIChatPane, useGit, … is routed through `window.nav` (the
// host capability broker) instead of a direct WebSocket. EditorWindowApp still
// reads its `workspace_path` / `filepath` from `window.location.search`, which
// the host sets when it loads this entry — no injection needed here.

import { createApp } from 'vue'
import { i18n } from '../../src/i18n'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '../../src/styles/tokens/base.css'
import '../../src/styles/tokens/semantic.css'
import '../../src/styles/tokens/themes/dark-midnight.css'
import '../../src/styles/tokens/themes/dark-forest.css'
import '../../src/styles/tokens/themes/light.css'
import '../../src/styles/tokens/themes/high-contrast.css'

import EditorWindowApp from '../../src/EditorWindowApp.vue'

// Announce readiness to the host broker (mirrors the noop/fs_probe plugins).
window.nav?.ready?.()

const app = createApp(EditorWindowApp)
app.use(i18n)
app.mount('#app')
