import { createFileRoute } from '@tanstack/react-router'
import { importSession, listExternal } from '../server/core'

/**
 * GET  ?projectId=  sessions on disk under the project that are not imported yet
 * POST { projectId, sessionId, cwd, title?, updatedAt? }  import one
 */
export const Route = createFileRoute('/api/external')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const projectId = new URL(request.url).searchParams.get('projectId')
        if (!projectId) return new Response('projectId is required', { status: 400 })
        try {
          return Response.json(await listExternal(projectId))
        } catch (e) {
          return new Response(e instanceof Error ? e.message : 'list failed', { status: 502 })
        }
      },
      POST: async ({ request }) => {
        const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!b || typeof b.projectId !== 'string' || typeof b.sessionId !== 'string' || typeof b.cwd !== 'string')
          return new Response('projectId, sessionId and cwd are required', { status: 400 })
        try {
          const r = await importSession({
            projectId: b.projectId,
            sessionId: b.sessionId,
            cwd: b.cwd,
            title: typeof b.title === 'string' ? b.title : null,
            updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : null,
          })
          return Response.json(r, { status: 201 })
        } catch (e) {
          return new Response(e instanceof Error ? e.message : 'import failed', { status: 400 })
        }
      },
    },
  },
})
