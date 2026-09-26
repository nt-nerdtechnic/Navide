export function toWordParts(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .filter(Boolean)
}

export function toSnakeCase(text: string): string {
  return toWordParts(text).map((w) => w.toLowerCase()).join('_')
}

export function toCamelCase(text: string): string {
  const parts = toWordParts(text)
  if (!parts.length) return ''
  return parts[0].toLowerCase() + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
}

export function toKebabCase(text: string): string {
  return toWordParts(text).map((w) => w.toLowerCase()).join('-')
}

export function toPascalCase(text: string): string {
  return toWordParts(text).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
}
