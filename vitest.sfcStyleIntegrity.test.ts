// Vite runs postcss over every SFC `<style>` block. A block that does not parse
// aborts the renderer build and raises a dev-server overlay, while vitest and
// vue-tsc stay green because neither reads CSS — a mangled merge in this repo
// left a stray `}` in one pane's styles and shipped exactly that way. This test
// is the cheap stand-in for a full CSS parse (postcss is not a dependency of
// this repo): it checks that each style block's braces balance, so an orphan
// closing brace or an unclosed rule fails here instead of in the build.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src', 'plugins', 'packages']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'out', 'coverage'])

function collectVueFiles(directory: string, found: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectVueFiles(path, found)
    else if (entry.name.endsWith('.vue')) found.push(path)
  }
  return found
}

function styleBlocks(source: string): string[] {
  const blocks: string[] = []
  const open = /<style[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = open.exec(source)) !== null) {
    const start = match.index + match[0].length
    const end = source.indexOf('</style>', start)
    if (end < 0) break
    blocks.push(source.slice(start, end))
  }
  return blocks
}

/** 1-based line of the first unbalanced brace, or null when the block balances. */
function unbalancedBraceLine(css: string): number | null {
  const lines = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  let depth = 0
  for (const [index, line] of lines.entries()) {
    for (const character of line) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      if (depth < 0) return index + 1
    }
  }
  return depth === 0 ? null : lines.length
}

describe('SFC style blocks', () => {
  const files = ROOTS.flatMap((root) => collectVueFiles(resolve(process.cwd(), root)))

  it('finds the components under review', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('keeps every style block parseable by brace balance', () => {
    const failures: string[] = []
    for (const file of files) {
      styleBlocks(readFileSync(file, 'utf8')).forEach((block, index) => {
        const line = unbalancedBraceLine(block)
        if (line !== null) {
          failures.push(`${relative(process.cwd(), file)} style block ${index + 1}, line ${line}`)
        }
      })
    }
    expect(failures).toEqual([])
  })
})
