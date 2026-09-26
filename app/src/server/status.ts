/**
 * Session status: one label derived from facts, never stored.
 *
 * Facts are what actually happened (a run is executing, decisions are pending,
 * when anyone last did anything, when the user archived it). The status is a
 * pure function of those facts and the clock, so every combination has exactly
 * one answer and nothing needs a background job to flip labels.
 *
 * Precedence, highest first (also the sidebar sort order):
 *
 *   needs-you  a pending approval or question: the agent is blocked on a human
 *   running    a run is executing
 *   active     recent activity (user or agent) within the inactivity window
 *   inactive   quiet for longer than the window
 *   archived   the user archived it and nothing has happened since
 *
 * Two deliberate rules:
 * - Needing you beats everything, including archived and the inactivity clock:
 *   a blocked agent must never drift out of sight.
 * - Archive is a fact with a timestamp, not a mode. Any activity after it
 *   (a message, an answer, agent output) outranks it, so the session is simply
 *   no longer archived; no separate "unarchive" step is needed.
 */

export type SessionStatus = 'needs-you' | 'running' | 'active' | 'inactive' | 'archived'

export const STATUS_ORDER: ReadonlyArray<SessionStatus> = ['needs-you', 'running', 'active', 'inactive', 'archived']

export interface StatusFacts {
  running: boolean
  /** Pending approvals + pending questions. */
  pending: number
  /** Last user or agent activity, epoch ms. */
  lastActivityAt: number
  /** When the user archived the session, epoch ms, or null. */
  archivedAt: number | null
}

export function deriveStatus(facts: StatusFacts, now: number, inactiveAfterMs: number): SessionStatus {
  if (facts.pending > 0) return 'needs-you'
  if (facts.running) return 'running'
  if (facts.archivedAt !== null && facts.archivedAt >= facts.lastActivityAt) return 'archived'
  return now - facts.lastActivityAt < inactiveAfterMs ? 'active' : 'inactive'
}

/** "An executing session is active": the three states that count as active. */
export function isActive(status: SessionStatus): boolean {
  return status === 'needs-you' || status === 'running' || status === 'active'
}

export function statusRank(status: SessionStatus): number {
  return STATUS_ORDER.indexOf(status)
}
