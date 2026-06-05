import { JsTokenizer } from './jsTokenizer'
import { JsonTokenizer } from './jsonTokenizer'
import { PythonTokenizer } from './pythonTokenizer'
import { CssTokenizer } from './cssTokenizer'
import type { Tokenizer } from '../types'

export { JsTokenizer } from './jsTokenizer'
export { JsonTokenizer } from './jsonTokenizer'
export { PythonTokenizer } from './pythonTokenizer'
export { CssTokenizer } from './cssTokenizer'

export function tokenizerFor(lang: string): Tokenizer {
  switch (lang.toLowerCase()) {
    case 'json':
    case 'jsonc':
      return JsonTokenizer
    case 'py':
      return PythonTokenizer
    case 'css':
    case 'scss':
    case 'less':
      return CssTokenizer
    default:
      return JsTokenizer
  }
}
