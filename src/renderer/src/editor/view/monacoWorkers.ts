import type { Environment } from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// Wire Monaco's web workers through Vite's native ?worker imports.
//
// vite-plugin-monaco-editor injects MonacoEnvironment paths pointing at
// ./monacoeditorwork/*.worker.bundle.js, but in packaged builds the app loads
// over file:// where that directory does not exist — worker creation fails and
// the editor view collapses. Vite's ?worker import emits correctly hashed URLs
// that resolve under both the dev server and file://.
const env: Environment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

;(self as unknown as { MonacoEnvironment: Environment }).MonacoEnvironment = env
