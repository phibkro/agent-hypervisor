import { describe, expect, it } from 'vitest'
import { compact, fieldKind, questions, validate } from '../src/lib/elicitation'
import type { FormSchema } from '../src/lib/elicitation'

/** The form omp's ACP mode builds for `ask` with a single- and a multi-select question. */
const omp: FormSchema = {
  type: 'object',
  properties: {
    q0: {
      type: 'string',
      title: 'Which database?',
      oneOf: [
        { const: 'SQLite', title: 'SQLite' },
        { const: 'Redis', title: 'Redis' },
      ],
      default: 'SQLite',
    },
    q0__other: { type: 'string', title: 'Other (type your own)' },
    q1: { type: 'array', title: 'Which checks?', items: { anyOf: [{ const: 'lint' }, { const: 'tests' }] } },
    q1__other: { type: 'string', title: 'Other (type your own)' },
  },
}
const confirm: FormSchema = { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] }

describe('elicitation forms', () => {
  it('classifies omp question shapes', () => {
    expect(['q0', 'q0__other', 'q1'].map((k) => fieldKind(omp.properties[k]!))).toEqual(['single', 'text', 'multi'])
    expect(fieldKind(confirm.properties.value!)).toBe('boolean')
  })
  it('pairs __other (and future __note) fields with their question', () => {
    const withNote: FormSchema = { properties: { ...omp.properties, q0__note: { type: 'string' } } }
    const qs = questions(withNote)
    expect(qs.map((q) => q.key)).toEqual(['q0', 'q1'])
    expect(qs[0]!.other?.key).toBe('q0__other')
    expect(qs[0]!.note?.key).toBe('q0__note')
  })
  it('accepts valid answers, including Other in place of a choice', () => {
    expect(validate(omp, { q0: 'Redis', q1: ['lint', 'tests'] })).toBeNull()
    expect(validate(omp, compact({ q0__other: ' Postgres ', q1: [] }))).toBeNull()
    expect(validate(confirm, { value: false })).toBeNull()
  })
  it('rejects off-list answers, unknown fields and missing required ones', () => {
    expect(validate(omp, { q0: 'Mongo' })).toMatch(/Which database/)
    expect(validate(omp, { q1: ['deploy'] })).toMatch(/list of the options/)
    expect(validate(omp, { q9: 'x' })).toMatch(/not in the form/)
    expect(validate(confirm, {})).toMatch(/needs an answer/)
    expect(validate(confirm, { value: 'yes' })).toMatch(/yes or no/)
  })
  it('compact drops blank free text and trims', () => {
    expect(compact({ a: '  ', b: ' x ', c: undefined, d: false })).toEqual({ b: 'x', d: false })
  })
})
