# Agent Control Plane (prototype)

A self-hosted web app for running **omp** on your own machine and following it from
any device: a sidebar of sessions, a replies-first chat, and approvals you can
answer from your phone while omp waits. Built almost entirely from TanStack AI,
TanStack Start and shadcn/ui; the parts that are ours are the grant layer and the
thread index.

```
browser / phone ──SSE──▶ TanStack Start server ──ACP (stdio)──▶ omp acp
                         ├─ chat() + @tanstack/ai-acp  (acpCompatible)
                         ├─ @tanstack/ai-sandbox       (local process, per thread dir)
                         ├─ @tanstack/ai-persistence   (SQLite, conformance-tested)
                         ├─ memoryStream durability    (runs outlive the tab)
                         └─ grants + approvals         (ours: omp pauses until you decide)
```

## Run it

Requires Node ≥ 22.13 (for `node:sqlite`) and `omp` on the `PATH`, signed in.

```sh
npm install
npm run build
HOST=127.0.0.1 PORT=3000 PROJECT_DIR=~/code/my-project npm start
```

Reach it from your phone over your tailnet only:

```sh
tailscale serve --bg 3000        # tailnet-only HTTPS; do NOT use `tailscale funnel` (public)
```

| Env | Default | Meaning |
|---|---|---|
| `AGENT_CMD` | `omp acp` | Command that starts the ACP agent |
| `AGENT_NAME` | `omp` | Label, and the `<name>.session-id` event it emits |
| `PROJECT_DIR` | server cwd | Working directory for new sessions |
| `DATA_DIR` | `./.data` | SQLite database location |
| `APPROVAL_TIMEOUT_MS` | 30 min | Unanswered approvals are denied after this |
| `HOST`, `PORT` | all interfaces, 3000 | Bind to `127.0.0.1` behind Tailscale Serve |

There is **no login**. Anyone who can reach the port can drive omp, so bind to
localhost and expose it only through Tailscale Serve.

## How it behaves

- **Walk away.** A closed tab or locked phone detaches; the run keeps going and the
  client rejoins it (replay from the delivery log). Stop is an explicit cancel.
- **Approvals pause omp.** A permission request becomes a card in every open client
  and a badge in the sidebar. omp stays blocked on the ACP request until you pick
  *Allow once*, *Allow for session* (writes a grant, so the same kind of action is
  never asked again in this session), or *Deny*. No answer by the timeout means deny.
- **Replies first.** Thinking and tool calls fold into one "N steps" row per turn.
- **Sessions resume.** omp's own session id is captured and passed back each turn,
  so omp resumes its session (ACP `session/load`) rather than being re-prompted.
- **Full record.** Every run's raw AG-UI event stream is kept in `run_events`;
  `GET /api/transcript?threadId=…` returns it as NDJSON.

## Verified here (with a scripted fake ACP agent, `fake-agent/agent.mjs`)

| Check | How |
|---|---|
| Persistence adapter meets TanStack's contract | `npx vitest run` (26 conformance tests + helper tests) |
| Approval appears, sidebar badge, survives reload | `node tests/e2e.mjs` (Playwright, desktop + phone) |
| Detach mid-run, approve from elsewhere, rejoin to `RUN_FINISHED` | curl scripts during development |
| Session grant skips the second approval; turn 2 resumes the session | e2e |
| Deny rejects without a grant; cancel ends with `RUN_ERROR` and cancels the pending approval | curl |
| No console errors; no horizontal overflow at 390 px | e2e |

**Not verified:** the real `omp acp` (no LLM credentials in the build environment).
The first real run is on your machine; the three things to watch are listed below.

## Known issues and upstream notes (TanStack AI 0.61.0, ai-persistence 0.6.7)

1. **Earlier turns lose their tool rows in the saved transcript.** On each new turn
   the engine saves only the final reply of previous harness turns. Replies survive;
   steps of older turns do not. `run_events` keeps everything, and a later view can
   rebuild from it. Worth an upstream issue.
2. **Client and server transcripts disagree in shape.** The client folds a harness
   turn into one assistant message; the server stores it split per tool call. Merging
   them by id reordered tool results after the new user message and the ACP adapter
   refused the turn. Workaround in `newTurn()`: the server is authoritative and takes
   only the new user message from the request.
3. **Harness approvals don't reach the client UI.** `permissions: 'interactive'` emits
   an `approval-requested` event shaped `{approvalId, title}`, while the client handles
   a different, deprecated shape. We use a custom `onPermissionRequest` instead, which
   is also where capalg plugs in.

## On first real omp run, check

- omp's permission requests carry useful `title`/`kind` (they become the grant key).
- `omp acp` accepts `session/load` for the captured session id (turn 2 should not
  repeat history to omp).
- How long omp takes to start per turn; the adapter spawns it once per run.

## Layout

```
src/server/core.ts                 run assembly, grants/approvals, thread index, raw log
src/server/sqlite-persistence.ts   TanStack's reference SQLite adapter (docs), unchanged logic
src/routes/api.*.ts                chat (POST run, GET hydrate/rejoin), threads, approvals, cancel, events, transcript
src/components/chat-view.tsx       replies-first chat, steps folding, approval cards, composer
src/components/app-sidebar.tsx     sessions grouped by day, running dot, pending badge
fake-agent/agent.mjs               scripted ACP agent for tests
tests/                             conformance + helper tests (vitest), browser e2e (playwright)
```
