// Walks one or more sample JSON values and emits a TypeScript-flavored
// type string. Multiple samples are merged: properties present in some
// but not all become optional, and value types unify with `|`.

const MAX_DEPTH = 6
const MAX_UNION = 8

interface NodeShape {
  kind: 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown'
  // For arrays: element shape
  element?: NodeShape
  // For objects: property name → { shape, seenCount }
  properties?: Map<string, { shape: NodeShape; seenIn: number }>
  // For primitives: sample values (used to detect enums)
  samples?: Set<string | number | boolean>
}

export function inferType(samples: unknown[], rootName = 'Response'): string {
  if (samples.length === 0) return `type ${rootName} = unknown`
  const merged = samples.reduce<NodeShape | null>((acc, s) => mergeShape(acc, shapeOf(s, 0), 1), null)
  if (!merged) return `type ${rootName} = unknown`
  // Each sample contributes 1 to seenIn at the top level
  return `type ${rootName} = ${render(merged, samples.length, 0)}`
}

// JSON Schema draft-07 (subset) version of the same shape, suitable for
// dropping straight into an OpenAPI 3.0 `schema` object. Returns null
// when no samples were given so callers can omit the field cleanly.
export function inferJsonSchema(samples: unknown[]): JsonSchema | null {
  if (samples.length === 0) return null
  const merged = samples.reduce<NodeShape | null>((acc, s) => mergeShape(acc, shapeOf(s, 0), 1), null)
  if (!merged) return null
  return renderJsonSchema(merged, samples.length)
}

export type JsonSchema =
  | { type: 'null' }
  | { type: 'string'; enum?: string[]; example?: string }
  | { type: 'integer' | 'number'; enum?: number[]; example?: number }
  | { type: 'boolean'; enum?: boolean[]; example?: boolean }
  | { type: 'array'; items: JsonSchema }
  | {
      type: 'object'
      properties?: Record<string, JsonSchema>
      required?: string[]
      additionalProperties?: boolean | JsonSchema
    }
  | { oneOf: JsonSchema[] }
  | Record<string, never> // {} for "any / unknown"

function renderJsonSchema(shape: NodeShape, totalSamples: number): JsonSchema {
  switch (shape.kind) {
    case 'null':
      return { type: 'null' }
    case 'unknown':
      return {}
    case 'boolean': {
      const enumed = pickEnum<boolean>(shape, 'boolean')
      return enumed ? { type: 'boolean', enum: enumed } : { type: 'boolean' }
    }
    case 'number': {
      const enumed = pickEnum<number>(shape, 'number')
      // Heuristic: if every sample is an integer, declare as integer.
      const allInts = !!shape.samples && [...shape.samples].every((n) => typeof n === 'number' && Number.isInteger(n))
      const type = allInts ? 'integer' : 'number'
      return enumed ? { type, enum: enumed } : { type }
    }
    case 'string': {
      const enumed = pickEnum<string>(shape, 'string')
      return enumed ? { type: 'string', enum: enumed } : { type: 'string' }
    }
    case 'array':
      return { type: 'array', items: renderJsonSchema(shape.element ?? { kind: 'unknown' }, totalSamples) }
    case 'object': {
      if (!shape.properties || shape.properties.size === 0) {
        return { type: 'object', additionalProperties: true }
      }
      const props: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, entry] of shape.properties) {
        props[key] = renderJsonSchema(entry.shape, totalSamples)
        if (entry.seenIn >= totalSamples) required.push(key)
      }
      return {
        type: 'object',
        properties: props,
        ...(required.length > 0 ? { required: required.sort() } : {}),
      }
    }
  }
}

function pickEnum<T extends string | number | boolean>(shape: NodeShape, kind: string): T[] | null {
  const s = shape.samples
  if (!s || s.size === 0) return null
  if (s.size > MAX_UNION) return null
  // Match render()'s heuristic: only collapse string sets ≤ 3 to enum, so
  // the OpenAPI spec stays in sync with the TS type we already infer.
  if (kind === 'string' && s.size > 3) return null
  return [...s] as T[]
}

function shapeOf(v: unknown, depth: number): NodeShape {
  if (depth > MAX_DEPTH) return { kind: 'unknown' }
  if (v === null) return { kind: 'null' }
  if (Array.isArray(v)) {
    let elt: NodeShape | null = null
    for (const item of v.slice(0, 100)) {
      elt = mergeShape(elt, shapeOf(item, depth + 1), 1)
    }
    return { kind: 'array', element: elt ?? { kind: 'unknown' } }
  }
  const t = typeof v
  if (t === 'object') {
    const props = new Map<string, { shape: NodeShape; seenIn: number }>()
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      props.set(k, { shape: shapeOf(val, depth + 1), seenIn: 1 })
    }
    return { kind: 'object', properties: props }
  }
  if (t === 'string') return { kind: 'string', samples: new Set([v as string]) }
  if (t === 'number') return { kind: 'number', samples: new Set([v as number]) }
  if (t === 'boolean') return { kind: 'boolean', samples: new Set([v as boolean]) }
  return { kind: 'unknown' }
}

function mergeShape(a: NodeShape | null, b: NodeShape, contributedBy: number): NodeShape {
  if (!a) return b
  if (a.kind !== b.kind) {
    // Allow null + other → "T | null"; otherwise leave as a union node
    // expressed via the parent property's `seenIn` count for optionality.
    if (a.kind === 'null') return mergeNullable(b)
    if (b.kind === 'null') return mergeNullable(a)
    // Genuine type mismatch — keep the first, mark unknown samples.
    return { kind: 'unknown' }
  }
  if (a.kind === 'object' && b.kind === 'object') {
    const props = new Map<string, { shape: NodeShape; seenIn: number }>()
    for (const [k, v] of a.properties ?? []) props.set(k, { ...v })
    for (const [k, v] of b.properties ?? []) {
      const existing = props.get(k)
      if (existing) {
        existing.shape = mergeShape(existing.shape, v.shape, contributedBy)
        existing.seenIn += v.seenIn
      } else {
        props.set(k, { shape: v.shape, seenIn: v.seenIn })
      }
    }
    return { kind: 'object', properties: props }
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', element: mergeShape(a.element ?? null, b.element ?? { kind: 'unknown' }, 1) }
  }
  // Primitive — merge sample sets to detect tiny enums
  if (a.samples && b.samples) {
    const merged = new Set([...a.samples, ...b.samples])
    return { kind: a.kind, samples: merged }
  }
  return a
}

function mergeNullable(s: NodeShape): NodeShape {
  return { ...s, kind: s.kind } // type stays the same; nullability shown elsewhere
}

function render(shape: NodeShape, totalSamples: number, depth: number): string {
  switch (shape.kind) {
    case 'null': return 'null'
    case 'unknown': return 'unknown'
    case 'boolean': return enumOrType(shape, 'boolean')
    case 'number': return enumOrType(shape, 'number')
    case 'string': return enumOrType(shape, 'string')
    case 'array': return `${render(shape.element ?? { kind: 'unknown' }, totalSamples, depth + 1)}[]`
    case 'object': {
      if (!shape.properties || shape.properties.size === 0) return 'Record<string, unknown>'
      const indent = '  '.repeat(depth + 1)
      const closeIndent = '  '.repeat(depth)
      const lines: string[] = []
      const sortedKeys = [...shape.properties.keys()].sort()
      for (const key of sortedKeys) {
        const entry = shape.properties.get(key)!
        const optional = entry.seenIn < totalSamples ? '?' : ''
        const propName = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
        lines.push(`${indent}${propName}${optional}: ${render(entry.shape, totalSamples, depth + 1)}`)
      }
      return `{\n${lines.join('\n')}\n${closeIndent}}`
    }
  }
}

function enumOrType(shape: NodeShape, base: string): string {
  const s = shape.samples
  if (!s || s.size === 0) return base
  if (s.size > MAX_UNION) return base
  // Only collapse to a literal union for tiny sample sets (likely enums)
  if (base === 'string' && s.size > 3) return base
  return [...s].map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(' | ')
}
