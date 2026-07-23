import { describe, it, expect } from 'vitest'
import { languageForFile, normalizeLanguage } from '../languageDetect'

describe('languageForFile', () => {
  it('maps known extensions to Monaco language ids', () => {
    expect(languageForFile('main.ts')).toBe('typescript')
    expect(languageForFile('app.vue')).toBe('html')
    expect(languageForFile('script.py')).toBe('python')
    expect(languageForFile('query.gql')).toBe('graphql')
    expect(languageForFile('deploy.ps1')).toBe('powershell')
    expect(languageForFile('header.h')).toBe('c')
    expect(languageForFile('impl.hpp')).toBe('cpp')
  })

  it('is case-insensitive on extensions', () => {
    expect(languageForFile('README.MD')).toBe('markdown')
    expect(languageForFile('Main.TS')).toBe('typescript')
  })

  it('detects special filenames', () => {
    expect(languageForFile('Dockerfile')).toBe('dockerfile')
    expect(languageForFile('Dockerfile.dev')).toBe('dockerfile')
    expect(languageForFile('Makefile')).toBe('ini')
    expect(languageForFile('makefile')).toBe('ini')
    expect(languageForFile('GNUmakefile')).toBe('ini')
  })

  it('detects dotfiles', () => {
    expect(languageForFile('.gitignore')).toBe('ini')
    expect(languageForFile('.env')).toBe('ini')
    expect(languageForFile('.env.local')).toBe('ini')
    expect(languageForFile('.editorconfig')).toBe('ini')
    expect(languageForFile('.eslintrc')).toBe('json')
  })

  it('falls back to plaintext for unknown types', () => {
    expect(languageForFile('data.xyz123')).toBe('plaintext')
    expect(languageForFile('LICENSE')).toBe('plaintext')
    expect(languageForFile('.bashrc')).toBe('plaintext')
  })
})

describe('normalizeLanguage', () => {
  it('normalizes raw extensions to Monaco ids', () => {
    expect(normalizeLanguage('ts')).toBe('typescript')
    expect(normalizeLanguage('py')).toBe('python')
    expect(normalizeLanguage('sh')).toBe('shell')
  })

  it('passes through already-normalized ids', () => {
    expect(normalizeLanguage('python')).toBe('python')
    expect(normalizeLanguage('plaintext')).toBe('plaintext')
  })
})
