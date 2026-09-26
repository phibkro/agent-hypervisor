import { createFileRoute } from '@tanstack/react-router'
import {
  chatParamsFromRequest,
  memoryStream,
  resumeServerSentEventsResponse,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { reconstructChat } from '@tanstack/ai-persistence'
import { persistence, startRun } from '../server/core'

/**
 * POST starts a run. The request's own abort signal is NOT forwarded: a closed
 * tab or a locked phone detaches, the run keeps draining into the delivery log,
 * and the client rejoins. Stop is explicit, via /api/cancel.
 *
 * GET serves the two read paths useChat calls on the same URL:
 * `?threadId=` hydrates the stored thread (transcript + any live run), and
 * `?runId=&offset=` replays a run's delivery log (rejoin after reload).
 */
export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const params = await chatParamsFromRequest(request)
        // Key the delivery log by the run id explicitly so a rejoin by runId
        // always finds it; Last-Event-ID makes a mid-stream reconnect resume.
        const durability = memoryStream({
          runId: params.runId,
          offset: request.headers.get('Last-Event-ID'),
        })
        const { stream, abortController } = startRun({
          threadId: params.threadId,
          runId: params.runId,
          messages: params.messages,
          ...(params.resume ? { resume: params.resume } : {}),
          durability,
        })
        // The controller goes to the response too: aborting it (Stop) is what
        // writes a terminal RUN_ERROR into the log, so rejoiners never hang.
        return toServerSentEventsResponse(stream, {
          abortController,
          durability: { adapter: durability },
        })
      },
      GET: async ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.has('runId')) {
          return resumeServerSentEventsResponse({
            adapter: memoryStream(request, { firstChunkDeadlineMs: 10_000 }),
          })
        }
        // Single-user, tailnet-only for now; a multi-user build must authorize here.
        return reconstructChat(persistence, request)
      },
    },
  },
})
