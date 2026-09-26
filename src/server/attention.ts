/**
 * Everything that needs a human: approvals (tool permission requests) and
 * prompts (the agent's questions, via ACP elicitation). Both keep the agent
 * paused on an open ACP request until someone answers from any device, the
 * timeout fires, or the run is cancelled.
 *
 * Grants live here too: "Allow for session" writes one, and a later request
 * with the same key is allowed without asking. capalg replaces the grant table
 * later; `decide` is the seam.
 */
import { randomUUID } from 'node:crypto'
import { bus, config, db } from './db'
import { compact, validate } from '../lib/elicitation'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AnswerValue, FormSchema } from '../lib/elicitation'

/** Record activity on a thread (user or agent). Drives the active/inactive status. */
export function touchActivity(threadId: string, at = Date.now()) {
  db.prepare('UPDATE threads SET last_activity_at = max(coalesce(last_activity_at, 0), ?) WHERE id = ?').run(at, threadId)
}

function changed(threadId: string) {
  bus.emit('attention', threadId)
  bus.emit('threads')
}

/** Park until answered, cancelled (run aborted) or timed out. */
function waitFor<T>(id: string, table: Map<string, (v: T) => void>, signal: AbortSignal) {
  return new Promise<T | 'cancelled' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), config.approvalTimeoutMs)
    const onAbort = () => resolve('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
    table.set(id, (v) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(v)
    })
  })
}

// ---------------------------------------------------------------- approvals and grants

interface PermissionRequest {
  toolCall: { toolCallId?: string; title?: string | null; kind?: string | null; rawInput?: unknown; locations?: unknown }
  options: Array<{ optionId: string; kind: string; name?: string }>
}
type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

export type Decision = 'once' | 'session' | 'deny'

/** What a grant covers: tool kind + title for now; capalg brings real resources and rights. */
function grantKey(req: PermissionRequest): string {
  return `${req.toolCall.kind ?? 'other'}:${req.toolCall.title ?? req.toolCall.toolCallId ?? 'unknown'}`
}

function pick(req: PermissionRequest, kinds: Array<string>): PermissionOutcome {
  for (const kind of kinds) {
    const o = req.options.find((c) => c.kind === kind)
    if (o) return { outcome: 'selected', optionId: o.optionId }
  }
  return { outcome: 'cancelled' }
}

const approvalWaiters = new Map<string, (d: Decision) => void>()

export function hasGrant(threadId: string, key: string): boolean {
  return db.prepare('SELECT 1 FROM grants WHERE thread_id = ? AND key = ?').get(threadId, key) !== undefined
}

export function listGrants(threadId: string) {
  return db.prepare('SELECT key, created_at FROM grants WHERE thread_id = ? ORDER BY created_at').all(threadId)
}

export function listApprovals(threadId: string) {
  return db
    .prepare(`SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at`)
    .all(threadId)
    .map((r) => ({
      id: String(r.id),
      threadId: String(r.thread_id),
      runId: String(r.run_id),
      key: String(r.key),
      title: String(r.title),
      kind: typeof r.kind === 'string' ? r.kind : null,
      detail: JSON.parse(String(r.detail_json)),
      createdAt: Number(r.created_at),
    }))
}

export function resolveApproval(id: string, decision: Decision): boolean {
  const row = db.prepare('SELECT thread_id, key, status FROM approvals WHERE id = ?').get(id)
  const resolve = approvalWaiters.get(id)
  if (!row || row.status !== 'pending' || !resolve) return false
  if (decision === 'session') {
    db.prepare('INSERT INTO grants (thread_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(
      String(row.thread_id),
      String(row.key),
      Date.now(),
    )
  }
  touchActivity(String(row.thread_id))
  resolve(decision)
  return true
}

/** The harness permission handler: grant check, else park the agent on a human decision. */
export function decide(threadId: string, runId: string, signal: AbortSignal) {
  return async (req: PermissionRequest): Promise<PermissionOutcome> => {
    const key = grantKey(req)
    if (hasGrant(threadId, key)) return pick(req, ['allow_once', 'allow_always'])

    const id = randomUUID()
    const detail = {
      toolCallId: req.toolCall.toolCallId ?? null,
      input: req.toolCall.rawInput ?? null,
      locations: req.toolCall.locations ?? null,
      options: req.options,
    }
    db.prepare(
      `INSERT INTO approvals (id, thread_id, run_id, key, title, kind, detail_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, threadId, runId, key, req.toolCall.title ?? key, req.toolCall.kind ?? null, JSON.stringify(detail), Date.now())

    const wait = waitFor(id, approvalWaiters, signal)
    changed(threadId)
    const d = await wait
    approvalWaiters.delete(id)
    const status = d === 'cancelled' ? 'cancelled' : d === 'timeout' ? 'expired' : 'resolved'
    const decision = d === 'timeout' ? 'deny' : d === 'cancelled' ? null : d
    db.prepare('UPDATE approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?').run(status, decision, Date.now(), id)
    changed(threadId)

    if (d === 'once' || d === 'session') return pick(req, ['allow_once', 'allow_always'])
    if (d === 'cancelled') return { outcome: 'cancelled' }
    return pick(req, ['reject_once', 'reject_always'])
  }
}

// ---------------------------------------------------------------- prompts (elicitation)

export type PromptAnswer =
  | { action: 'accept'; content: Record<string, AnswerValue> }
  | { action: 'decline' }

const promptWaiters = new Map<string, (a: PromptAnswer) => void>()

export function listPrompts(threadId: string) {
  return db
    .prepare(`SELECT * FROM prompts WHERE thread_id = ? AND status = 'pending' ORDER BY created_at`)
    .all(threadId)
    .map((r) => ({
      id: String(r.id),
      threadId: String(r.thread_id),
      runId: String(r.run_id),
      message: String(r.message),
      schema: JSON.parse(String(r.schema_json)) as FormSchema,
      createdAt: Number(r.created_at),
    }))
}

/** Answer a pending prompt. Returns an error message, or null on success. */
export function answerPrompt(id: string, answer: PromptAnswer): string | null {
  const row = db.prepare('SELECT thread_id, schema_json, status FROM prompts WHERE id = ?').get(id)
  const resolve = promptWaiters.get(id)
  if (!row || row.status !== 'pending' || !resolve) return 'not pending'
  if (answer.action === 'accept') {
    const content = compact(answer.content)
    const problem = validate(JSON.parse(String(row.schema_json)) as FormSchema, content)
    if (problem) return problem
    answer = { action: 'accept', content }
  }
  touchActivity(String(row.thread_id))
  resolve(answer)
  return null
}

/** The elicitation handler for one run: park the agent on the user's answer. */
export function ask(threadId: string, runId: string, signal: AbortSignal) {
  return async (req: CreateElicitationRequest): Promise<CreateElicitationResponse> => {
    if (req.mode !== 'form') return { action: 'decline' } // URL mode (OAuth-style) is not supported yet
    const id = randomUUID()
    db.prepare(
      `INSERT INTO prompts (id, thread_id, run_id, message, schema_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, threadId, runId, req.message, JSON.stringify(req.requestedSchema), Date.now())

    const wait = waitFor(id, promptWaiters, signal)
    changed(threadId)
    const a = await wait
    promptWaiters.delete(id)
    const status = a === 'cancelled' ? 'cancelled' : a === 'timeout' ? 'expired' : a.action === 'accept' ? 'answered' : 'declined'
    db.prepare('UPDATE prompts SET status = ?, response_json = ?, resolved_at = ? WHERE id = ?').run(
      status,
      typeof a === 'string' ? null : JSON.stringify(a),
      Date.now(),
      id,
    )
    changed(threadId)

    if (a === 'cancelled' || a === 'timeout') return { action: 'cancel' }
    return a.action === 'accept' ? { action: 'accept', content: a.content } : { action: 'decline' }
  }
}

/** Pending approvals + prompts per thread, for the status algebra. */
export function pendingCounts(): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT thread_id, count(*) AS n FROM (
         SELECT thread_id FROM approvals WHERE status = 'pending'
         UNION ALL SELECT thread_id FROM prompts WHERE status = 'pending'
       ) GROUP BY thread_id`,
    )
    .all()
  return new Map(rows.map((r) => [String(r.thread_id), Number(r.n)]))
}
