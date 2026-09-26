import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import type { UIMessage } from '@tanstack/ai-react'
import { Streamdown } from 'streamdown'
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  ShieldQuestion,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChatHeader } from '@/components/chat-header'
import { getJson, postJson } from '@/lib/api'
import type { Decision, PendingApproval, ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

type Part = UIMessage['parts'][number]
type Segment = { kind: 'text'; content: string } | { kind: 'steps'; parts: Array<Part> }

/**
 * Replies-only view: text parts render as the message; everything between two
 * replies (thinking, tool calls, tool results) folds into one "steps" row.
 */
function segment(parts: Array<Part>): Array<Segment> {
  const out: Array<Segment> = []
  for (const p of parts) {
    if (p.type === 'text') {
      if (!p.content) continue
      out.push({ kind: 'text', content: p.content })
    } else if (p.type === 'thinking' || p.type === 'tool-call' || p.type === 'tool-result') {
      const last = out.at(-1)
      if (last?.kind === 'steps') last.parts.push(p)
      else out.push({ kind: 'steps', parts: [p] })
    }
  }
  return out
}

function preview(value: unknown, max = 400): string {
  if (value === undefined || value === null) return ''
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** ACP tool calls carry a human title (e.g. "Edit src/config.ts") in their input. */
function toolTitle(part: Extract<Part, { type: 'tool-call' }>): string {
  const input = part.input as { title?: unknown } | undefined
  return typeof input?.title === 'string' && input.title !== '' ? input.title : part.name
}

function StepRow({ part, results }: { part: Part; results: Map<string, unknown> }) {
  if (part.type === 'thinking') {
    return (
      <li className="flex gap-2 text-muted-foreground">
        <Brain className="mt-0.5 size-3.5 shrink-0" />
        <p className="whitespace-pre-wrap italic">{part.content}</p>
      </li>
    )
  }
  if (part.type !== 'tool-call') return null
  const output = part.output ?? results.get(part.id)
  const failed = part.state === 'error'
  const running = !failed && output === undefined && part.state !== 'complete'
  return (
    <li className="flex gap-2">
      {running ? (
        <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : failed ? (
        <X className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      ) : (
        <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{toolTitle(part)}</div>
        {part.arguments && part.arguments !== '{}' && (
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">{preview(part.input ?? part.arguments)}</pre>
        )}
        {output !== undefined && (
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/60 p-2 text-xs text-muted-foreground">{preview(output)}</pre>
        )}
      </div>
    </li>
  )
}

function Steps({ parts, results, live }: { parts: Array<Part>; results: Map<string, unknown>; live: boolean }) {
  const tools = parts.filter((p): p is Extract<Part, { type: 'tool-call' }> => p.type === 'tool-call')
  const thoughts = parts.filter((p) => p.type === 'thinking').length
  const busy = live && tools.some((t) => t.output === undefined && !results.has(t.id) && t.state !== 'complete' && t.state !== 'error')
  const names = tools.map(toolTitle)
  const summary = [
    tools.length > 0 && `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`,
    thoughts > 0 && tools.length === 0 && 'thinking',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <Collapsible className="my-2">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {busy && <LoaderCircle className="size-3.5 shrink-0 animate-spin" />}
        <span className="shrink-0">{summary}</span>
        {names.length > 0 && <span className="truncate opacity-70">· {names.slice(0, 3).join(', ')}{names.length > 3 ? '…' : ''}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 space-y-2 border-l pl-3 text-sm">
          {parts.map((p, i) => (
            <StepRow key={p.type === 'tool-call' ? p.id : i} part={p} results={results} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One visual turn per run of consecutive assistant messages. The stored
 * transcript splits a harness turn into one assistant message per tool call;
 * rendering them together keeps a single "N steps" row per turn.
 */
function toTurns(messages: Array<UIMessage>): Array<UIMessage> {
  const out: Array<UIMessage> = []
  for (const m of messages) {
    const last = out.at(-1)
    if (m.role === 'assistant' && last?.role === 'assistant') {
      out[out.length - 1] = { ...last, parts: [...last.parts, ...m.parts] }
    } else out.push(m)
  }
  return out
}

function Message({ message, live }: { message: UIMessage; live: boolean }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.content : '')).join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2">{text}</div>
      </div>
    )
  }
  const results = new Map<string, unknown>()
  for (const p of message.parts) if (p.type === 'tool-result') results.set(p.toolCallId, p.content)
  return (
    <div className="min-w-0">
      {segment(message.parts).map((s, i) =>
        s.kind === 'text' ? (
          <Streamdown key={i} className="prose-sm max-w-none" isAnimating={live}>
            {s.content}
          </Streamdown>
        ) : (
          <Steps key={i} parts={s.parts} results={results} live={live} />
        ),
      )}
    </div>
  )
}

function ApprovalCard({ approval, onDecide }: { approval: PendingApproval; onDecide: (d: Decision) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const decide = async (d: Decision) => {
    setBusy(true)
    try {
      await onDecide(d)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm" role="alert">
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            omp wants to: {approval.title}
            {approval.kind && (
              <Badge variant="outline" className="ml-2 align-middle">
                {approval.kind}
              </Badge>
            )}
          </div>
          {approval.detail.input != null && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2 text-xs">{preview(approval.detail.input)}</pre>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide('once')}>
              <Check /> Allow once
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide('session')} title="Grant this for the rest of the session">
              Allow for session
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide('deny')}>
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChatView({ threadId }: { threadId: string }) {
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const { messages, sendMessage, isLoading, sessionGenerating, stop, error } = useChat({
    threadId,
    persistence: true,
    connection: fetchServerSentEvents('/api/chat'),
  })
  const working = isLoading || sessionGenerating
  const turns = toTurns(messages)

  const { data: threads } = useQuery({
    queryKey: ['threads'],
    queryFn: () => getJson<Array<ThreadSummary>>('/api/threads'),
  })
  const thread = threads?.find((t) => t.id === threadId)

  const { data: approvals } = useQuery({
    queryKey: ['approvals', threadId],
    queryFn: () => getJson<{ pending: Array<PendingApproval> }>(`/api/approvals?threadId=${threadId}`),
  })
  const pending = approvals?.pending ?? []

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, pending.length])

  const send = () => {
    const text = input.trim()
    if (!text || working) return
    pinned.current = true
    void sendMessage(text)
    setInput('')
  }

  const cancel = () => {
    stop()
    void postJson('/api/cancel', { threadId })
  }

  const decide = async (id: string, decision: Decision) => {
    await postJson('/api/approvals', { id, decision })
    await qc.invalidateQueries({ queryKey: ['approvals', threadId] })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader title={thread?.title ?? 'New session'}>
        {thread && <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{thread.cwd}</span>}
        {working && (
          <Badge variant="secondary" className="gap-1">
            <LoaderCircle className="size-3 animate-spin" /> working
          </Badge>
        )}
      </ChatHeader>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && !working && (
            <p className="py-16 text-center text-sm text-muted-foreground">Ask omp to do something in {thread?.cwd ?? 'this project'}.</p>
          )}
          {turns.map((m, i) => (
            <Message key={m.id} message={m} live={working && i === turns.length - 1} />
          ))}
          {working && messages.at(-1)?.role === 'user' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Starting omp…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="whitespace-pre-wrap">{error.message}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecide={(d) => decide(a.id, d)} />
        ))}
        <form
          className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Message omp…"
            aria-label="Message"
            rows={1}
            className={cn('max-h-48 min-h-10 resize-none border-0 shadow-none focus-visible:ring-0')}
          />
          {working ? (
            <Button type="button" size="icon" variant="secondary" onClick={cancel} aria-label="Stop">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </form>
      </div>
    </div>
  )
}
