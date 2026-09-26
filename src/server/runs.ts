/**
 * The one chat() assembly for every run.
 *
 * omp is started through the eliciting transport (acp-shim.ts) so it gets its
 * `ask` tool, permission requests go to `decide`, questions go to `ask`, and
 * the harness session id is captured from the stream and handed back on the
 * next run so omp resumes its own session.
 */
import { EventType, chat, chatParamsFromRequest } from '@tanstack/ai'
import { acpCompatibleText } from '@tanstack/ai-acp'
import { withPersistence } from '@tanstack/ai-persistence'
import { InMemorySandboxInstanceStore, defineSandbox, defineWorkspace, withSandbox } from '@tanstack/ai-sandbox'
import { localProcessSandbox } from '@tanstack/ai-sandbox-local-process'
import { InMemoryLockStore } from '@tanstack/ai/locks'
import { config, db, persistence } from './db'
import { ask, decide, touchActivity } from './attention'
import { ensureThread, updateThread } from './projects'
import { openElicitingTransport } from './acp-shim'
import type { ModelMessage, StreamChunk, StreamDurability, UIMessage } from '@tanstack/ai'

const instances = new InMemorySandboxInstanceStore()
const locks = new InMemoryLockStore()

/** Runs this process is driving, for the cancel endpoint. */
export const driving = new Map<string, AbortController>()

function firstUserText(messages: Array<UIMessage | ModelMessage>): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if ('parts' in m && Array.isArray(m.parts)) {
      const t = m.parts.find((p) => p.type === 'text')
      if (t && 'content' in t) return String(t.content)
    }
    if ('content' in m && typeof m.content === 'string') return m.content
  }
  return undefined
}

/**
 * The user messages after the last non-user message: what this request adds.
 *
 * The server is authoritative for history. The client posts the whole thread,
 * but it folds a harness turn into one assistant message while the server
 * stores it split per tool call; merging the two by id duplicates and reorders
 * tool results (observed with @tanstack/ai 0.61 / ai-persistence 0.6.7), which
 * leaves no trailing user message and the ACP adapter refuses the turn. So when
 * a transcript exists we pass only the new turn and let withPersistence append
 * it to the stored history.
 */
export function newTurn(messages: Array<UIMessage | ModelMessage>): Array<UIMessage | ModelMessage> {
  let start = messages.length
  while (start > 0 && messages[start - 1]?.role === 'user') start--
  return start < messages.length ? messages.slice(start) : messages
}

export function startRun(input: {
  threadId: string
  runId: string
  messages: Array<UIMessage | ModelMessage>
  resume?: Awaited<ReturnType<typeof chatParamsFromRequest>>['resume']
  durability: StreamDurability
}): { stream: AsyncIterable<StreamChunk>; abortController: AbortController } {
  const thread = ensureThread(input.threadId)
  const title = firstUserText(input.messages)
  updateThread(thread.id, title ? { title } : {})
  touchActivity(thread.id)

  const abortController = new AbortController()
  driving.set(input.runId, abortController)

  const adapter = acpCompatibleText('default', {
    name: config.agentName,
    authMode: 'host',
    openTransport: (ctx) =>
      openElicitingTransport({
        sandbox: ctx.sandbox,
        cwd: ctx.cwd,
        command: config.agentCommand,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onElicitation: ask(thread.id, input.runId, abortController.signal),
      }),
    onPermissionRequest: decide(thread.id, input.runId, abortController.signal),
  })

  const sandbox = defineSandbox({
    id: `thread-${thread.id}`,
    provider: localProcessSandbox({ dir: thread.cwd }),
    workspace: defineWorkspace({ source: { type: 'none' } }),
    lifecycle: { reuse: 'thread' },
  })

  const sessionEvent = `${config.agentName}.session-id`
  const hasHistory = thread.harnessSessionId !== null || input.messages.some((m) => m.role !== 'user')
  const stream = chat({
    threadId: thread.id,
    runId: input.runId,
    adapter,
    messages: hasHistory ? newTurn(input.messages) : input.messages,
    ...(input.resume ? { resume: input.resume } : {}),
    ...(thread.harnessSessionId ? { modelOptions: { sessionId: thread.harnessSessionId } } : {}),
    abortController,
    middleware: [withPersistence(persistence), withSandbox(sandbox, { instances, locks })],
  }) as AsyncIterable<StreamChunk>

  const record = db.prepare(
    'INSERT INTO run_events (run_id, thread_id, seq, at, type, chunk_json) VALUES (?, ?, ?, ?, ?, ?)',
  )
  let seq = 0
  let lastTouch = 0
  async function* tapped(): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of stream) {
        const at = Date.now()
        record.run(input.runId, thread.id, seq++, at, chunk.type, JSON.stringify(chunk))
        // Agent output counts as activity; throttled so text deltas don't write per token.
        if (at - lastTouch > 5_000) {
          touchActivity(thread.id, at)
          lastTouch = at
        }
        if (chunk.type === EventType.CUSTOM && chunk.name === sessionEvent) {
          const v = chunk.value as { sessionId?: unknown } | null
          if (v && typeof v.sessionId === 'string') updateThread(thread.id, { harnessSessionId: v.sessionId })
        }
        yield chunk
      }
    } finally {
      driving.delete(input.runId)
      touchActivity(thread.id)
      updateThread(thread.id, {})
    }
  }
  return { stream: tapped(), abortController }
}

/** The full raw record of a thread's runs, oldest first. */
export function listRunEvents(threadId: string) {
  return db
    .prepare('SELECT run_id, seq, at, chunk_json FROM run_events WHERE thread_id = ? ORDER BY at, run_id, seq')
    .all(threadId)
    .map((r) => ({ runId: String(r.run_id), seq: Number(r.seq), at: Number(r.at), chunk: JSON.parse(String(r.chunk_json)) }))
}
