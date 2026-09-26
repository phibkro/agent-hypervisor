import { createFileRoute } from '@tanstack/react-router'
import { answerPrompt } from '../server/core'
import type { PromptAnswer } from '../server/core'

/** Answer the agent's question: { id, action: 'accept', content } or { id, action: 'decline' }. */
export const Route = createFileRoute('/api/prompts')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = (await request.json().catch(() => null)) as { id?: unknown; action?: unknown; content?: unknown } | null
        if (!b || typeof b.id !== 'string') return new Response('id is required', { status: 400 })
        let answer: PromptAnswer
        if (b.action === 'decline') answer = { action: 'decline' }
        else if (b.action === 'accept' && b.content && typeof b.content === 'object')
          answer = { action: 'accept', content: b.content as Extract<PromptAnswer, { action: 'accept' }>['content'] }
        else return new Response("action must be 'accept' (with content) or 'decline'", { status: 400 })
        const problem = answerPrompt(b.id, answer)
        return problem === null ? new Response(null, { status: 204 }) : new Response(problem, { status: problem === 'not pending' ? 409 : 400 })
      },
    },
  },
})
