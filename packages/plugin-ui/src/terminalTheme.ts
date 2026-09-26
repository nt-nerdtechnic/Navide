import type { ITheme } from '@xterm/xterm'

const DARK_ANSI = {
  black: '#484f58',   brightBlack: '#6e7681',
  red: '#ff7b72',     brightRed: '#ffa198',
  green: '#3fb950',   brightGreen: '#56d364',
  yellow: '#d29922',  brightYellow: '#e3b341',
  blue: '#58a6ff',    brightBlue: '#79c0ff',
  magenta: '#bc8cff', brightMagenta: '#d2a8ff',
  cyan: '#56d4dd',    brightCyan: '#b3f0ff',
  white: '#b1bac4',   brightWhite: '#ffffff',
}

const DARK_SCROLLBAR = {
  scrollbarSliderBackground:       'rgba(255,255,255,0.55)',
  scrollbarSliderHoverBackground:  'rgba(255,255,255,0.75)',
  scrollbarSliderActiveBackground: 'rgba(255,255,255,0.90)',
}

export const XTERM_THEMES: Record<string, ITheme> = {
  'dark-github': {
    background: '#0d1117', foreground: '#e6edf3',
    cursor: '#58a6ff', selectionBackground: 'rgba(56,139,253,0.35)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  'dark-midnight': {
    background: '#0a0e14', foreground: '#c5d0e6',
    cursor: '#6cb0ff', selectionBackground: 'rgba(56,139,253,0.3)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  'dark-forest': {
    background: '#0c130d', foreground: '#e9f2e7',
    cursor: '#6fc28a', selectionBackground: 'rgba(111,194,138,0.3)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  light: {
    background: '#ffffff', foreground: '#1f2328',
    cursor: '#0969da', selectionBackground: 'rgba(9,105,218,0.2)',
    scrollbarSliderBackground:       'rgba(0,0,0,0.35)',
    scrollbarSliderHoverBackground:  'rgba(0,0,0,0.55)',
    scrollbarSliderActiveBackground: 'rgba(0,0,0,0.70)',
    black: '#1f2328',    brightBlack: '#59636e',
    red: '#cf222e',      brightRed: '#a40e26',
    green: '#1a7f37',    brightGreen: '#22863a',
    yellow: '#9a6700',   brightYellow: '#7d4e00',
    blue: '#0969da',     brightBlue: '#0550ae',
    magenta: '#8250df',  brightMagenta: '#6639ba',
    cyan: '#1b7c83',     brightCyan: '#3192aa',
    white: '#d0d7de',    brightWhite: '#8c959f',  // NOT pure white — readable on light bg
  },
  'high-contrast': {
    // Match the app canvas (--bg-base #0a0c10) like every other theme, so the
    // pane's padding frame is seamless. White-on-#0a0c10 is still ~20:1 contrast.
    background: '#0a0c10', foreground: '#ffffff',
    cursor: '#71b7ff', selectionBackground: 'rgba(113,183,255,0.35)',
    ...DARK_SCROLLBAR,
    black: '#686868',   brightBlack: '#a0a0a0',
    red: '#ff6b66',     brightRed: '#ff9a94',
    green: '#56d364',   brightGreen: '#7ee787',
    yellow: '#e3b341',  brightYellow: '#f2cc60',
    blue: '#79c0ff',    brightBlue: '#a5d6ff',
    magenta: '#d2a8ff', brightMagenta: '#e2c5ff',
    cyan: '#56d4dd',    brightCyan: '#b3f0ff',
    white: '#e6edf3',   brightWhite: '#ffffff',
  },
}

export function readXtermTheme(): ITheme {
  const id = typeof document !== 'undefined'
    ? (document.documentElement.getAttribute('data-theme') ?? 'dark-github')
    : 'dark-github'
  return XTERM_THEMES[id] ?? XTERM_THEMES['dark-github']
}
