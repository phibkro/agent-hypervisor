/**
 * ACP form elicitation, as omp uses it for its `ask` tool. Shared by the server
 * (validates answers before they reach the agent) and the client (renders the
 * form). The ACP schema is a restricted, flat JSON Schema:
 *
 * - string with `oneOf` / `enum`  → pick one      (omp: single-select question)
 * - array with `items.anyOf/enum` → pick several  (omp: `multi: true` question)
 * - plain string                  → free text     (omp: `q<N>__other`, "Other")
 * - boolean                       → yes / no      (omp: `confirm`)
 * - number / integer              → number
 *
 * omp names fields `q0`, `q0__other`, `q1`, …; a future `q0__note` (answer notes,
 * not yet sent by omp over ACP) would render as free text with no changes here.
 */

export interface EnumOption {
  const: string
  title?: string
  description?: string
}

export interface FieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: unknown
  enum?: Array<string>
  oneOf?: Array<EnumOption>
  items?: { enum?: Array<string>; anyOf?: Array<EnumOption> }
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export interface FormSchema {
  type?: 'object'
  title?: string
  properties: Record<string, FieldSchema>
  required?: Array<string>
}

export type FieldKind = 'single' | 'multi' | 'text' | 'boolean' | 'number'

export function fieldKind(f: FieldSchema): FieldKind {
  if (f.type === 'array') return 'multi'
  if (f.type === 'boolean') return 'boolean'
  if (f.type === 'number' || f.type === 'integer') return 'number'
  if (f.oneOf?.length || f.enum?.length) return 'single'
  return 'text'
}

export function options(f: FieldSchema): Array<EnumOption> {
  if (f.type === 'array') return f.items?.anyOf ?? (f.items?.enum ?? []).map((v) => ({ const: v }))
  return f.oneOf ?? (f.enum ?? []).map((v) => ({ const: v }))
}

export type AnswerValue = string | number | boolean | Array<string>

/** Why the content does not satisfy the schema, or null if it does. */
export function validate(schema: FormSchema, content: Record<string, unknown>): string | null {
  const name = (key: string) => {
    const t = schema.properties[key]?.title
    return t ? `"${t}"` : key
  }
  for (const key of schema.required ?? []) {
    const v = content[key]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return `${name(key)} needs an answer`
  }
  for (const [key, v] of Object.entries(content)) {
    const f = schema.properties[key]
    if (!f) return `${key} is not in the form`
    if (v === undefined) continue
    const kind = fieldKind(f)
    const allowed = new Set(options(f).map((o) => o.const))
    if (kind === 'single' && (typeof v !== 'string' || !allowed.has(v))) return `${name(key)} must be one of the options`
    if (kind === 'multi' && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !allowed.has(x))))
      return `${name(key)} must be a list of the options`
    if (kind === 'text' && typeof v !== 'string') return `${name(key)} must be text`
    if (kind === 'boolean' && typeof v !== 'boolean') return `${name(key)} must be yes or no`
    if (kind === 'number' && (typeof v !== 'number' || Number.isNaN(v))) return `${name(key)} must be a number`
  }
  return null
}

/** Drop empty free-text answers so the agent sees "not given" rather than "". */
export function compact(content: Record<string, AnswerValue | undefined>): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {}
  for (const [k, v] of Object.entries(content)) {
    if (v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  return out
}

export interface Question {
  key: string
  field: FieldSchema
  /** omp's `q<N>__other`: free text that replaces (single) or adds to (multi) the choice. */
  other?: { key: string; field: FieldSchema }
  /** A future `q<N>__note` (answer notes); rendered as an optional note. */
  note?: { key: string; field: FieldSchema }
}

/** Pair each question with its `__other` / `__note` companions; anything else stands alone. */
export function questions(schema: FormSchema): Array<Question> {
  const props = schema.properties
  const out: Array<Question> = []
  const companion = /^(.*)__(other|note)$/
  for (const [key, field] of Object.entries(props)) {
    const m = companion.exec(key)
    if (m && m[1] && props[m[1]]) continue
    const q: Question = { key, field }
    if (props[`${key}__other`]) q.other = { key: `${key}__other`, field: props[`${key}__other`]! }
    if (props[`${key}__note`]) q.note = { key: `${key}__note`, field: props[`${key}__note`]! }
    out.push(q)
  }
  return out
}
