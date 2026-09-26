/**
 * SQLite persistence for TanStack AI chat state (messages, runs, interrupts,
 * metadata). Copied from TanStack's reference adapter in
 * docs/persistence/build-your-own-chat-adapter.md and checked with their
 * conformance suite (see tests/persistence.test.ts). Keep it close to upstream.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  defineAIPersistence,
  defineInterruptStore,
  defineMessageStore,
  defineMetadataStore,
  defineRunStore,
} from '@tanstack/ai-persistence'
import type { ModelMessage } from '@tanstack/ai'
import type {
  ChatPersistence,
  InterruptRecord,
  InterruptStatus,
  RunRecord,
  RunStatus,
} from '@tanstack/ai-persistence'

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  thread_id text PRIMARY KEY NOT NULL,
  messages_json text NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id text PRIMARY KEY NOT NULL,
  thread_id text NOT NULL,
  status text NOT NULL,
  started_at integer NOT NULL,
  finished_at integer,
  error text,
  error_code text,
  usage_json text,
  sandbox_key text,
  detached_since integer,
  cancel_requested integer,
  driver_epoch integer,
  parent_run_id text,
  subagent_run_id text,
  name text
);
CREATE INDEX IF NOT EXISTS runs_parent_started
  ON runs (parent_run_id, started_at);
CREATE TABLE IF NOT EXISTS interrupts (
  interrupt_id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  status text NOT NULL,
  requested_at integer NOT NULL,
  resolved_at integer,
  payload_json text NOT NULL,
  response_json text
);
CREATE TABLE IF NOT EXISTS metadata (
  scope text NOT NULL,
  key text NOT NULL,
  value_json text NOT NULL,
  PRIMARY KEY (scope, key)
);
`

// `defineMessageStore` types the object inline against the contract, so you get
// autocomplete and checking with no separate `: MessageStore` annotation.
function createMessageStore(db: DatabaseSync) {
  const select = db.prepare(
    'SELECT messages_json FROM messages WHERE thread_id = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO messages (thread_id, messages_json) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET messages_json = excluded.messages_json`,
  )
  return defineMessageStore({
    async loadThread(threadId) {
      const json = select.get(threadId)?.messages_json
      // Unknown thread → [] (never null). `node:sqlite` types columns as a
      // SQL-value union, so narrow to string before parsing (no cast).
      if (typeof json !== 'string') return []
      const parsed: Array<ModelMessage> = JSON.parse(json)
      return parsed
    },
    async saveThread(threadId, messages) {
      upsert.run(threadId, JSON.stringify(messages))
    },
  })
}

// The `status` column is text; validate it back into the union (no cast).
function toRunStatus(value: unknown): RunStatus {
  switch (value) {
    case 'running':
    case 'interrupted':
    case 'completed':
    case 'failed':
    case 'aborted':
      return value
    default:
      throw new TypeError(`Unexpected run status: ${String(value)}`)
  }
}

// `node:sqlite` types columns as a SQL-value union, so coerce/narrow each field
// (String / Number / typeof) rather than casting the whole row.
function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    status: toRunStatus(row.status),
    startedAt: Number(row.started_at),
    ...(row.finished_at != null ? { finishedAt: Number(row.finished_at) } : {}),
    // `error` is a `RunError`: the provider's prose in `error`, its stable
    // classification in `error_code`. Two columns rather than one JSON blob,
    // because `code` is the field an operator filters and groups by
    // (`WHERE error_code = 'rate_limited'`), and this schema keeps the `_json`
    // suffix for columns that really hold serialized JSON. Omit `code` when the
    // column is NULL so the record matches an error that carried no code.
    ...(typeof row.error === 'string'
      ? {
          error: {
            message: row.error,
            ...(typeof row.error_code === 'string'
              ? { code: row.error_code }
              : {}),
          },
        }
      : {}),
    ...(typeof row.usage_json === 'string'
      ? { usage: JSON.parse(row.usage_json) }
      : {}),
    ...(typeof row.sandbox_key === 'string'
      ? { sandboxKey: row.sandbox_key }
      : {}),
    ...(row.detached_since != null
      ? { detachedSince: Number(row.detached_since) }
      : {}),
    // SQLite has no boolean column type; store it as 0/1 in an integer column
    // and convert back here, the same way `detached_since` round-trips epoch ms.
    ...(row.cancel_requested != null
      ? { cancelRequested: Boolean(row.cancel_requested) }
      : {}),
    // The fencing token a takeover bumps. Round-trip it or single-writer
    // fencing silently does nothing: a superseded host re-reads its own epoch,
    // never sees a higher one, and keeps appending to a log it no longer owns.
    ...(row.driver_epoch != null
      ? { driverEpoch: Number(row.driver_epoch) }
      : {}),
    ...(typeof row.parent_run_id === 'string'
      ? { parentRunId: row.parent_run_id }
      : {}),
    ...(typeof row.subagent_run_id === 'string'
      ? { subagentRunId: row.subagent_run_id }
      : {}),
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
  }
}

function createRunStore(db: DatabaseSync) {
  const select = db.prepare('SELECT * FROM runs WHERE run_id = ?')
  const insert = db.prepare(
    `INSERT INTO runs (
       run_id, thread_id, status, started_at, parent_run_id, subagent_run_id, name
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO NOTHING`,
  )
  const active = db.prepare(
    `SELECT * FROM runs WHERE thread_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
  )
  const byThread = db.prepare(
    'SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at ASC',
  )
  const byParent = db.prepare(
    'SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC',
  )
  const reclaimable = db.prepare(
    `SELECT * FROM runs WHERE status = 'running' AND detached_since IS NOT NULL
     AND detached_since <= ? ORDER BY started_at ASC`,
  )
  return defineRunStore({
    async createOrResume(input) {
      const existing = select.get(input.runId)
      if (existing) return mapRun(existing)
      const status: RunStatus = input.status ?? 'running'
      insert.run(
        input.runId,
        input.threadId,
        status,
        input.startedAt,
        input.parentRunId ?? null,
        input.subagentRunId ?? null,
        input.name ?? null,
      )
      return {
        runId: input.runId,
        threadId: input.threadId,
        status,
        startedAt: input.startedAt,
        ...(input.parentRunId !== undefined
          ? { parentRunId: input.parentRunId }
          : {}),
        ...(input.subagentRunId !== undefined
          ? { subagentRunId: input.subagentRunId }
          : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      }
    },
    async update(runId, patch) {
      const sets: Array<string> = []
      const params: Array<string | number | null> = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?')
        params.push(patch.finishedAt)
      }
      if (patch.error !== undefined) {
        // Write both halves together, so a later failure that carries no `code`
        // cannot leave the previous failure's code behind.
        sets.push('error = ?', 'error_code = ?')
        params.push(patch.error.message, patch.error.code ?? null)
      }
      if (patch.usage !== undefined) {
        sets.push('usage_json = ?')
        params.push(JSON.stringify(patch.usage))
      }
      // SANDBOX ONLY, skip these four unless you run durable sandboxed runs:
      // https://tanstack.com/ai/latest/docs/persistence/build-a-sandbox-adapter
      // A chat app never writes them and nothing here reads them.
      //
      // They are the fields a caller CLEARS by writing `undefined` explicitly, so
      // these branches key off key presence (`'field' in patch`), not
      // `!== undefined`.
      if ('sandboxKey' in patch) {
        sets.push('sandbox_key = ?')
        params.push(patch.sandboxKey ?? null)
      }
      if ('detachedSince' in patch) {
        sets.push('detached_since = ?')
        params.push(patch.detachedSince ?? null)
      }
      if ('cancelRequested' in patch) {
        sets.push('cancel_requested = ?')
        params.push(
          patch.cancelRequested === undefined
            ? null
            : patch.cancelRequested
              ? 1
              : 0,
        )
      }
      if ('driverEpoch' in patch) {
        sets.push('driver_epoch = ?')
        params.push(patch.driverEpoch ?? null)
      }
      if (sets.length === 0) return
      params.push(runId)
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(
        ...params,
      )
    },
    async get(runId) {
      const row = select.get(runId)
      return row ? mapRun(row) : null
    },
    // The most recent still-running run for a thread. `reconstructChat` calls
    // this so a hydrating client (a reload, another device, or switching back to
    // a generating thread) learns there is a live run and tails it. Stub it to
    // null and the thread always looks idle on hydrate: the transcript restores,
    // but a reply that was mid-stream never resumes.
    async findActiveRun(threadId) {
      const row = active.get(threadId)
      return row ? mapRun(row) : null
    },
    // Every run for a thread, oldest first. Optional: only needed to render a
    // thread's past agent activity.
    async listByThread(threadId) {
      return byThread.all(threadId).map(mapRun)
    },
    // Child runs for one parent, oldest first. reconstructChat uses this list
    // to put the subagent cards back. Optional, like listByThread.
    async listByParentRun(parentRunId) {
      return byParent.all(parentRunId).map(mapRun)
    },
    // Runs the reaper sweeps: still `running`, and detached since before
    // `now - ttlMs`. `withSandbox`'s detach path sets `detachedSince` for you,
    // and `reapDetachedRuns` from `@tanstack/ai-sandbox` consumes this list;
    // this method only answers the query, scheduling that sweep is the app's
    // job. Optional, like the others above.
    async listReclaimable({ now, ttlMs }) {
      return reclaimable.all(now - ttlMs).map(mapRun)
    },
  })
}

function toInterruptStatus(value: unknown): InterruptStatus {
  switch (value) {
    case 'pending':
    case 'resolved':
    case 'cancelled':
      return value
    default:
      throw new TypeError(`Unexpected interrupt status: ${String(value)}`)
  }
}

function mapInterrupt(row: Record<string, unknown>): InterruptRecord {
  return {
    interruptId: String(row.interrupt_id),
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    status: toInterruptStatus(row.status),
    requestedAt: Number(row.requested_at),
    ...(row.resolved_at != null ? { resolvedAt: Number(row.resolved_at) } : {}),
    payload:
      typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : {},
    ...(typeof row.response_json === 'string'
      ? { response: JSON.parse(row.response_json) }
      : {}),
  }
}

function createInterruptStore(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO interrupts
       (interrupt_id, run_id, thread_id, status, requested_at, payload_json, response_json)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(interrupt_id) DO NOTHING`,
  )
  const resolveRow = db.prepare(
    `UPDATE interrupts SET status = 'resolved', resolved_at = ?, response_json = ?
     WHERE interrupt_id = ?`,
  )
  const cancelRow = db.prepare(
    `UPDATE interrupts SET status = 'cancelled', resolved_at = ? WHERE interrupt_id = ?`,
  )
  const selectOne = db.prepare('SELECT * FROM interrupts WHERE interrupt_id = ?')
  // Every listing is ORDER BY requested_at ASC, which the middleware relies on.
  const byThread = db.prepare(
    'SELECT * FROM interrupts WHERE thread_id = ? ORDER BY requested_at ASC',
  )
  const pendingByThread = db.prepare(
    `SELECT * FROM interrupts WHERE thread_id = ? AND status = 'pending'
     ORDER BY requested_at ASC`,
  )
  const byRun = db.prepare(
    'SELECT * FROM interrupts WHERE run_id = ? ORDER BY requested_at ASC',
  )
  const pendingByRun = db.prepare(
    `SELECT * FROM interrupts WHERE run_id = ? AND status = 'pending'
     ORDER BY requested_at ASC`,
  )
  return defineInterruptStore({
    async create(record) {
      // Insert-if-absent: a duplicate id must never clobber an already-resolved
      // interrupt back to pending.
      insert.run(
        record.interruptId,
        record.runId,
        record.threadId,
        record.requestedAt,
        JSON.stringify(record.payload),
        record.response === undefined ? null : JSON.stringify(record.response),
      )
    },
    async resolve(interruptId, response) {
      resolveRow.run(
        Date.now(),
        response === undefined ? null : JSON.stringify(response),
        interruptId,
      )
    },
    async cancel(interruptId) {
      cancelRow.run(Date.now(), interruptId)
    },
    async get(interruptId) {
      const row = selectOne.get(interruptId)
      return row ? mapInterrupt(row) : null
    },
    async list(threadId) {
      return byThread.all(threadId).map(mapInterrupt)
    },
    async listPending(threadId) {
      return pendingByThread.all(threadId).map(mapInterrupt)
    },
    async listByRun(runId) {
      return byRun.all(runId).map(mapInterrupt)
    },
    async listPendingByRun(runId) {
      return pendingByRun.all(runId).map(mapInterrupt)
    },
  })
}

function createMetadataStore(db: DatabaseSync) {
  const select = db.prepare(
    'SELECT value_json FROM metadata WHERE scope = ? AND key = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO metadata (scope, key, value_json) VALUES (?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json`,
  )
  return defineMetadataStore({
    async get(scope, key) {
      const json = select.get(scope, key)?.value_json
      return typeof json === 'string' ? JSON.parse(json) : null
    },
    async set(scope, key, value) {
      if (value == null) {
        throw new TypeError(
          'Metadata values must be defined, non-null JSON. Use delete() to clear.',
        )
      }
      upsert.run(scope, key, JSON.stringify(value))
    },
    async delete(scope, key) {
      db.prepare('DELETE FROM metadata WHERE scope = ? AND key = ?').run(
        scope,
        key,
      )
    },
  })
}

export function sqlitePersistence(db: DatabaseSync): ChatPersistence {
  db.exec(SCHEMA_SQL)
  return defineAIPersistence({
    stores: {
      messages: createMessageStore(db),
      runs: createRunStore(db),
      interrupts: createInterruptStore(db),
      metadata: createMetadataStore(db),
    },
  })
}
