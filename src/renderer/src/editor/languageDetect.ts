// VS Code-style language detection: full filename (special names + dotfiles)
// first, then lowercased extension. Unknown types fall back to 'plaintext'.
// All values are Monaco language IDs available in monaco-editor/basic-languages.

// Extension (lowercased, no dot) → Monaco language ID.
const EXT_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp',
  c: 'c', h: 'c', cs: 'csharp', php: 'php',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  bat: 'bat', cmd: 'bat', ps1: 'powershell', psm1: 'powershell',
  vue: 'html', svelte: 'html',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'xml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'ini',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart',
  lua: 'lua', r: 'r', jl: 'julia',
  tf: 'hcl', hcl: 'hcl', tfvars: 'hcl',
  pl: 'perl', pm: 'perl',
  scala: 'scala', sc: 'scala',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  coffee: 'coffee',
  ex: 'elixir', exs: 'elixir',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  m: 'objective-c', mm: 'objective-c',
  pas: 'pascal', proto: 'protobuf',
  pug: 'pug', jade: 'pug',
  rst: 'restructuredtext', sol: 'solidity',
  tcl: 'tcl', twig: 'twig', vb: 'vb', wgsl: 'wgsl',
  hbs: 'handlebars', liquid: 'liquid', cshtml: 'razor',
  bicep: 'bicep',
}

// Exact (lowercased) filenames that don't follow extension rules. Monaco has
// no makefile language; ini shares Makefile's '#' line comment (so cmd+/
// works) and its minimal tokenizer won't mis-highlight recipe lines.
const SPECIAL_FILES: Record<string, string> = {
  makefile: 'ini', gnumakefile: 'ini',
  '.gitignore': 'ini', '.gitattributes': 'ini',
  '.dockerignore': 'ini', '.npmignore': 'ini',
  '.editorconfig': 'ini',
  '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json',
}

/** Monaco language ID for a filename; 'plaintext' when unknown. */
export function languageForFile(fileName: string): string {
  const base = (fileName.split('/').pop() ?? fileName).toLowerCase()
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile'
  if (base === '.env' || base.startsWith('.env.')) return 'ini'
  const special = SPECIAL_FILES[base]
  if (special) return special
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext' // no extension, or a bare dotfile
  return EXT_MAP[base.slice(dot + 1)] ?? 'plaintext'
}

/** Normalize a raw token (extension or language ID) to a Monaco language ID. */
export function normalizeLanguage(lang: string): string {
  return EXT_MAP[lang.toLowerCase()] ?? lang
}
