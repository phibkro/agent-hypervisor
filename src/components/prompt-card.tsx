import { useId, useState } from 'react'
import { Check, MessageCircleQuestion, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { compact, fieldKind, options, questions, validate } from '@/lib/elicitation'
import type { AnswerValue, FormSchema, Question } from '@/lib/elicitation'
import type { PendingPrompt } from '@/lib/api'

export type PromptReply = { action: 'accept'; content: Record<string, AnswerValue> } | { action: 'decline' }

/** Sentinel radio value for "type your own", so Other is a real choice, not a side field. */
const OTHER = '\u0000other'

/** A form that is one boolean is omp's `confirm`: render it as Yes / No buttons. */
function confirmKey(schema: FormSchema): string | null {
  const entries = Object.entries(schema.properties)
  return entries.length === 1 && entries[0]![1].type === 'boolean' ? entries[0]![0] : null
}

function initial(schema: FormSchema): Record<string, AnswerValue | undefined> {
  const out: Record<string, AnswerValue | undefined> = {}
  for (const [key, f] of Object.entries(schema.properties)) {
    if (f.default !== undefined) out[key] = f.default as AnswerValue
    else if (f.type === 'array') out[key] = []
  }
  return out
}

function QuestionField({
  q,
  values,
  set,
}: {
  q: Question
  values: Record<string, AnswerValue | undefined>
  set: (key: string, v: AnswerValue | undefined) => void
}) {
  const id = useId()
  const kind = fieldKind(q.field)
  const title = q.field.title ?? q.key
  const otherText = q.other ? String(values[q.other.key] ?? '') : ''

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {q.field.description && (
          <span className="mb-0.5 block text-xs font-normal uppercase tracking-wide text-muted-foreground">{q.field.description}</span>
        )}
        {title}
      </legend>

      {kind === 'single' && (
        <SingleChoice q={q} value={values[q.key]} otherText={otherText} set={set} idPrefix={id} />
      )}

      {kind === 'multi' && (
        <div className="space-y-1.5">
          {options(q.field).map((o) => {
            const list = (values[q.key] as Array<string> | undefined) ?? []
            const cid = `${id}-${o.const}`
            return (
              <div key={o.const} className="flex items-start gap-2">
                <Checkbox
                  id={cid}
                  checked={list.includes(o.const)}
                  onCheckedChange={(c) => set(q.key, c ? [...list, o.const] : list.filter((x) => x !== o.const))}
                  className="mt-0.5"
                />
                <Label htmlFor={cid} className="block font-normal leading-snug">
                  {o.title ?? o.const}
                  {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                </Label>
              </div>
            )
          })}
          {q.other && (
            <Input
              value={otherText}
              onChange={(e) => set(q.other!.key, e.target.value)}
              placeholder="Other (type your own)"
              aria-label={`${title}: other`}
              className="mt-1"
            />
          )}
        </div>
      )}

      {kind === 'text' && (
        <Input value={String(values[q.key] ?? '')} onChange={(e) => set(q.key, e.target.value)} aria-label={title} />
      )}

      {kind === 'number' && (
        <Input
          type="number"
          value={values[q.key] === undefined ? '' : String(values[q.key])}
          onChange={(e) => set(q.key, e.target.value === '' ? undefined : Number(e.target.value))}
          aria-label={title}
        />
      )}

      {kind === 'boolean' && (
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-b`} checked={values[q.key] === true} onCheckedChange={(c) => set(q.key, c === true)} />
          <Label htmlFor={`${id}-b`} className="font-normal">
            Yes
          </Label>
        </div>
      )}

      {q.note && (
        <Input
          value={String(values[q.note.key] ?? '')}
          onChange={(e) => set(q.note!.key, e.target.value)}
          placeholder="Add a note (optional)"
          aria-label={`${title}: note`}
          className="text-xs"
        />
      )}
    </fieldset>
  )
}

function SingleChoice({
  q,
  value,
  otherText,
  set,
  idPrefix,
}: {
  q: Question
  value: AnswerValue | undefined
  otherText: string
  set: (key: string, v: AnswerValue | undefined) => void
  idPrefix: string
}) {
  const [otherPicked, setOtherPicked] = useState(false)
  const current = otherPicked ? OTHER : typeof value === 'string' ? value : ''
  return (
    <RadioGroup
      value={current}
      onValueChange={(v) => {
        if (v === OTHER) {
          setOtherPicked(true)
          set(q.key, undefined)
        } else {
          setOtherPicked(false)
          set(q.key, v)
          if (q.other) set(q.other.key, undefined)
        }
      }}
      className="gap-1.5"
    >
      {options(q.field).map((o) => (
        <div key={o.const} className="flex items-start gap-2">
          <RadioGroupItem id={`${idPrefix}-${o.const}`} value={o.const} className="mt-0.5" />
          <Label htmlFor={`${idPrefix}-${o.const}`} className="block font-normal leading-snug">
            {o.title ?? o.const}
            {q.field.default === o.const && <span className="ml-1.5 text-xs text-muted-foreground">(recommended)</span>}
            {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
          </Label>
        </div>
      ))}
      {q.other && (
        <div className="flex items-start gap-2">
          <RadioGroupItem id={`${idPrefix}-other`} value={OTHER} className="mt-2.5" aria-label="Other" />
          <Input
            value={otherText}
            onFocus={() => {
              setOtherPicked(true)
              set(q.key, undefined)
            }}
            onChange={(e) => set(q.other!.key, e.target.value)}
            placeholder="Other (type your own)"
            aria-label={`${q.field.title ?? q.key}: other`}
          />
        </div>
      )}
    </RadioGroup>
  )
}

export function PromptCard({ prompt, onReply }: { prompt: PendingPrompt; onReply: (r: PromptReply) => Promise<string | null> }) {
  const [values, setValues] = useState(() => initial(prompt.schema))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (key: string, v: AnswerValue | undefined) => setValues((s) => ({ ...s, [key]: v }))

  const send = async (r: PromptReply) => {
    if (r.action === 'accept') {
      const local = validate(prompt.schema, r.content)
      if (local) return setProblem(local)
    }
    setBusy(true)
    setProblem(null)
    try {
      setProblem(await onReply(r))
    } finally {
      setBusy(false)
    }
  }

  const confirm = confirmKey(prompt.schema)
  const qs = questions(prompt.schema)

  return (
    <div className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-3 text-sm" role="group" aria-label="omp is asking">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{prompt.message}</div>
          {confirm ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => send({ action: 'accept', content: { [confirm]: true } })}>
                <Check /> Yes
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => send({ action: 'accept', content: { [confirm]: false } })}>
                <X /> No
              </Button>
            </div>
          ) : (
            <form
              className="mt-3 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                void send({ action: 'accept', content: compact(values) })
              }}
            >
              <div className="max-h-[50dvh] space-y-4 overflow-y-auto pr-1">
                {qs.map((q) => (
                  <QuestionField key={q.key} q={q} values={values} set={set} />
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit" disabled={busy}>
                  <Check /> Submit
                </Button>
                <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => send({ action: 'decline' })}>
                  Decline
                </Button>
              </div>
            </form>
          )}
          {problem && <p className="mt-2 text-xs text-destructive">{problem}</p>}
        </div>
      </div>
    </div>
  )
}
