import { describe, it, expect } from 'vitest'
import { toWordParts, toSnakeCase, toCamelCase, toKebabCase, toPascalCase } from '../textTransforms'

describe('toWordParts', () => {
  it('splits on spaces', () => {
    expect(toWordParts('hello world')).toEqual(['hello', 'world'])
  })
  it('splits on underscores', () => {
    expect(toWordParts('hello_world')).toEqual(['hello', 'world'])
  })
  it('splits on hyphens', () => {
    expect(toWordParts('hello-world')).toEqual(['hello', 'world'])
  })
  it('splits camelCase', () => {
    expect(toWordParts('helloWorld')).toEqual(['hello', 'World'])
  })
  it('splits PascalCase', () => {
    expect(toWordParts('HelloWorld')).toEqual(['Hello', 'World'])
  })
  it('splits acronym before word (XMLParser)', () => {
    expect(toWordParts('XMLParser')).toEqual(['XML', 'Parser'])
  })
  it('splits SCREAMING_SNAKE', () => {
    expect(toWordParts('HELLO_WORLD')).toEqual(['HELLO', 'WORLD'])
  })
  it('returns empty array for empty string', () => {
    expect(toWordParts('')).toEqual([])
  })
})

describe('toSnakeCase', () => {
  it('converts camelCase', () => expect(toSnakeCase('helloWorld')).toBe('hello_world'))
  it('converts PascalCase', () => expect(toSnakeCase('HelloWorld')).toBe('hello_world'))
  it('converts kebab-case', () => expect(toSnakeCase('hello-world')).toBe('hello_world'))
  it('converts SCREAMING_SNAKE', () => expect(toSnakeCase('HELLO_WORLD')).toBe('hello_world'))
  it('converts spaces', () => expect(toSnakeCase('hello world')).toBe('hello_world'))
  it('converts XMLParser', () => expect(toSnakeCase('XMLParser')).toBe('xml_parser'))
})

describe('toCamelCase', () => {
  it('converts snake_case', () => expect(toCamelCase('hello_world')).toBe('helloWorld'))
  it('converts PascalCase', () => expect(toCamelCase('HelloWorld')).toBe('helloWorld'))
  it('converts kebab-case', () => expect(toCamelCase('hello-world')).toBe('helloWorld'))
  it('converts SCREAMING_SNAKE', () => expect(toCamelCase('HELLO_WORLD')).toBe('helloWorld'))
  it('converts spaces', () => expect(toCamelCase('hello world')).toBe('helloWorld'))
  it('returns empty for empty string', () => expect(toCamelCase('')).toBe(''))
})

describe('toKebabCase', () => {
  it('converts camelCase', () => expect(toKebabCase('helloWorld')).toBe('hello-world'))
  it('converts PascalCase', () => expect(toKebabCase('HelloWorld')).toBe('hello-world'))
  it('converts snake_case', () => expect(toKebabCase('hello_world')).toBe('hello-world'))
  it('converts SCREAMING_SNAKE', () => expect(toKebabCase('HELLO_WORLD')).toBe('hello-world'))
  it('converts spaces', () => expect(toKebabCase('hello world')).toBe('hello-world'))
  it('converts XMLParser', () => expect(toKebabCase('XMLParser')).toBe('xml-parser'))
})

describe('toPascalCase', () => {
  it('converts camelCase', () => expect(toPascalCase('helloWorld')).toBe('HelloWorld'))
  it('converts snake_case', () => expect(toPascalCase('hello_world')).toBe('HelloWorld'))
  it('converts kebab-case', () => expect(toPascalCase('hello-world')).toBe('HelloWorld'))
  it('converts SCREAMING_SNAKE', () => expect(toPascalCase('HELLO_WORLD')).toBe('HelloWorld'))
  it('converts spaces', () => expect(toPascalCase('hello world')).toBe('HelloWorld'))
  it('converts XMLParser', () => expect(toPascalCase('XMLParser')).toBe('XmlParser'))
})
