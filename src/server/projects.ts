/**
 * Projects and threads.
 *
 * A project is a root directory. A session belongs to the project whose root
 * contains its cwd (longest root wins), so starting omp in `repo/packages/api`
 * still lands in the `repo` project. Harnesses bind sessions to their cwd in
 * different ways (omp and Claude Code by path-encoded folder, Codex by date),
 * so we match on the cwd each harness reports, never on its folder layout.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bus, config, db, runs } from './db'
import { pendingCounts } from './attention'
import { deriveStatus, statusRank } from './status'
import type { SessionStatus } from './status'

export interface Project {
  id: string
  name: string
  root: string
  createdAt: number
}

export interface ThreadRow {
  id: string
  projectId: string | null
  title: string | null
  cwd: string
  harnessSessionId: string | null
  origin: 'created' | 'imported'
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  archivedAt: number | null
}

/** Resolve symlinks like omp does, so aliases of one directory share a project. */
export function canonical(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function gitRoot(start: string): string | null {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function mapProject(r: Record<string, unknown>): Project {
  return { id: String(r.id), name: String(r.name), root: String(r.root), createdAt: Number(r.created_at) }
}

export function listProjects(): Array<Project> {
  return db.prepare('SELECT * FROM projects ORDER BY name').all().map(mapProject)
}

export function getProject(id: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  return r ? mapProject(r) : null
}

export function addProject(root: string, name?: string): Project {
  const dir = canonical(root)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${root}`)
  const existing = db.prepare('SELECT * FROM projects WHERE root = ?').get(dir)
  if (existing) return mapProject(existing)
  const p = { id: randomUUID(), name: name?.trim() || basename(dir) || dir, root: dir, createdAt: Date.now() }
  db.prepare('INSERT INTO projects (id, name, root, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.name, p.root, p.createdAt)
  // Adopt existing threads that live under the new root and are not in a deeper project.
  for (const t of db.prepare('SELECT id, cwd FROM threads').all()) {
    const owner = projectFor(String(t.cwd), false)
    if (owner?.id === p.id) db.prepare('UPDATE threads SET project_id = ? WHERE id = ?').run(p.id, String(t.id))
  }
  bus.emit('threads')
  return p
}

/** The project whose root is the longest prefix of cwd; optionally create one at the git root. */
export function projectFor(cwd: string, create = true): Project | null {
  const dir = canonical(cwd)
  const owner = listProjects()
    .filter((p) => isWithin(dir, p.root))
    .sort((a, b) => b.root.length - a.root.length)[0]
  if (owner || !create) return owner ?? null
  return addProject(gitRoot(dir) ?? dir)
}

function mapThread(r: Record<string, unknown>): ThreadRow {
  return {
    id: String(r.id),
    projectId: typeof r.project_id === 'string' ? r.project_id : null,
    title: typeof r.title === 'string' ? r.title : null,
    cwd: String(r.cwd),
    harnessSessionId: typeof r.harness_session_id === 'string' ? r.harness_session_id : null,
    origin: r.origin === 'imported' ? 'imported' : 'created',
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastActivityAt: Number(r.last_activity_at ?? r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  }
}

export function getThread(id: string): ThreadRow | null {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
  return r ? mapThread(r) : null
}

export function createThread(input: {
  id?: string
  cwd?: string
  projectId?: string
  title?: string
  harnessSessionId?: string
  origin?: 'created' | 'imported'
  lastActivityAt?: number
}): ThreadRow {
  const project = input.projectId ? getProject(input.projectId) : null
  const cwd = canonical(input.cwd ?? project?.root ?? config.defaultCwd)
  const owner = project ?? projectFor(cwd)
  const now = Date.now()
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO threads (id, project_id, title, cwd, harness_session_id, origin, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(
    id,
    owner?.id ?? null,
    input.title ?? null,
    cwd,
    input.harnessSessionId ?? null,
    input.origin ?? 'created',
    now,
    now,
    input.lastActivityAt ?? now,
  )
  bus.emit('threads')
  return getThread(id)!
}

/** A thread for a run: the existing one, or a new one in the default location. */
export function ensureThread(id: string): ThreadRow {
  return getThread(id) ?? createThread({ id })
}

export function updateThread(id: string, patch: { title?: string; harnessSessionId?: string }) {
  if (patch.title !== undefined) {
    db.prepare('UPDATE threads SET title = ? WHERE id = ? AND title IS NULL').run(patch.title.slice(0, 80), id)
  }
  if (patch.harnessSessionId !== undefined) {
    db.prepare('UPDATE threads SET harness_session_id = ? WHERE id = ?').run(patch.harnessSessionId, id)
  }
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  bus.emit('threads')
}

export function setArchived(id: string, archived: boolean) {
  db.prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, id)
  bus.emit('threads')
}

export function importedSessionIds(): Set<string> {
  return new Set(
    db
      .prepare('SELECT harness_session_id FROM threads WHERE harness_session_id IS NOT NULL')
      .all()
      .map((r) => String(r.harness_session_id)),
  )
}

export interface ThreadSummary extends ThreadRow {
  status: SessionStatus
  pending: number
}

export async function listThreads(now = Date.now()): Promise<Array<ThreadSummary>> {
  const pending = pendingCounts()
  const rows = db.prepare('SELECT * FROM threads').all().map(mapThread)
  const out = await Promise.all(
    rows.map(async (t) => {
      const running = (await runs.findActiveRun(t.id)) !== null
      const n = pending.get(t.id) ?? 0
      const status = deriveStatus(
        { running, pending: n, lastActivityAt: t.lastActivityAt, archivedAt: t.archivedAt },
        now,
        config.inactiveAfterMs,
      )
      return { ...t, status, pending: n }
    }),
  )
  return out.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.lastActivityAt - a.lastActivityAt)
}
