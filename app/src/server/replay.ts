/** ACP `session/load` replay → TanStack transcript. Pure, so it is unit-tested alone. */
import type { ModelMessage } from '@tanstack/ai'
import type { SessionNotification } from '@agentclientprotocol/sdk'

type Update = SessionNotification['update']

function text(content: unknown): string {
  const c = content as { type?: string; text?: string } | undefined
  return c?.type === 'text' && typeof c.text === 'string' ? c.text : ''
}

/**
 * ACP replay → TanStack ModelMessages. Thoughts are left out of the transcript
 * (they stay in the raw log); tool calls keep their title in the arguments so
 * the UI shows "Edit src/config.ts" rather than "edit".
 */
export function updatesToMessages(updates: Array<Update>): Array<ModelMessage> {
  const out: Array<ModelMessage> = []
  let user = ''
  let assistant = ''
  const flushUser = () => {
    if (user) out.push({ role: 'user', content: user })
    user = ''
  }
  const flushAssistant = () => {
    if (assistant) out.push({ role: 'assistant', content: assistant })
    assistant = ''
  }
  for (const u of updates) {
    const x = u as Record<string, unknown> & { sessionUpdate: string }
    switch (x.sessionUpdate) {
      case 'user_message_chunk':
        flushAssistant()
        user += text(x.content)
        break
      case 'agent_message_chunk':
        flushUser()
        assistant += text(x.content)
        break
      case 'tool_call': {
        flushUser()
        const input = (x.rawInput && typeof x.rawInput === 'object' ? x.rawInput : {}) as Record<string, unknown>
        out.push({
          role: 'assistant',
          content: assistant || null,
          toolCalls: [
            {
              id: String(x.toolCallId),
              type: 'function',
              function: { name: String(x.kind ?? 'tool'), arguments: JSON.stringify({ title: x.title, ...input }) },
            },
          ],
        } as ModelMessage)
        assistant = ''
        break
      }
      case 'tool_call_update':
        if (x.status === 'completed' || x.status === 'failed') {
          const body = x.rawOutput ?? (Array.isArray(x.content) ? x.content.map((c) => text((c as { content?: unknown }).content)).join('') : null)
          out.push({ role: 'tool', toolCallId: String(x.toolCallId), content: JSON.stringify(body ?? { status: x.status }) } as ModelMessage)
        }
        break
    }
  }
  flushUser()
  flushAssistant()
  return out
}

