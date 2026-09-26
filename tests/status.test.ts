import { describe, expect, it } from 'vitest'
import { deriveStatus, isActive, statusRank } from '../src/server/status'

const MIN = 60_000
const W = 15 * MIN
const base = { running: false, pending: 0, lastActivityAt: 0, archivedAt: null as number | null }

describe('session status algebra', () => {
  it('needs-you beats everything, including running and archived', () => {
    expect(deriveStatus({ ...base, pending: 1, running: true }, 0, W)).toBe('needs-you')
    expect(deriveStatus({ ...base, pending: 2, archivedAt: 10 }, 100 * MIN, W)).toBe('needs-you')
  })
  it('an executing session is running, even when archived or long quiet', () => {
    expect(deriveStatus({ ...base, running: true, archivedAt: 5 }, 100 * MIN, W)).toBe('running')
  })
  it('goes inactive after 15 minutes without activity, not before', () => {
    expect(deriveStatus(base, W - 1, W)).toBe('active')
    expect(deriveStatus(base, W, W)).toBe('inactive')
  })
  it('archive holds until later activity outranks it', () => {
    expect(deriveStatus({ ...base, lastActivityAt: 10, archivedAt: 20 }, 30, W)).toBe('archived')
    expect(deriveStatus({ ...base, lastActivityAt: 10, archivedAt: 10 }, 30, W)).toBe('archived')
    expect(deriveStatus({ ...base, lastActivityAt: 21, archivedAt: 20 }, 30, W)).toBe('active')
  })
  it('isActive covers needs-you, running and active', () => {
    expect(['needs-you', 'running', 'active', 'inactive', 'archived'].map((s) => isActive(s as never))).toEqual([
      true, true, true, false, false,
    ])
  })
  it('ranks in precedence order', () => {
    expect(statusRank('needs-you')).toBeLessThan(statusRank('running'))
    expect(statusRank('inactive')).toBeLessThan(statusRank('archived'))
  })
})
