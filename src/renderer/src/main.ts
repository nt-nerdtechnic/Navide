import { createApp } from 'vue'

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
import DiffWindowApp from './DiffWindowApp.vue'
import EditorWindowApp from './EditorWindowApp.vue'

// Window-type dispatcher: Electron main appends `?window=roles`, `?window=stages`,
// `?window=diff` or `?window=editor` for secondary windows. Default is the main shell.
const params = new URLSearchParams(window.location.search)
const which = params.get('window') ?? 'main'

const Root =
  which === 'roles'
    ? RolesManagerApp
    : which === 'stages'
      ? StagesEditorApp
      : which === 'diff'
        ? DiffWindowApp
        : which === 'editor'
          ? EditorWindowApp
          : App
createApp(Root).mount('#app')
