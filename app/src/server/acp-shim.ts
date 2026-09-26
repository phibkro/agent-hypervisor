/**
 * An ACP transport that sits between TanStack's ACP client and the harness and
 * adds the one thing TanStack's client does not do: elicitation (structured
 * questions from the agent to the user).
 *
 * Why this matters for omp: omp only registers its `ask` tool when the client
 * advertises `elicitation.form` at initialize. TanStack's client advertises
 * only `fs`, so without this shim omp silently has no way to ask questions.
 *
 * What it does, on the parsed JSON-RPC streams:
 * - client → agent: adds `clientCapabilities.elicitation.form` to `initialize`.
 * - agent → client: answers `elicitation/create` requests itself (via
 *   `onElicitation`) and swallows them; everything else passes through.
 *
 * Plugged in with acpCompatible's `openTransport`. The natural upstream fix is
 * an `onElicitation` hook on @tanstack/ai-acp; this is that hook from outside.
 */
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { spawnHandleToAcpTransport } from '@tanstack/ai-acp'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AcpSessionTransport } from '@tanstack/ai-acp'
import type { SandboxHandle } from '@tanstack/ai-sandbox'

type Msg = Record<string, unknown> & { id?: unknown; method?: unknown; params?: unknown }

export type ElicitationHandler = (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>

export async function openElicitingTransport(input: {
  sandbox: SandboxHandle
  cwd: string
  command: string
  env?: Record<string, string>
  signal?: AbortSignal
  onElicitation: ElicitationHandler
}): Promise<AcpSessionTransport> {
  const proc = await input.sandbox.process.spawn(input.command, {
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const bytes = spawnHandleToAcpTransport(proc)
  const inner = ndJsonStream(bytes.writable, bytes.readable)
  const toAgent = inner.writable.getWriter()

  // Serialise writes to the agent: the client's own writes and our replies.
  let writeChain: Promise<void> = Promise.resolve()
  const send = (msg: unknown) => {
    writeChain = writeChain.then(() => toAgent.write(msg as never))
    return writeChain
  }

  const writable = new WritableStream<unknown>({
    write(msg) {
      const m = msg as Msg
      if (m.method === 'initialize' && m.params && typeof m.params === 'object') {
        const params = m.params as { clientCapabilities?: Record<string, unknown> }
        params.clientCapabilities = { ...params.clientCapabilities, elicitation: { form: {} } }
      }
      return send(m)
    },
    close() {
      return writeChain.then(() => toAgent.close())
    },
    abort(reason) {
      return toAgent.abort(reason)
    },
  })

  const readable = inner.readable.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(msg, controller) {
        const m = msg as Msg
        if (m.method === 'elicitation/create' && m.id !== undefined) {
          const id = m.id
          void input
            .onElicitation(m.params as CreateElicitationRequest)
            .then(
              (result) => send({ jsonrpc: '2.0', id, result }),
              (error: unknown) =>
                send({
                  jsonrpc: '2.0',
                  id,
                  error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
                }),
            )
          return
        }
        controller.enqueue(m)
      },
    }),
  )

  return {
    kind: 'stream',
    stream: { readable, writable } as unknown as Extract<AcpSessionTransport, { kind: 'stream' }>['stream'],
    dispose: () => bytes.kill(),
    stderrTail: bytes.stderrTail,
  }
}
