import { createFileRoute } from '@tanstack/react-router'
import { bus } from '../server/core'

/**
 * Side channel for what the chat stream does not carry: the thread list and
 * pending approvals changed. Clients refetch on each event.
 */
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const enc = new TextEncoder()
        let cleanup = () => {}
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: string, data: unknown) =>
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            const onThreads = () => send('threads', {})
            const onAttention = (threadId: string) => send('attention', { threadId })
            const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 25_000)
            bus.on('threads', onThreads)
            bus.on('attention', onAttention)
            send('ready', {})
            cleanup = () => {
              clearInterval(ping)
              bus.off('threads', onThreads)
              bus.off('attention', onAttention)
            }
            request.signal.addEventListener('abort', () => {
              cleanup()
              try {
                controller.close()
              } catch {}
            })
          },
          cancel() {
            cleanup()
          },
        })
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
        })
      },
    },
  },
})
