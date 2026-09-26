import { createFileRoute } from '@tanstack/react-router'
import { RUN_CANCEL_REASON, requestRunCancel } from '@tanstack/ai'
import { driving, runs } from '../server/core'

/** Stop is a real cancel: a closed connection only detaches (see api.chat.ts). */
export const Route = createFileRoute('/api/cancel')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { threadId?: unknown } | null
        if (!body || typeof body.threadId !== 'string') return new Response('threadId is required', { status: 400 })
        const active = await runs.findActiveRun(body.threadId)
        if (!active) return new Response(null, { status: 204 })
        await requestRunCancel(runs, active.runId)
        driving.get(active.runId)?.abort(RUN_CANCEL_REASON)
        return new Response(null, { status: 204 })
      },
    },
  },
})
