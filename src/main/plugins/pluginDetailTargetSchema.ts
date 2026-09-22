import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseStrictJson, type JsonValue } from '../../../packages/plugin-contracts/src/index'

const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_TARGET_BYTES = 64 * 1024
const MAX_DEPTH = 8
const MAX_OBJECT_PROPERTIES = 32
const MAX_ARRAY_ITEMS = 128
const MAX_STRING_CODE_POINTS = 4_096
const MAX_ONE_OF_VARIANTS = 16
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

type Primitive = string | number | boolean | null

type CompiledSchema =
  | {
    readonly kind: 'object'
    readonly properties: ReadonlyMap<string, CompiledSchema>
    readonly required: ReadonlySet<string>
    readonly minProperties: number
    readonly maxProperties: number
  }
  | {
    readonly kind: 'array'
    readonly items: CompiledSchema
    readonly minItems: number
    readonly maxItems: number
  }
  | {
    readonly kind: 'string'
    readonly minLength: number
    readonly maxLength: number
    readonly constant?: string
  }
  | {
    readonly kind: 'number'
    readonly integer: boolean
    readonly constant?: number
  }
  | { readonly kind: 'boolean'; readonly constant?: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'oneOf'; readonly variants: readonly CompiledSchema[] }

export type PluginDetailTargetValidation =
  | { readonly ok: true; readonly target: JsonValue }
  | { readonly ok: false; readonly reason: 'invalid-schema' | 'invalid-target' }

/**
 * Validates a detail target against the Host-selected, signed package schema.
 * It intentionally supports only a small structural JSON Schema subset: closed
 * objects, bounded arrays and primitive constraints, plus finite discriminated
 * oneOf variants. It never resolves references or evaluates executable schema
 * features.
 */
export function validatePluginDetailTarget(input: {
  packageDir: string
  targetSchema: string | undefined
  target: unknown
}): PluginDetailTargetValidation {
  const schema = readAndCompileSchema(input.packageDir, input.targetSchema)
  if (!schema) return { ok: false, reason: 'invalid-schema' }
  const target = asBoundedJsonValue(input.target)
  if (!target.ok || !matches(schema, target.value)) {
    return { ok: false, reason: 'invalid-target' }
  }
  return { ok: true, target: target.value }
}

type CheckedPath = {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

function readAndCompileSchema(packageDir: string, targetSchema: string | undefined): CompiledSchema | null {
  if (typeof targetSchema !== 'string' || targetSchema.length === 0) return null
  let fd: number | null = null
  try {
    const root = realpathSync(packageDir)
    const candidate = resolve(root, targetSchema)
    if (!isWithin(root, candidate)) return null
    const relativeCandidate = relative(root, candidate)
    const checkedPaths: CheckedPath[] = [checkedPath(root, 'directory')]
    let current = root
    for (const [index, segment] of relativeCandidate.split(sep).entries()) {
      current = join(current, segment)
      checkedPaths.push(checkedPath(current, index === relativeCandidate.split(sep).length - 1 ? 'file' : 'directory'))
    }
    const checkedFile = checkedPaths[checkedPaths.length - 1]
    if (checkedFile.size > MAX_SCHEMA_BYTES) return null

    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedFile = fstatSync(fd)
    if (!matchesCheckedPath(checkedFile, openedFile)) return null
    const buffer = Buffer.allocUnsafe(MAX_SCHEMA_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_SCHEMA_BYTES || bytesRead !== checkedFile.size ||
      !matchesCheckedPath(checkedFile, fstatSync(fd))) return null

    if (realpathSync(packageDir) !== root || realpathSync(candidate) !== candidate || !isWithin(root, candidate) ||
      checkedPaths.some((checked) => !matchesCheckedPath(checked, lstatSync(checked.path))) ||
      !matchesCheckedPath(checkedFile, statSync(candidate))) return null
    return compileSchema(parseStrictJson(buffer.subarray(0, bytesRead).toString('utf8'), 'detail target schema'), 0)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The schema bytes were already accepted or rejected from this FD.
      }
    }
  }
}

function checkedPath(path: string, kind: CheckedPath['kind']): CheckedPath {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || (kind === 'directory' ? !entry.isDirectory() : !entry.isFile())) {
    throw new Error('schema path entry is unavailable')
  }
  return {
    path, kind, dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
  }
}

function matchesCheckedPath(checked: CheckedPath, entry: ReturnType<typeof lstatSync>): boolean {
  return entry !== undefined && !entry.isSymbolicLink() &&
    (checked.kind === 'directory' ? entry.isDirectory() : entry.isFile()) &&
    checked.dev === entry.dev && checked.ino === entry.ino && checked.size === entry.size &&
    checked.mtimeMs === entry.mtimeMs && checked.ctimeMs === entry.ctimeMs
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.includes(`..${sep}`)
}

function compileSchema(value: unknown, depth: number): CompiledSchema | null {
  if (depth > MAX_DEPTH || !isRecord(value)) return null
  const keys = Object.keys(value)
  const allowed = new Set([
    '$schema', 'type', 'properties', 'required', 'additionalProperties',
    'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems',
    'minLength', 'maxLength', 'const', 'oneOf',
  ])
  if (keys.some((key) => !allowed.has(key))) return null
  if (value.$schema !== undefined && value.$schema !== DRAFT_2020_12) return null
  if (value.oneOf !== undefined) return compileOneOf(value, depth)
  if (value.type === undefined) return compilePrimitiveConstant(value)
  if (typeof value.type !== 'string') return null
  switch (value.type) {
    case 'object': return compileObject(value, depth)
    case 'array': return compileArray(value, depth)
    case 'string': return compileString(value)
    case 'number': return compileNumber(value, false)
    case 'integer': return compileNumber(value, true)
    case 'boolean': return compileBoolean(value)
    case 'null': return compileNull(value)
    default: return null
  }
}

function compileOneOf(value: Record<string, unknown>, depth: number): CompiledSchema | null {
  if (Object.keys(value).some((key) => key !== '$schema' && key !== 'oneOf') || !Array.isArray(value.oneOf) ||
    value.oneOf.length < 2 || value.oneOf.length > MAX_ONE_OF_VARIANTS) return null
  const variants = value.oneOf.map((variant) => compileSchema(variant, depth + 1))
  if (variants.some((variant) => variant === null) || !isDiscriminated(variants as CompiledSchema[])) return null
  return { kind: 'oneOf', variants: variants as CompiledSchema[] }
}

function isDiscriminated(variants: readonly CompiledSchema[]): boolean {
  if (variants.some((variant) => variant.kind !== 'object')) return false
  const first = variants[0] as Extract<CompiledSchema, { kind: 'object' }>
  const paths = requiredPrimitiveConstantPaths(first).filter((path) =>
    variants.every((variant) => requiredPrimitiveConstantAtPath(variant, path) !== undefined)
  )
  if (paths.length === 0) return false
  const signatures = variants.map((variant) => JSON.stringify(paths.map((path) => {
    const value = requiredPrimitiveConstantAtPath(variant, path)
    return [typeof value, value]
  })))
  return new Set(signatures).size === variants.length
}

/** A discriminator can be a required primitive const at any bounded object path. */
function requiredPrimitiveConstantPaths(schema: Extract<CompiledSchema, { kind: 'object' }>, prefix: readonly string[] = []): string[][] {
  const paths: string[][] = []
  for (const [key, property] of schema.properties) {
    if (!schema.required.has(key)) continue
    const path = [...prefix, key]
    if (primitiveConstant(property) !== undefined) paths.push(path)
    if (property.kind === 'object') paths.push(...requiredPrimitiveConstantPaths(property, path))
  }
  return paths
}

function requiredPrimitiveConstantAtPath(schema: CompiledSchema, path: readonly string[]): Primitive | undefined {
  let current = schema
  for (const [index, key] of path.entries()) {
    if (current.kind !== 'object' || !current.required.has(key)) return undefined
    const property = current.properties.get(key)
    if (!property) return undefined
    if (index === path.length - 1) return primitiveConstant(property)
    current = property
  }
  return undefined
}

function primitiveConstant(schema: CompiledSchema | undefined): Primitive | undefined {
  if (!schema) return undefined
  if (schema.kind === 'string') return schema.constant
  if (schema.kind === 'number') return schema.constant
  if (schema.kind === 'boolean') return schema.constant
  if (schema.kind === 'null') return null
  return undefined
}

function compileObject(value: Record<string, unknown>, depth: number): CompiledSchema | null {
  if (
    Object.keys(value).some((key) => ![
      '$schema', 'type', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
    ].includes(key)) ||
    value.type !== 'object' ||
    value.additionalProperties !== false ||
    !isRecord(value.properties)
  ) return null
  const propertyEntries = Object.entries(value.properties)
  if (propertyEntries.length > MAX_OBJECT_PROPERTIES || propertyEntries.some(([key]) => key.length === 0 || codePoints(key) > MAX_STRING_CODE_POINTS)) return null
  const properties = new Map<string, CompiledSchema>()
  for (const [key, property] of propertyEntries) {
    const compiled = compileSchema(property, depth + 1)
    if (!compiled) return null
    properties.set(key, compiled)
  }
  if (!Array.isArray(value.required) || value.required.length > propertyEntries.length ||
    value.required.some((key) => typeof key !== 'string' || !properties.has(key)) ||
    new Set(value.required).size !== value.required.length) return null
  const minProperties = boundedInteger(value.minProperties, 0, propertyEntries.length, 0)
  if (minProperties === null) return null
  const maxProperties = boundedInteger(value.maxProperties, minProperties, propertyEntries.length, propertyEntries.length)
  if (maxProperties === null) return null
  return {
    kind: 'object', properties, required: new Set(value.required), minProperties, maxProperties,
  }
}

function compileArray(value: Record<string, unknown>, depth: number): CompiledSchema | null {
  if (Object.keys(value).some((key) => !['$schema', 'type', 'items', 'minItems', 'maxItems'].includes(key)) || value.type !== 'array') return null
  const items = compileSchema(value.items, depth + 1)
  const minItems = boundedInteger(value.minItems, 0, MAX_ARRAY_ITEMS, 0)
  if (!items || minItems === null) return null
  const maxItems = boundedInteger(value.maxItems, minItems, MAX_ARRAY_ITEMS, MAX_ARRAY_ITEMS)
  if (maxItems === null) return null
  return { kind: 'array', items, minItems, maxItems }
}

function compileString(value: Record<string, unknown>): CompiledSchema | null {
  if (Object.keys(value).some((key) => !['$schema', 'type', 'minLength', 'maxLength', 'const'].includes(key)) || value.type !== 'string') return null
  const minLength = boundedInteger(value.minLength, 0, MAX_STRING_CODE_POINTS, 0)
  if (minLength === null) return null
  const maxLength = boundedInteger(value.maxLength, minLength, MAX_STRING_CODE_POINTS, MAX_STRING_CODE_POINTS)
  if (maxLength === null || (value.const !== undefined && typeof value.const !== 'string')) return null
  return { kind: 'string', minLength, maxLength, ...(value.const === undefined ? {} : { constant: value.const }) }
}

function compilePrimitiveConstant(value: Record<string, unknown>): CompiledSchema | null {
  if (Object.keys(value).some((key) => key !== '$schema' && key !== 'const')) return null
  if (typeof value.const === 'string' && codePoints(value.const) <= MAX_STRING_CODE_POINTS) {
    return { kind: 'string', minLength: 0, maxLength: MAX_STRING_CODE_POINTS, constant: value.const }
  }
  if (typeof value.const === 'number' && Number.isFinite(value.const)) return { kind: 'number', integer: Number.isInteger(value.const), constant: value.const }
  if (typeof value.const === 'boolean') return { kind: 'boolean', constant: value.const }
  if (value.const === null) return { kind: 'null' }
  return null
}

function compileNumber(value: Record<string, unknown>, integer: boolean): CompiledSchema | null {
  if (Object.keys(value).some((key) => !['$schema', 'type', 'const'].includes(key) || (key === 'type' && value.type !== (integer ? 'integer' : 'number')))) return null
  if (value.const !== undefined && (typeof value.const !== 'number' || !Number.isFinite(value.const) || (integer && !Number.isInteger(value.const)))) return null
  return { kind: 'number', integer, ...(value.const === undefined ? {} : { constant: value.const }) }
}

function compileBoolean(value: Record<string, unknown>): CompiledSchema | null {
  if (Object.keys(value).some((key) => !['$schema', 'type', 'const'].includes(key)) || value.type !== 'boolean' ||
    (value.const !== undefined && typeof value.const !== 'boolean')) return null
  return { kind: 'boolean', ...(value.const === undefined ? {} : { constant: value.const }) }
}

function compileNull(value: Record<string, unknown>): CompiledSchema | null {
  if (Object.keys(value).some((key) => key !== '$schema' && key !== 'type' && key !== 'const') || value.type !== 'null' ||
    (value.const !== undefined && value.const !== null)) return null
  return { kind: 'null' }
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function asBoundedJsonValue(value: unknown): { ok: true; value: JsonValue } | { ok: false } {
  const seen = new Set<unknown>()
  const valid = (candidate: unknown, depth: number): candidate is JsonValue => {
    if (depth > MAX_DEPTH || candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate === null || typeof candidate === 'boolean' || (typeof candidate === 'string' && codePoints(candidate) <= MAX_STRING_CODE_POINTS)
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate)
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS || seen.has(candidate)) return false
      seen.add(candidate)
      return candidate.every((item) => valid(item, depth + 1))
    }
    if (!isRecord(candidate) || seen.has(candidate) || Object.keys(candidate).length > MAX_OBJECT_PROPERTIES) return false
    seen.add(candidate)
    return Object.entries(candidate).every(([key, item]) => codePoints(key) <= MAX_STRING_CODE_POINTS && valid(item, depth + 1))
  }
  if (!valid(value, 0)) return { ok: false }
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_TARGET_BYTES
      ? { ok: true, value }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

function matches(schema: CompiledSchema, value: JsonValue): boolean {
  switch (schema.kind) {
    case 'object': {
      if (!isRecord(value)) return false
      const entries = Object.entries(value)
      return entries.length >= schema.minProperties && entries.length <= schema.maxProperties &&
        [...schema.required].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
        entries.every(([key, item]) => {
          const property = schema.properties.get(key)
          return property !== undefined && matches(property, item)
        })
    }
    case 'array':
      return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems &&
        value.every((item) => matches(schema.items, item))
    case 'string':
      return typeof value === 'string' && codePoints(value) >= schema.minLength && codePoints(value) <= schema.maxLength &&
        (schema.constant === undefined || value === schema.constant)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (!schema.integer || Number.isInteger(value)) &&
        (schema.constant === undefined || value === schema.constant)
    case 'boolean':
      return typeof value === 'boolean' && (schema.constant === undefined || value === schema.constant)
    case 'null':
      return value === null
    case 'oneOf':
      return schema.variants.filter((variant) => matches(variant, value)).length === 1
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function codePoints(value: string): number {
  return [...value].length
}
