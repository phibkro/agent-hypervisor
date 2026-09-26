import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { FormSchema } from './elicitation'

/** Mirrors server/status.ts: needs-you > running > active > inactive > archived. */
export type SessionStatus = 'needs-you' | 'running' | 'active' | 'inactive' | 'archived'

export interface ThreadSummary {
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
  status: SessionStatus
  pending: number
}

export interface Project {
  id: string
  name: string
  root: string
  createdAt: number
}

export interface ExternalSession {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  maybeLive: boolean
}

export interface PendingPrompt {
  id: string
  threadId: string
  runId: string
  message: string
  schema: FormSchema
  createdAt: number
}

export interface Attention {
  pending: Array<PendingApproval>
  prompts: Array<PendingPrompt>
}

export interface PendingApproval {
  id: string
  threadId: string
  runId: string
  key: string
  title: string
  kind: string | null
  detail: { input?: unknown; locations?: unknown; options?: Array<{ optionId: string; kind: string; name?: string }> }
  createdAt: number
}

export type Decision = 'once' | 'session' | 'deny'

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return (await r.json()) as T
}

export async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/**
 * One EventSource for the whole app: the server says what changed, TanStack
 * Query refetches it. EventSource reconnects on its own after sleep or a
 * dropped network, and we refetch everything when it does.
 */
export function useLiveEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('ready', () => void qc.invalidateQueries())
    es.addEventListener('threads', () => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    })
    es.addEventListener('attention', (e) => {
      const { threadId } = JSON.parse((e as MessageEvent).data) as { threadId: string }
      void qc.invalidateQueries({ queryKey: ['approvals', threadId] })
    })
    // Status is partly a function of time (active → inactive after 15 min of
    // quiet), which no event announces; a slow refetch keeps the labels true.
    const tick = setInterval(() => void qc.invalidateQueries({ queryKey: ['threads'] }), 60_000)
    return () => {
      es.close()
      clearInterval(tick)
    }
  }, [qc])
}
