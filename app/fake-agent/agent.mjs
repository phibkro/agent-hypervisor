#!/usr/bin/env node
/**
 * A scripted ACP agent standing in for `omp acp` in tests (no LLM needed).
 * Based on the example agent shipped in @agentclientprotocol/sdk, shaped after
 * what omp's ACP mode does:
 *
 * - Prompt containing "ask": asks the user through ACP elicitation, using the
 *   same form omp builds for its `ask` tool (q0 single-select with a default,
 *   q0__other free text, q1 multi-select, q1__other), then a yes/no `confirm`.
 *   Like omp, it only asks when the client advertised `elicitation.form`;
 *   otherwise it says it cannot ask.
 * - Any other prompt: a thought, a read tool call, an edit that asks for
 *   permission, then a reply with a per-session turn counter.
 * - session/list and session/load (with full history replay), backed by a state
 *   file, because the harness adapter spawns a fresh process per run.
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
    this.canAsk = false
  }

  async initialize(params) {
    this.canAsk = params.clientCapabilities?.elicitation?.form != null
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      agentInfo: { name: 'fake-omp', version: '0.0.2' },
    }
  }

  async newSession(params) {
    const sessionId = randomUUID()
    const s = loadState()
    s[sessionId] = { turns: 0, cwd: params.cwd, title: null, history: [], updatedAt: new Date().toISOString() }
    saveState(s)
    return { sessionId }
  }

  async loadSession(params) {
    const s = loadState()
    const session = s[params.sessionId]
    if (!session) throw new Error(`unknown session ${params.sessionId}`)
    for (const update of session.history ?? []) {
      await this.connection.sessionUpdate({ sessionId: params.sessionId, update })
    }
    return {}
  }

  async listSessions(params) {
    const s = loadState()
    const sessions = Object.entries(s)
      .filter(([, v]) => !params.cwd || v.cwd === params.cwd)
      .map(([sessionId, v]) => ({ sessionId, cwd: v.cwd, title: v.title, updatedAt: v.updatedAt }))
    return { sessions }
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
    this.log = []
    this.record(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    try {
      if (/\bask\b/i.test(text)) await this.askTurn(params.sessionId, text, controller.signal)
      else await this.editTurn(params.sessionId, text, controller.signal)
      return { stopReason: 'end_turn' }
    } catch (err) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' }
      throw err
    } finally {
      this.pending.delete(params.sessionId)
      const s = loadState()
      if (s[params.sessionId]) {
        s[params.sessionId].history.push(...this.log)
        s[params.sessionId].title ??= text.slice(0, 60)
        s[params.sessionId].updatedAt = new Date().toISOString()
        saveState(s)
      }
    }
  }

  /** Remember what a load should replay. */
  record(sessionId, update) {
    this.log.push(update)
  }

  async update(sessionId, update) {
    this.record(sessionId, update)
    await this.connection.sessionUpdate({ sessionId, update })
  }

  async reply(sessionId, text, signal) {
    for (const word of text.split(/(?<= )/)) {
      await this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } })
      await sleep(DELAY / 6, signal)
    }
  }

  bumpTurn(sessionId) {
    const s = loadState()
    const turns = (s[sessionId]?.turns ?? 0) + 1
    s[sessionId] = { ...(s[sessionId] ?? { history: [] }), turns }
    saveState(s)
    return turns
  }

  async askTurn(sessionId, text, signal) {
    const turns = this.bumpTurn(sessionId)
    if (!this.canAsk) {
      await this.reply(sessionId, `I would ask you, but this client cannot show questions. Turn ${turns}.`, signal)
      return
    }
    await this.update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I need two decisions.' } })
    // The exact form omp's ACP mode builds for `ask` with two questions.
    const form = await this.connection.unstable_createElicitation({
      sessionId,
      mode: 'form',
      message: 'Answer 2 questions',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'string',
            title: 'Which database should the cache use?',
            description: 'Storage',
            oneOf: [
              { const: 'SQLite', title: 'SQLite', description: 'One file, no server' },
              { const: 'Redis', title: 'Redis', description: 'Fast, needs a server' },
            ],
            default: 'SQLite',
          },
          q0__other: { type: 'string', title: 'Other (type your own)' },
          q1: {
            type: 'array',
            title: 'Which checks should run before merge?',
            items: { anyOf: [{ const: 'lint', title: 'lint' }, { const: 'typecheck', title: 'typecheck' }, { const: 'tests', title: 'tests' }] },
          },
          q1__other: { type: 'string', title: 'Other (type your own)' },
        },
      },
    })
    if (form.action !== 'accept') {
      await this.reply(sessionId, `You ${form.action === 'decline' ? 'declined' : 'dismissed'} the questions. Turn ${turns}.`, signal)
      return
    }
    const c = form.content ?? {}
    const db = c.q0__other || c.q0 || '(none)'
    const checks = [...(Array.isArray(c.q1) ? c.q1 : []), ...(c.q1__other ? [c.q1__other] : [])]
    const confirm = await this.connection.unstable_createElicitation({
      sessionId,
      mode: 'form',
      message: `Apply: ${db} cache, checks ${checks.join(', ') || 'none'}?`,
      requestedSchema: { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] },
    })
    const ok = confirm.action === 'accept' && confirm.content?.value === true
    await this.reply(
      sessionId,
      ok
        ? `Confirmed. Cache: ${db}. Checks: ${checks.join(', ') || 'none'}. Turn ${turns}.`
        : `Not confirmed, nothing changed. Turn ${turns}.`,
      signal,
    )
  }

  async editTurn(sessionId, text, signal) {
    const turns = this.bumpTurn(sessionId)
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
    const allowed = outcome.outcome === 'selected' && (outcome.optionId === 'allow' || outcome.optionId === 'always')
    await this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: editId,
      status: allowed ? 'completed' : 'failed',
      rawOutput: { applied: allowed },
    })
    await this.reply(
      sessionId,
      allowed
        ? `Done. I edited src/config.ts. This is turn ${turns} of this session. You asked: "${text}".`
        : `The edit was rejected, so I left src/config.ts alone. This is turn ${turns} of this session.`,
      signal,
    )
  }
}

const input = Writable.toWeb(process.stdout)
const output = Readable.toWeb(process.stdin)
new acp.AgentSideConnection((conn) => new FakeAgent(conn), acp.ndJsonStream(input, output))
