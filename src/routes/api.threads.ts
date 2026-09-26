import { createFileRoute } from '@tanstack/react-router'
import { randomUUID } from 'node:crypto'
import { config, ensureThread, listThreads } from '../server/core'

export const Route = createFileRoute('/api/threads')({
  server: {
    handlers: {
      GET: async () => Response.json(await listThreads()),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { cwd?: unknown }
        const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : config.defaultCwd
        return Response.json(ensureThread(randomUUID(), cwd), { status: 201 })
      },
    },
  },
})
