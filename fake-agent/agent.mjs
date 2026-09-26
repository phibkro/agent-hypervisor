#!/usr/bin/env node
/**
 * A scripted ACP agent standing in for `omp acp` in tests (no LLM needed).
 * Based on the example agent shipped in @agentclientprotocol/sdk.
 *
 * Each prompt: a thought, a read tool call, an edit tool call that asks for
 * permission, then a streamed reply that reports the permission outcome and a
 * per-session turn counter. The counter lives in a state file because the
 * harness adapter spawns a fresh process per run and resumes via session/load,
 * so a correct resume shows "turn 2" on the second message.
 *
 * Env: FAKE_AGENT_STATE (state file), FAKE_AGENT_DELAY_MS (pacing, default 150).
 */
import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const STATE = process.env.FAKE_AGENT_STATE ?? '/tmp/fake-acp-agent-state.json'
const DELAY = Number(process.env.FAKE_AGENT_DELAY_MS ?? 150)
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}
function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s))
}

class FakeAgent {
  constructor(connection) {
    this.connection = connection
    this.pending = new Map()
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-omp', version: '0.0.1' },
    }
  }

  async newSession() {
    const sessionId = randomUUID()
    const s = loadState()
    s[sessionId] = { turns: 0 }
    saveState(s)
    return { sessionId }
  }

  async loadSession(params) {
    const s = loadState()
    if (!s[params.sessionId]) throw new Error(`unknown session ${params.sessionId}`)
    return {}
  }

  async authenticate() {
    return {}
  }

  async cancel(params) {
    this.pending.get(params.sessionId)?.abort()
  }

  async prompt(params) {
    const controller = new AbortController()
    this.pending.set(params.sessionId, controller)
    const text = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
    try {
      await this.turn(params.sessionId, text, controller.signal)
      return { stopReason: 'end_turn' }
    } catch (err) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' }
      throw err
    } finally {
      this.pending.delete(params.sessionId)
    }
  }

  update(sessionId, update) {
    return this.connection.sessionUpdate({ sessionId, update })
  }

  async turn(sessionId, text, signal) {
    const s = loadState()
    const turns = (s[sessionId]?.turns ?? 0) + 1
    s[sessionId] = { turns }
    saveState(s)

    await this.update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `Planning how to handle: "${text.slice(0, 60)}"` },
    })
    await sleep(DELAY, signal)

    const readId = `read_${turns}`
    await this.update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: readId,
      title: 'Read README.md',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'README.md' },
    })
    await sleep(DELAY, signal)
    await this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: readId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '# Demo project' } }],
      rawOutput: { bytes: 14 },
    })

    const editId = `edit_${turns}`
    const toolCall = {
      toolCallId: editId,
      title: 'Edit src/config.ts',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'src/config.ts' }],
      rawInput: { path: 'src/config.ts', change: 'set retries = 3' },
    }
    await this.update(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const decision = await this.connection.requestPermission({
      sessionId,
      toolCall,
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
        { kind: 'allow_always', name: 'Always allow', optionId: 'always' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    })
    const outcome = decision.outcome
    const allowed =
      outcome.outcome === 'selected' && (outcome.optionId === 'allow' || outcome.optionId === 'always')
    await this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: editId,
      status: allowed ? 'completed' : 'failed',
      rawOutput: { applied: allowed },
    })

    const reply = allowed
      ? `Done. I edited src/config.ts. This is turn ${turns} of this session. You asked: "${text}".`
      : `The edit was rejected, so I left src/config.ts alone. This is turn ${turns} of this session.`
    for (const word of reply.split(/(?<= )/)) {
      await this.update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: word },
      })
      await sleep(DELAY / 6, signal)
    }
  }
}

const input = Writable.toWeb(process.stdout)
const output = Readable.toWeb(process.stdin)
new acp.AgentSideConnection((conn) => new FakeAgent(conn), acp.ndJsonStream(input, output))
