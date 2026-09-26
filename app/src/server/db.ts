/**
 * Configuration, the one SQLite database, TanStack's persistence over it, and
 * the tables that are ours (projects, threads, grants, approvals, prompts, the
 * raw run log).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { sqlitePersistence } from './sqlite-persistence'

export const config = {
  /** How to start the harness. `omp acp` in real use; the fake agent in tests. */
  agentCommand: process.env.AGENT_CMD ?? 'omp acp',
  /** Harness label: log prefix and the `<name>.session-id` event name. */
  agentName: process.env.AGENT_NAME ?? 'omp',
  /** Default working directory when a session is created without a project. */
  defaultCwd: process.env.PROJECT_DIR ?? process.cwd(),
  dataDir: process.env.DATA_DIR ?? join(process.cwd(), '.data'),
  /** Unanswered approvals and prompts are denied / cancelled after this long. */
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 30 * 60_000),
  /** A session with no user or agent activity for this long becomes inactive. */
  inactiveAfterMs: Number(process.env.INACTIVE_AFTER_MS ?? 15 * 60_000),
}

mkdirSync(config.dataDir, { recursive: true })
export const db = new DatabaseSync(join(config.dataDir, 'acp-cp.db'))
db.exec('PRAGMA journal_mode = WAL')

export const persistence = sqlitePersistence(db)
export const { runs } = persistence.stores

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  root text NOT NULL UNIQUE,
  created_at integer NOT NULL
);
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
CREATE TABLE IF NOT EXISTS prompts (
  id text PRIMARY KEY NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  message text NOT NULL,
  schema_json text NOT NULL,
  status text NOT NULL,
  response_json text,
  created_at integer NOT NULL,
  resolved_at integer
);
`)

/** Add a column if it is missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
function addColumn(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name))
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
addColumn('threads', 'project_id', 'text')
addColumn('threads', 'last_activity_at', 'integer')
addColumn('threads', 'archived_at', 'integer')
addColumn('threads', 'origin', "text NOT NULL DEFAULT 'created'")
db.exec('UPDATE threads SET last_activity_at = updated_at WHERE last_activity_at IS NULL')

// A restarted server holds no open ACP requests, so nothing can still be waiting.
db.exec(`
UPDATE approvals SET status = 'expired', resolved_at = unixepoch() * 1000 WHERE status = 'pending';
UPDATE prompts SET status = 'expired', resolved_at = unixepoch() * 1000 WHERE status = 'pending';
`)

/** Live notifications for the side channel (thread list, approvals, prompts). */
export const bus = new EventEmitter()
bus.setMaxListeners(0)
