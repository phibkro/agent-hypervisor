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
HOST=127.0.0.1 PORT=3000 npm start      # then add a project directory in the UI
```

Reach it from your phone over your tailnet only:

```sh
tailscale serve --bg 3000        # tailnet-only HTTPS; do NOT use `tailscale funnel` (public)
```

| Env | Default | Meaning |
|---|---|---|
| `AGENT_CMD` | `omp acp` | Command that starts the ACP agent |
| `AGENT_NAME` | `omp` | Label, and the `<name>.session-id` event it emits |
| `PROJECT_DIR` | server cwd | Fallback cwd for a session created without a project |
| `DATA_DIR` | `./.data` | SQLite database location |
| `APPROVAL_TIMEOUT_MS` | 30 min | Unanswered approvals are denied, unanswered questions cancelled |
| `INACTIVE_AFTER_MS` | 15 min | Quiet time (no user, no agent output) before a session reads inactive |
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
- **omp can ask you.** omp's `ask` tool reaches the client as ACP form elicitation
  (see below): single-select with the recommended option preselected, multi-select,
  "Other" free text for either, then a Yes/No confirm. Decline is always offered.
  Answers are validated on the server against omp's schema before omp sees them.
- **Projects.** A project is a host directory. A session belongs to the project whose
  root contains its cwd (longest root wins), so a session started in
  `repo/packages/api` lands in `repo`.
- **Import.** Each project lists sessions on disk that are not imported yet (ACP
  `session/list`), e.g. ones started in the omp TUI, and imports one with
  `session/load`, which replays its history. Sessions touched in the last 15 minutes
  are flagged: they may still be open in another omp, and two writers to one session
  file is an ownership problem capalg should settle later.
- **Status labels.** Derived from facts, never stored: *needs you* (a pending approval
  or question) > *running* > *active* > *inactive* (15 min quiet) > *archived*.
  Archive is a timestamp, so any later activity outranks it and the session comes back.
- **Replies first.** Thinking and tool calls fold into one "N steps" row per turn.
- **Sessions resume.** omp's own session id is captured and passed back each turn,
  so omp resumes its session (ACP `session/load`) rather than being re-prompted.
- **Full record.** Every run's raw AG-UI event stream is kept in `run_events`;
  `GET /api/transcript?threadId=…` returns it as NDJSON.

## How prompts get through ACP

omp registers `ask` only when its client can show questions, and in ACP mode it
decides that from the client advertising `elicitation.form`. TanStack's ACP client
doesn't advertise it or route `elicitation/create`, so `src/server/acp-shim.ts` wraps
the transport: it adds the capability to `initialize` and answers `elicitation/create`
itself, leaving everything else to TanStack. omp maps each question to `q<N>`
(string `oneOf` or array `anyOf`) plus `q<N>__other`; answer notes are not sent over
ACP yet (a small omp change would add `q<N>__note`, which the UI already renders).

## Verified here (with a scripted fake ACP agent, `fake-agent/agent.mjs`)

| Check | How |
|---|---|
| Persistence adapter meets TanStack's contract | `npx vitest run` (26 conformance tests) |
| Status precedence, 15-min boundary, archive outranked by activity; form validation; replay mapping | `npx vitest run` (15 more unit tests) |
| Project from a directory; question with multi-select + Other, confirm Yes/No, decline; reload keeps the open question | `node tests/e2e.mjs` |
| Archive hides, new activity brings it back as *needs you*; import a TUI session from a subdirectory, then continue it as turn 2 | e2e (23 checks) |
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
- omp shows `ask` (its question tool) in ACP mode with our shim, and its `session/list`
  finds TUI sessions for the project's directories.

## Layout

```
src/server/runs.ts                 the one chat() assembly per run, raw log
src/server/acp-shim.ts             transport wrapper: advertises and answers ACP elicitation
src/server/attention.ts            approvals, grants, questions (prompts), activity
src/server/projects.ts             projects, threads, derived status
src/server/status.ts               the status algebra (pure)
src/server/importer.ts, replay.ts  list and import on-disk sessions over ACP
src/lib/elicitation.ts             form schema kinds, validation (shared client/server)
src/server/sqlite-persistence.ts   TanStack's reference SQLite adapter (docs), unchanged logic
src/routes/api.*.ts                chat (POST run, GET hydrate/rejoin), threads, approvals, cancel, events, transcript
src/components/chat-view.tsx       replies-first chat, steps folding, approval cards, composer
src/components/prompt-card.tsx     renders omp's questions from the form schema
src/components/app-sidebar.tsx     Needs you, projects, status dots, on-disk import, archived toggle
fake-agent/agent.mjs               scripted ACP agent for tests
tests/                             conformance + helper tests (vitest), browser e2e (playwright)
```
