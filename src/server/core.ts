/**
 * Server core: one TanStack AI chat() assembly for every run, plus the two
 * things TanStack does not do for us and that this product is about:
 *
 * - **Grants.** Harness permission requests go through `decide()`. A grant held
 *   by the thread allows the action at once; anything else becomes a pending
 *   approval that keeps the agent paused (the ACP request stays open) until a
 *   human answers from any device, or the timeout denies it. "Allow for this
 *   session" writes a grant, so the same kind of action never asks again.
 *   capalg replaces the grant table later; this is the seam.
 * - **Threads index.** TanStack's stores have no "list threads", so we keep a
 *   small table for the sidebar (title, cwd, harness session id).
 *
 * Everything else (transcript, runs, resumable delivery, the ACP bridge, the
 * sandbox) is TanStack's.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { EventType, chat, chatParamsFromRequest } from '@tanstack/ai'
import { acpCompatibleText } from '@tanstack/ai-acp'
import { withPersistence } from '@tanstack/ai-persistence'
import {
  InMemorySandboxInstanceStore,
  defineSandbox,
  defineWorkspace,
  withSandbox,
} from '@tanstack/ai-sandbox'
import { localProcessSandbox } from '@tanstack/ai-sandbox-local-process'
import { InMemoryLockStore } from '@tanstack/ai/locks'
import { sqlitePersistence } from './sqlite-persistence'
import type { ModelMessage, StreamChunk, StreamDurability, UIMessage } from '@tanstack/ai'

// ---------------------------------------------------------------- config

export const config = {
  /** How to start the harness. `omp acp` in real use; the fake agent in tests. */
  agentCommand: process.env.AGENT_CMD ?? 'omp acp',
  /** Harness label: log prefix and the `<name>.session-id` event name. */
  agentName: process.env.AGENT_NAME ?? 'omp',
  /** Default working directory for new threads. */
  defaultCwd: process.env.PROJECT_DIR ?? process.cwd(),
  dataDir: process.env.DATA_DIR ?? join(process.cwd(), '.data'),
  /** Unanswered approvals are denied after this long (spec R7). */
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 30 * 60_000),
}

mkdirSync(config.dataDir, { recursive: true })
const db = new DatabaseSync(join(config.dataDir, 'acp-cp.db'))
db.exec('PRAGMA journal_mode = WAL')

export const persistence = sqlitePersistence(db)
export const { runs } = persistence.stores

db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id text PRIMARY KEY NOT NULL,
  title text,
  cwd text NOT NULL,
  harness_session_id text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  thread_id text NOT NULL,
  key text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (thread_id, key)
);
-- Every run's raw AG-UI event stream, append-only. TanStack's saved transcript
-- keeps only the final reply of earlier harness turns (their tool rows are
-- dropped on the next turn, @tanstack/ai 0.61), so this is the full record.
CREATE TABLE IF NOT EXISTS run_events (
  run_id text NOT NULL,
  thread_id text NOT NULL,
  seq integer NOT NULL,
  at integer NOT NULL,
  type text NOT NULL,
  chunk_json text NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_events_thread ON run_events (thread_id, at);
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  key text NOT NULL,
  title text NOT NULL,
  kind text,
  detail_json text NOT NULL,
  status text NOT NULL,
  decision text,
  created_at integer NOT NULL,
  resolved_at integer
);
-- A restarted server holds no open ACP requests, so nothing can still be waiting.
UPDATE approvals SET status = 'expired', resolved_at = unixepoch() * 1000 WHERE status = 'pending';
`)

/** Live notifications for the side channel (approvals, thread list changes). */
export const bus = new EventEmitter()
bus.setMaxListeners(0)

// ---------------------------------------------------------------- threads

export interface ThreadRow {
  id: string
  title: string | null
  cwd: string
  harnessSessionId: string | null
  createdAt: number
  updatedAt: number
}

function mapThread(r: Record<string, unknown>): ThreadRow {
  return {
    id: String(r.id),
    title: typeof r.title === 'string' ? r.title : null,
    cwd: String(r.cwd),
    harnessSessionId: typeof r.harness_session_id === 'string' ? r.harness_session_id : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export function ensureThread(id: string, cwd = config.defaultCwd): ThreadRow {
  const now = Date.now()
  db.prepare(
    `INSERT INTO threads (id, cwd, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, cwd, now, now)
  return getThread(id)!
}

export function getThread(id: string): ThreadRow | null {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
  return r ? mapThread(r) : null
}

function touchThread(id: string, patch: { title?: string; harnessSessionId?: string }) {
  if (patch.title !== undefined) {
    db.prepare('UPDATE threads SET title = ? WHERE id = ? AND title IS NULL').run(
      patch.title.slice(0, 80),
      id,
    )
  }
  if (patch.harnessSessionId !== undefined) {
    db.prepare('UPDATE threads SET harness_session_id = ? WHERE id = ?').run(patch.harnessSessionId, id)
  }
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  bus.emit('threads')
}

export async function listThreads() {
  const rows = db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all().map(mapThread)
  const pending = db
    .prepare(`SELECT thread_id, count(*) AS n FROM approvals WHERE status = 'pending' GROUP BY thread_id`)
    .all()
  const pendingBy = new Map(pending.map((r) => [String(r.thread_id), Number(r.n)]))
  return Promise.all(
    rows.map(async (t) => ({
      ...t,
      running: (await runs.findActiveRun(t.id)) !== null,
      pendingApprovals: pendingBy.get(t.id) ?? 0,
    })),
  )
}

// ---------------------------------------------------------------- grants and approvals

/** The shape the ACP adapter hands a permission handler. */
interface PermissionRequest {
  toolCall: { toolCallId?: string; title?: string | null; kind?: string | null; rawInput?: unknown; locations?: unknown }
  options: Array<{ optionId: string; kind: string; name?: string }>
}
type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

export type Decision = 'once' | 'session' | 'deny'

/**
 * What a grant covers. Deliberately the same granularity as TanStack's own
 * approval ids (tool kind + title) for now; capalg brings real resources and
 * rights later.
 */
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

const waiting = new Map<string, (d: Decision | 'cancelled') => void>()

export function hasGrant(threadId: string, key: string): boolean {
  return db.prepare('SELECT 1 FROM grants WHERE thread_id = ? AND key = ?').get(threadId, key) !== undefined
}

export function listGrants(threadId: string) {
  return db.prepare('SELECT key, created_at FROM grants WHERE thread_id = ? ORDER BY created_at').all(threadId)
}

/** The full raw record of a thread's runs, oldest first (for export and future views). */
export function listRunEvents(threadId: string) {
  return db
    .prepare('SELECT run_id, seq, at, chunk_json FROM run_events WHERE thread_id = ? ORDER BY at, run_id, seq')
    .all(threadId)
    .map((r) => ({ runId: String(r.run_id), seq: Number(r.seq), at: Number(r.at), chunk: JSON.parse(String(r.chunk_json)) }))
}

export function listApprovals(threadId: string, status = 'pending') {
  return db
    .prepare('SELECT * FROM approvals WHERE thread_id = ? AND status = ? ORDER BY created_at')
    .all(threadId, status)
    .map((r) => ({
      id: String(r.id),
      threadId: String(r.thread_id),
      runId: String(r.run_id),
      key: String(r.key),
      title: String(r.title),
      kind: typeof r.kind === 'string' ? r.kind : null,
      detail: JSON.parse(String(r.detail_json)),
      status: String(r.status),
      createdAt: Number(r.created_at),
    }))
}

/** Answer a pending approval. Returns false if it is no longer pending. */
export function resolveApproval(id: string, decision: Decision): boolean {
  const row = db.prepare(`SELECT thread_id, key, status FROM approvals WHERE id = ?`).get(id)
  if (!row || row.status !== 'pending') return false
  const resolve = waiting.get(id)
  if (!resolve) return false
  if (decision === 'session') {
    db.prepare(
      'INSERT INTO grants (thread_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(String(row.thread_id), String(row.key), Date.now())
  }
  resolve(decision)
  return true
}

function finishApproval(id: string, status: string, decision: string | null) {
  db.prepare('UPDATE approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?').run(
    status,
    decision,
    Date.now(),
    id,
  )
  waiting.delete(id)
}

/** The harness permission handler: grant check, else park the agent on a human decision. */
function decide(threadId: string, runId: string, signal: AbortSignal) {
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

    const decision = await new Promise<Decision | 'cancelled' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), config.approvalTimeoutMs)
      const onAbort = () => resolve('cancelled')
      signal.addEventListener('abort', onAbort, { once: true })
      waiting.set(id, (d) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(d)
      })
      bus.emit('approvals', threadId)
      bus.emit('threads')
    })

    if (decision === 'cancelled') finishApproval(id, 'cancelled', null)
    else if (decision === 'timeout') finishApproval(id, 'expired', 'deny')
    else finishApproval(id, 'resolved', decision)
    bus.emit('approvals', threadId)
    bus.emit('threads')

    if (decision === 'once' || decision === 'session') return pick(req, ['allow_once', 'allow_always'])
    if (decision === 'cancelled') return { outcome: 'cancelled' }
    return pick(req, ['reject_once', 'reject_always'])
  }
}

// ---------------------------------------------------------------- runs

const instances = new InMemorySandboxInstanceStore()
const locks = new InMemoryLockStore()

/** Runs this process is driving, for the cancel endpoint. */
export const driving = new Map<string, AbortController>()

function firstUserText(messages: Array<UIMessage | ModelMessage>): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if ('parts' in m && Array.isArray(m.parts)) {
      const t = m.parts.find((p) => p.type === 'text')
      if (t && 'content' in t) return String(t.content)
    }
    if ('content' in m && typeof m.content === 'string') return m.content
  }
  return undefined
}

/**
 * The one chat() assembly. The harness session id is captured from the stream
 * and threaded back on the next run, so omp resumes its own session (ACP
 * session/load) instead of starting over.
 */
/**
 * The user messages after the last non-user message: what this request adds.
 *
 * The server is authoritative for history. The client posts the whole thread,
 * but it folds a harness turn into one assistant message while the server
 * stores it split per tool call; merging the two by id duplicates and reorders
 * tool results (observed with @tanstack/ai 0.61 / ai-persistence 0.6.7), which
 * leaves no trailing user message and the ACP adapter refuses the turn. So when
 * a transcript exists we pass only the new turn and let withPersistence append
 * it to the stored history.
 */
export function newTurn(messages: Array<UIMessage | ModelMessage>): Array<UIMessage | ModelMessage> {
  let start = messages.length
  while (start > 0 && messages[start - 1]?.role === 'user') start--
  return start < messages.length ? messages.slice(start) : messages
}

export function startRun(input: {
  threadId: string
  runId: string
  messages: Array<UIMessage | ModelMessage>
  resume?: Awaited<ReturnType<typeof chatParamsFromRequest>>['resume']
  durability: StreamDurability
}): { stream: AsyncIterable<StreamChunk>; abortController: AbortController } {
  const thread = ensureThread(input.threadId)
  const title = firstUserText(input.messages)
  touchThread(thread.id, title ? { title } : {})

  const abortController = new AbortController()
  driving.set(input.runId, abortController)

  const adapter = acpCompatibleText('default', {
    name: config.agentName,
    command: () => config.agentCommand,
    authMode: 'host',
    onPermissionRequest: decide(thread.id, input.runId, abortController.signal),
  })

  const sandbox = defineSandbox({
    id: `thread-${thread.id}`,
    provider: localProcessSandbox({ dir: thread.cwd }),
    workspace: defineWorkspace({ source: { type: 'none' } }),
    lifecycle: { reuse: 'thread' },
  })

  const sessionEvent = `${config.agentName}.session-id`
  const hasHistory = thread.harnessSessionId !== null || input.messages.some((m) => m.role !== 'user')
  const stream = chat({
    threadId: thread.id,
    runId: input.runId,
    adapter,
    messages: hasHistory ? newTurn(input.messages) : input.messages,
    ...(input.resume ? { resume: input.resume } : {}),
    ...(thread.harnessSessionId ? { modelOptions: { sessionId: thread.harnessSessionId } } : {}),
    abortController,
    middleware: [withPersistence(persistence), withSandbox(sandbox, { instances, locks })],
  }) as AsyncIterable<StreamChunk>

  const record = db.prepare(
    'INSERT INTO run_events (run_id, thread_id, seq, at, type, chunk_json) VALUES (?, ?, ?, ?, ?, ?)',
  )
  let seq = 0
  async function* tapped(): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of stream) {
        record.run(input.runId, thread.id, seq++, Date.now(), chunk.type, JSON.stringify(chunk))
        if (chunk.type === EventType.CUSTOM && chunk.name === sessionEvent) {
          const v = chunk.value as { sessionId?: unknown } | null
          if (v && typeof v.sessionId === 'string') touchThread(thread.id, { harnessSessionId: v.sessionId })
        }
        yield chunk
      }
    } finally {
      driving.delete(input.runId)
      touchThread(thread.id, {})
    }
  }
  return { stream: tapped(), abortController }
}
