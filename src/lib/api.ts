import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export interface ThreadSummary {
  id: string
  title: string | null
  cwd: string
  createdAt: number
  updatedAt: number
  running: boolean
  pendingApprovals: number
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
    es.addEventListener('threads', () => void qc.invalidateQueries({ queryKey: ['threads'] }))
    es.addEventListener('approvals', (e) => {
      const { threadId } = JSON.parse((e as MessageEvent).data) as { threadId: string }
      void qc.invalidateQueries({ queryKey: ['approvals', threadId] })
    })
    return () => es.close()
  }, [qc])
}
