import { JsTokenizer } from './jsTokenizer'
import { JsonTokenizer } from './jsonTokenizer'
import { PythonTokenizer } from './pythonTokenizer'
import { CssTokenizer } from './cssTokenizer'
import { MarkdownTokenizer } from './markdownTokenizer'
import type { Tokenizer } from '../types'

export { JsTokenizer } from './jsTokenizer'
export { JsonTokenizer } from './jsonTokenizer'
export { PythonTokenizer } from './pythonTokenizer'
export { CssTokenizer } from './cssTokenizer'
export { MarkdownTokenizer } from './markdownTokenizer'

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
    case 'md':
    case 'mdx':
      return MarkdownTokenizer
    default:
      return JsTokenizer
  }
}
