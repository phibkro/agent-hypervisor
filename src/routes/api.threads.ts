import { createFileRoute } from '@tanstack/react-router'
import { createThread, listThreads } from '../server/core'

export const Route = createFileRoute('/api/threads')({
  server: {
    handlers: {
      GET: async () => Response.json(await listThreads()),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; cwd?: unknown }
        try {
          const thread = createThread({
            ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
            ...(typeof body.cwd === 'string' && body.cwd !== '' ? { cwd: body.cwd } : {}),
          })
          return Response.json(thread, { status: 201 })
        } catch (e) {
          return new Response(e instanceof Error ? e.message : 'bad request', { status: 400 })
        }
      },
    },
  },
})
