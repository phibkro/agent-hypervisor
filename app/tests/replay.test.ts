import { describe, expect, it } from 'vitest'
import { updatesToMessages } from '../src/server/replay'

describe('ACP replay to transcript', () => {
  it('rebuilds user, tool and assistant messages and drops thoughts', () => {
    const msgs = updatesToMessages([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the ' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'test' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read a.ts', kind: 'read', status: 'in_progress', rawInput: { path: 'a.ts' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed', rawOutput: { bytes: 3 } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'thanks' } },
    ] as never)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(msgs[0]!.content).toBe('Fix the test')
    const call = (msgs[1] as { toolCalls: Array<{ function: { name: string; arguments: string } }> }).toolCalls[0]!
    expect(call.function.name).toBe('read')
    expect(JSON.parse(call.function.arguments)).toEqual({ title: 'Read a.ts', path: 'a.ts' })
    expect(msgs[2]).toMatchObject({ role: 'tool', toolCallId: 'r1', content: '{"bytes":3}' })
    expect(msgs[3]!.content).toBe('Done.')
  })
})
