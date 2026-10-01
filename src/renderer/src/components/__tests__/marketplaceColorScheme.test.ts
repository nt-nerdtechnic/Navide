// @vitest-environment happy-dom
// Native controls on the plugin pages follow the theme: a light theme must
// never get dark checkboxes (regression R1 of the Marketplace review).
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const tokens = [
  'packages/plugin-ui/src/foundation/styles/tokens/semantic.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/light.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/dark-midnight.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/high-contrast.css',
].map(read).join('\n')

const SURFACES: Array<[string, string]> = [
  ['src/renderer/src/components/MarketplacePane.vue', 'marketplace-pane'],
  ['src/renderer/src/components/ExtensionsPane.vue', 'extensions-pane'],
]

function colorSchemeOf(className: string): string {
  const el = document.createElement('div')
  el.className = className
  document.body.append(el)
  return getComputedStyle(el).colorScheme
}

describe('plugin pages follow the theme for native controls', () => {
  afterEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    delete document.documentElement.dataset.theme
  })

  for (const [file, className] of SURFACES) {
    it(`${className} declares the theme's colour scheme, not a fixed one`, () => {
      const source = read(file)
      expect(source).toContain('color-scheme: var(--nv-color-scheme)')
      expect(source).not.toMatch(/color-scheme:\s*(dark|light)\b/)
    })
  }

  it('resolves to light under the light theme and dark under the dark ones', () => {
    const style = document.createElement('style')
    style.textContent = `${tokens}\n${SURFACES.map(([, c]) => `.${c}`).join(', ')} { color-scheme: var(--nv-color-scheme); }`
    document.head.append(style)

    document.documentElement.dataset.theme = 'light'
    for (const [, className] of SURFACES) expect(colorSchemeOf(className)).toBe('light')

    for (const theme of ['dark-github', 'dark-midnight', 'high-contrast']) {
      document.documentElement.dataset.theme = theme
      for (const [, className] of SURFACES) expect(colorSchemeOf(className)).toBe('dark')
    }
  })
})
