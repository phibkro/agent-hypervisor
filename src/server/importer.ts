/**
 * Listing and importing sessions that already exist on disk (started in the
 * omp TUI, or anywhere else), over ACP so it works for any harness that
 * advertises `sessionCapabilities.list` and `loadSession`.
 *
 * - list:   ACP `session/list` (omp reads its session store from disk).
 * - import: ACP `session/load`, which replays the whole history as
 *           `session/update` notifications; we turn those into the TanStack
 *           transcript and keep the raw updates in `run_events`.
 *
 * This is its own small ACP client on purpose: TanStack's client drops updates
 * while a load replays, which is exactly the part import needs.
 */
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { config, db, persistence } from './db'
import { canonical, createThread, getProject, importedSessionIds, isWithin } from './projects'
import { updatesToMessages } from './replay'
export { updatesToMessages }
import type { SessionInfo, SessionNotification } from '@agentclientprotocol/sdk'

type Update = SessionNotification['update']

async function withAgent<T>(cwd: string, fn: (conn: ClientSideConnection, updates: Array<Update>) => Promise<T>): Promise<T> {
  const child = spawn(config.agentCommand, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  const exited = new Promise<never>((_, reject) =>
    child.on('exit', (code) => reject(new Error(`agent exited (${code}) ${stderr.trim()}`))),
  )
  const updates: Array<Update> = []
  const conn = new ClientSideConnection(
    () => ({
      // Nothing should run during list/load; refuse anything that tries.
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n.update)
      },
    }),
    // Node's web streams are structurally the DOM ones the SDK is typed against.
    ndJsonStream(Writable.toWeb(child.stdin) as never, Readable.toWeb(child.stdout) as never),
  )
  try {
    const init = await Promise.race([
      conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
      exited,
    ])
    ;(conn as unknown as { init: typeof init }).init = init
    return await Promise.race([fn(conn, updates), exited])
  } finally {
    child.kill()
  }
}

export interface ExternalSession {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  /** Updated within the inactivity window: may still be open in another client. */
  maybeLive: boolean
}

/** On-disk sessions under a project's root that are not imported yet. */
export async function listExternal(projectId: string): Promise<Array<ExternalSession>> {
  const project = getProject(projectId)
  if (!project) throw new Error('unknown project')
  const imported = importedSessionIds()
  const all = await withAgent(project.root, async (conn) => {
    const init = (conn as unknown as { init: { agentCapabilities?: { sessionCapabilities?: { list?: unknown } } } }).init
    if (!init.agentCapabilities?.sessionCapabilities?.list) return []
    const out: Array<SessionInfo> = []
    let cursor: string | undefined
    // No cwd filter: the agent filters by exact cwd, and sessions started in a
    // subdirectory belong to this project too. Bounded to 20 pages.
    for (let page = 0; page < 20; page++) {
      const res = await conn.listSessions({ ...(cursor ? { cursor } : {}) })
      out.push(...res.sessions)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    return out
  })
  const now = Date.now()
  return all
    .filter((s) => isWithin(canonical(s.cwd), project.root) && !imported.has(s.sessionId))
    .map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? null,
      updatedAt: s.updatedAt ?? null,
      maybeLive: s.updatedAt ? now - Date.parse(s.updatedAt) < config.inactiveAfterMs : false,
    }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

/** Import one on-disk session as a thread in the project. */
export async function importSession(input: { projectId: string; sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }) {
  const project = getProject(input.projectId)
  if (!project) throw new Error('unknown project')
  if (importedSessionIds().has(input.sessionId)) throw new Error('already imported')
  const cwd = canonical(input.cwd)
  if (!isWithin(cwd, project.root)) throw new Error('session is outside the project')

  const updates = await withAgent(cwd, async (conn, collected) => {
    await conn.loadSession({ sessionId: input.sessionId, cwd, mcpServers: [] })
    return collected.slice()
  })

  const messages = updatesToMessages(updates)
  const firstUser = messages.find((m) => m.role === 'user')
  const thread = createThread({
    projectId: project.id,
    cwd,
    title: input.title ?? (typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 80) : 'Imported session'),
    harnessSessionId: input.sessionId,
    origin: 'imported',
    lastActivityAt: input.updatedAt ? Date.parse(input.updatedAt) : Date.now(),
  })
  await persistence.stores.messages.saveThread(thread.id, messages)
  const record = db.prepare('INSERT INTO run_events (run_id, thread_id, seq, at, type, chunk_json) VALUES (?, ?, ?, ?, ?, ?)')
  const runId = `import-${input.sessionId}`
  const at = Date.now()
  updates.forEach((u, i) => record.run(runId, thread.id, i, at, 'ACP_REPLAY', JSON.stringify(u)))
  return { thread, messages: messages.length, updates: updates.length }
}
