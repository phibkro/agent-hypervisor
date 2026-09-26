import { createFileRoute } from '@tanstack/react-router'
import { addProject, listProjects } from '../server/core'

export const Route = createFileRoute('/api/projects')({
  server: {
    handlers: {
      GET: () => Response.json(listProjects()),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { root?: unknown; name?: unknown } | null
        if (!body || typeof body.root !== 'string' || body.root.trim() === '')
          return new Response('root (a directory path) is required', { status: 400 })
        try {
          return Response.json(addProject(body.root.trim(), typeof body.name === 'string' ? body.name : undefined), { status: 201 })
        } catch (e) {
          return new Response(e instanceof Error ? e.message : 'bad request', { status: 400 })
        }
      },
    },
  },
})
