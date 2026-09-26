import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '@tanstack/ai'

import { newTurn } from '../src/server/core'

const u = (content: string): ModelMessage => ({ role: 'user', content })
const a = (content: string): ModelMessage => ({ role: 'assistant', content })

describe('newTurn', () => {
  it('keeps only the trailing user messages', () => {
    expect(newTurn([u('first'), a('reply'), u('second'), u('third')])).toEqual([u('second'), u('third')])
  })
  it('returns everything when the thread is only user messages', () => {
    expect(newTurn([u('first')])).toEqual([u('first')])
  })
  it('returns the input when there is no trailing user message', () => {
    const m = [u('first'), a('reply')]
    expect(newTurn(m)).toEqual(m)
  })
})
