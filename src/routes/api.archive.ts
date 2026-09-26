import { createFileRoute } from '@tanstack/react-router'
import { getThread, setArchived } from '../server/core'

/** Archive is a fact with a timestamp; any later activity outranks it (see status.ts). */
export const Route = createFileRoute('/api/archive')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { threadId?: unknown; archived?: unknown } | null
        if (!body || typeof body.threadId !== 'string' || typeof body.archived !== 'boolean')
          return new Response('threadId and archived (boolean) are required', { status: 400 })
        if (!getThread(body.threadId)) return new Response('unknown thread', { status: 404 })
        setArchived(body.threadId, body.archived)
        return new Response(null, { status: 204 })
      },
    },
  },
})
