// Shared "is this topic really rendered in English?" assertion for the
// Settings → Help topic tests. Not a spec file — vitest only collects
// *.{test,spec}.ts, so this stays a plain module.
import { expect } from 'vitest'

// Han, plus the two blocks that carry Chinese punctuation but are not Han:
// CJK symbols and punctuation (U+3000-U+303F: 、。〈〉《》「」) and the
// fullwidth forms (U+FF00-U+FFEF: （）＋／～). Matching only U+3400-U+9FFF
// would let every one of those through.
const CHINESE = /[\p{Script=Han}　-〿＀-￯]/u

// The fullwidth characters the product itself draws, which the help topics
// quote verbatim — identical in both locales, so they are UI glyphs rather
// than untranslated prose. Only characters that render the same way in
// en-US and zh-TW belong here; real Chinese punctuation in an English string
// is a defect to fix in the locale file, never an entry in this list.
const UI_GLYPHS: ReadonlyArray<readonly [string, string]> = [
  ['＋', "the add button on workspace, group and + menu rows, and Git's Stage buttons"],
  ['～', 'the "this quota figure is a cached snapshot" mark'],
]

const UI_GLYPH_CHARS = UI_GLYPHS.map(([glyph]) => glyph)

function strip(text: string, literals: readonly string[]): string {
  return literals.reduce((acc, literal) => acc.split(literal).join(''), text)
}

/**
 * Assert a rendered help topic carries no Chinese once the UI glyphs (and any
 * caller-supplied literals that are legitimately Chinese in en-US) are removed.
 *
 * `allowLiterals` is for strings that really are Chinese in the English
 * rendering — e.g. the language picker's own "繁體中文" option label.
 */
export function expectNoChineseText(
  text: string,
  { allowLiterals = [] as readonly string[] } = {},
): void {
  const stripped = strip(text, [...UI_GLYPH_CHARS, ...allowLiterals])
  const hits = [...new Set(stripped.match(new RegExp(CHINESE, 'gu')) ?? [])]
  expect(
    hits,
    hits.length
      ? `untranslated Chinese in the en-US rendering: ${hits
          .map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)
          .join(', ')}`
      : undefined,
  ).toEqual([])
}
