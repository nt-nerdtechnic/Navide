import { createApp } from 'vue'
import App from './App.vue'
import RolesManagerApp from './RolesManagerApp.vue'
import StagesEditorApp from './StagesEditorApp.vue'
import DiffWindowApp from './DiffWindowApp.vue'

// Window-type dispatcher: Electron main appends `?window=roles`, `?window=stages`
// or `?window=diff` for secondary windows. Default is the main shell.
const params = new URLSearchParams(window.location.search)
const which = params.get('window') ?? 'main'

const Root =
  which === 'roles'
    ? RolesManagerApp
    : which === 'stages'
      ? StagesEditorApp
      : which === 'diff'
        ? DiffWindowApp
        : App
createApp(Root).mount('#app')
