import { createFileRoute } from '@tanstack/react-router'
import { listApprovals, listGrants, resolveApproval } from '../server/core'
import type { Decision } from '../server/core'

const DECISIONS = new Set<Decision>(['once', 'session', 'deny'])

export const Route = createFileRoute('/api/approvals')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const threadId = new URL(request.url).searchParams.get('threadId')
        if (!threadId) return new Response('threadId is required', { status: 400 })
        return Response.json({ pending: listApprovals(threadId), grants: listGrants(threadId) })
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null
        if (!body || typeof body.id !== 'string' || !DECISIONS.has(body.decision as Decision)) {
          return new Response('id and decision (once | session | deny) are required', { status: 400 })
        }
        const ok = resolveApproval(body.id, body.decision as Decision)
        return ok ? new Response(null, { status: 204 }) : new Response('not pending', { status: 409 })
      },
    },
  },
})
