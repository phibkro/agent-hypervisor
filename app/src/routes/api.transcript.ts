import { createFileRoute } from '@tanstack/react-router'
import { listRunEvents } from '../server/core'

/** The complete raw event record of a thread, as NDJSON (one AG-UI event per line). */
export const Route = createFileRoute('/api/transcript')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const threadId = new URL(request.url).searchParams.get('threadId')
        if (!threadId) return new Response('threadId is required', { status: 400 })
        const body = listRunEvents(threadId)
          .map((e) => JSON.stringify(e))
          .join('\n')
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
      },
    },
  },
})
