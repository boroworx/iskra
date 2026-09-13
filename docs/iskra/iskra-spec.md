# Iskra — build spec

Implementation contract for Iskra, a fork of `pingdotgg/t3code`. Decisions only. For why
any of this exists, see `docs/iskra/iskra-concept.md` — do not read it to resolve an implementation
question.

**Precedence:** where this document and the upstream `AGENTS.md` conflict, this document wins.
Everywhere else, upstream `AGENTS.md` still applies in full — especially the three ways to
hurt yourself, the dev-server rules, and the multi-surface checklist.

---

## 1. Vocabulary

Upstream defines several of these words differently. Use the Iskra column everywhere: code,
comments, commits, UI copy, event names.

| Upstream term | Iskra term                           | Meaning in Iskra                                                                              |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| agent         | **provider**                         | The coding CLI/harness: Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity               |
| provider      | **provider**                         | Unchanged                                                                                     |
| — (new)       | **agent**                            | A persistent entity in a server: name, avatar, role prompt, provider, permissions, scratchpad |
| thread        | **run**                              | One provider session. Ephemeral. Scoped to a card or a conversation                           |
| turn          | **turn**                             | Unchanged: one user-to-agent cycle inside a run                                               |
| project       | **server** (UI) / **project** (code) | A git repo plus its Iskra state. "Server" is user-facing only                                 |
| — (new)       | **channel**                          | A context partition with durable history and a pinned spec                                    |
| — (new)       | **card**                             | A unit of work. Owns a worktree and branch for its lifetime                                   |
| environment   | environment                          | Unchanged                                                                                     |

The upstream rename is a documentation and new-code rule. **Do not mass-rename existing
upstream identifiers.** Touch them only in files you are already changing for another reason.

---

## 2. Stack

Inherited, not chosen. Do not introduce alternatives.

- Monorepo, Node 24 runtime (Bun optional), pnpm workspaces driven by Vite+ (`vp`), SQLite state under the T3 home userdata directory
- `apps/server` — WebSocket, orchestration, providers, checkpointing. Effect-heavy
- `apps/web` — React + Vite
- `apps/desktop` — Electron shell wrapping web
- `apps/mobile` — React Native
- `packages/contracts` — Effect/Schema contracts for everything crossing the wire
- `packages/shared` — shared runtime utils
- `packages/client-runtime` — client logic shared by web and mobile
- `.repos/` — vendored read-only references, including the Effect reference

**`vp`** is the global Vite+ CLI (`curl -fsSL https://vite.plus | bash`); see `docs/findings/m0.3-fork-bootstrap.md`.

### Landmarks

Verified against upstream. Read these before changing anything nearby.

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — the Claude adapter.
  **Not a CLI subprocess:** it is backed by `@anthropic-ai/claude-agent-sdk` and streams
  canonical `ProviderRuntimeEvent`s. Supports interrupts, approvals and user-input requests,
  resume cursors, and thread rollback.
- `apps/server/src/provider/Layers/CodexAdapter.ts` and
  `apps/server/src/provider/Layers/CodexSessionRuntime.ts` — Codex, which does speak an app-server protocol
  over a subprocess. Provider-shaped behaviour differs between the two; decide per adapter.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — where a provider is
  registered.
- `apps/server/src/provider/Layers/ProviderService.ts` — session start, resume cursors,
  session bindings, stop-all recovery.
- `packages/contracts/src/` — `orchestration.ts`, `provider.ts`, `model.ts`, `baseSchemas.ts`.
  Entity ids are built through the `makeEntityId` helper over a trimmed non-empty string
  schema; follow that for `AgentId`, `ChannelId`, `CardId`, `RunId`.

Three upstream capabilities Iskra depends on, all already present:

1. **Interrupt.** The adapter holds the SDK stream fiber and interrupts it on stop; an
   interrupted stream exit is normalized into a completed-interrupted turn. Barge-in that stops
   work is supported. Whether a _message_ sent mid-turn is delivered immediately or queued to
   the turn boundary is still open — see M0.1.
2. **Programmatic permission decisions.** Pending approvals are held as deferred decisions and
   the adapter can return a deny result without prompting the user. This is the hook invariant
   1 rests on — see M0.2.
3. **Unprompted agent output.** The adapter auto-creates a synthetic turn when a message
   arrives with no active turn (background responses between user prompts) and auto-closes
   stale ones. Agents speaking without being asked is already modelled.

Adding a new projected entity is an established pattern upstream: new contracts, a durable
record on the existing schema, a new projection column, and a numbered migration. Follow the
highest-numbered existing migration's shape.

### Effect

The server is Effect-heavy and Effect is the intended style — keep it. Before writing any
Effect code, read `.repos/effect-smol/LLMS.md`. Mirror the patterns in the nearest existing
server file rather than inventing structure. Inferred types over annotations. `any` is
forbidden.

### Surfaces — v1 scope

**Web only.** Desktop wraps web and comes along for free; verify it still launches. **Mobile
is out of scope for M0–M3** — do not add Iskra UI to `apps/mobile`. Shared logic still belongs
in `packages/client-runtime` so mobile remains possible later.

This is a deliberate exception to the upstream multi-surface rule. Every other item on that
checklist — entry points, providers, contracts, reverse states, connection modes, docs — still
applies.

### Fork policy

Hard fork. Iskra does not track upstream after the initial fork point. Do not structure code
to preserve upstream mergeability, and do not refuse a clean change because it would cause
divergence. Record the fork commit SHA in `docs/fork-point.md` for archaeology only.

---

## 3. Architecture

Upstream is event-sourced: clients send typed WebSocket requests → commands → a pure decider →
persisted events → a projector derives the read model. Provider CLIs run as subprocesses;
per-provider adapters translate their protocols into orchestration events. Side effects run in
queue-backed reactors emitting receipts. Each turn ends with a checkpoint, a hidden git ref.

**Iskra is a new projection plus new deciders over that same log.** Consequences, all binding:

- New behavior is new event types and decider rules, not new mutable state.
- Card claiming, merge ordering, mention routing and permission checks are **decider logic** —
  pure, unit-testable, no provider or filesystem access.
- Anything touching a provider CLI belongs in an adapter. Complexity lives at the adapter
  boundary; orchestration stays pure; UI stays dumb.
- Every new wire type goes in `packages/contracts` first.

---

## 4. Data model

Define all of these in `packages/contracts` with Effect/Schema, following the existing contract
files. Field lists are the contract; naming and encoding follow local convention.

**Agent** — durable. `id`, `projectId`, `name` (`[a-z0-9-]+`, unique per project), `avatar`,
`roleTags[]`, `rolePrompt`, `modelSelection` (upstream's provider instance + model + options,
including reasoning effort), `capabilities` (the ceiling for card-scoped runs; see permission
model), `archivedAt?`. Channel membership lives only on the channel. `scratchpadRef` is added in
M3.

**Channel** — durable. `id`, `projectId`, `kind` (`channel` | `dm`), `name`, `topic`,
`pinnedSpec` (plain text in M1; M3 decides whether agents write it), `wakeDepth` (messages of
history given to an agent on wake, default 30), `memberAgentIds[]`. A `dm` channel has exactly
one agent member; its human is implicit until M5 adds more than one.

**Message** — durable, append-only. `id`, `channelId`, `authorKind` (`human` | `agent` |
`system` | `webhook`), `authorId`, `body`, `mentions[]`, `createdAt`, `runThreadId?` (set on an
agent's reply to the run it came from). `mentions` are resolved to agent ids when the message is
posted and recorded on the event; the message projection does not store them yet. Messages are
never part of the command read model; history is ordered and paged by event sequence.

**Card** — durable. `id`, `projectId`, `channelId`, `title`, `body`, `tags[]`,
`status` (`triage` | `ready` | `claimed` | `inProgress` | `inReview` | `landed` | `abandoned`),
`assigneeAgentId?`, `worktreePath?`, `branch?`, `createdBy`, `claimedAt?`.

**Run** — ephemeral, but its events are persisted. `threadId` (the hidden upstream thread backing
it; also the run's id), `channelId`, `agentId`, `triggerMessageId`, `capabilities`, `context` (the
structured payload) and `rendered` (the exact prompt text), `startedAt`, `endedAt?`. The provider
comes from the agent's `modelSelection`. `scope` and `cardId` arrive with cards in M2; every M1
run is a conversation run. `costTokens` arrives in M3.

### Message flag: `addressedToUser`

Each item of run output carries a boolean `addressedToUser`. False by default — reasoning, tool
calls, file reads, denials, all ambient work. True only when the agent is speaking to a human. The client
renders false as grey and true as full white. This flag is the product; treat it as a
first-class part of the contract, not a UI detail.

**How it is set.** Derive it in the adapter from the provider's own typed message kind, which
already distinguishes assistant text from thinking and tool lifecycle events. Assistant text
addressed to the conversation is true; reasoning, tool calls, tool results and progress are
false. Do not ask a model to classify its own output, and do not add a second inference call
for this. If a provider's event stream doesn't carry enough type information to decide, default
to false for that provider and record the gap in `docs/findings/` rather than guessing per
message.

An explicit agent-side convention (a marker the role prompt tells the agent to emit) may be
layered on later if derivation proves too coarse. It is not the v1 mechanism.

### Permission model — decided (M0.2)

A **per-run capability set**: `read`, `write`, `shell`, `network`. Denied unless listed.
Resolved at run start from agent config plus run scope, expressed once in
`packages/contracts`, translated per adapter.

Channel runs get `read` only. An agent's DM is not a run: it is a coding session with the full
thread controls, including the access mode (full access or approval required). Card-scoped runs
get whatever the agent's config allows.

**Claude translation (verified).** `permissionMode: "dontAsk"`, an explicit tool allowlist
(`Read`, `Glob`, `Grep` for a read-only run), and `settingSources: []`. Write and Bash are
refused by the harness, each refusal arriving as a `tool.denied` event, and no file is created.

**`shell` is not a subset of `read`.** Nothing can reliably determine whether a shell command
writes, so `Bash` and equivalents are excluded from any run without the `shell` capability —
never allowlisted "for read-only commands."

**Two upstream settings can widen a run and must be ignored for Iskra runs:** permission flags
in the user's launch arguments, and switching `interactionMode` mid-session. Capability
resolution happens once at run start and nothing in the session may raise it. Add a test that
fails if either path can escalate.

**Codex translation (read from code, not run).** A read-only sandbox with no approval
escalation. **Denials surface as failed items, not as denial events** — semantically different,
since a failure invites a retry and a denial does not. The Codex adapter must normalize a
sandbox-blocked write into the same canonical denial event Claude emits. Until that is built
and verified by running it, Codex is not a supported provider for write-restricted runs.

**Provider scope for M1:** Claude only. Codex support is added when its verdicts are confirmed
by running them, not by reading.

### Runs, context and channels — decided

**A run is a hidden upstream thread.** Every provider contract upstream is keyed by `threadId`
(sessions, turns, runtime events, ingestion). Iskra does not rebuild that machinery. A wake is a
`channel.agent-wake-requested` event from the decider; `RunReactor` then records
`channel.run-started` (agent, capabilities, context and rendered text) before creating the thread,
so the thread is never listed. A thread with a run row is excluded from the thread list and its
live updates, and its provider session always starts with the run's restrictions. Run output is
that thread's upstream messages and activities. A run is live until its session stops or fails;
there is no separate run output or run end event.

**`addressedToUser` maps onto upstream's existing split.** Assistant messages are `true`.
Activities — reasoning, tool lifecycle, `tool.denied` — are `false`. The Iskra projection exposes
the flag; the adapter needs no change for Claude.

**Context injection.** The context builder (M1.3) returns a structured record. A pure renderer
turns it into two strings: the **system prompt** (role prompt, scratchpad, pinned spec) and the
**first message** (the last `wakeDepth` channel messages, then the triggering message; the card
in M2). `channel.run-started` stores the record as `context` and both strings as `rendered`. The
Claude adapter appends the system prompt to Claude Code's own preset, which keeps its tool
instructions, and sends the first message unchanged. The scratchpad joins the system prompt in M3.

**Every run is a fresh session.** Never pass a resume cursor to a run. Durable memory is the
channel and the scratchpad, not the provider's session. When a run's turn settles, `RunReactor`
posts the reply and stops the session, which ends the run; the next wake starts a new run. Session
recovery refuses run threads rather than reviving them without their restrictions.

**One live run per agent.** A message that wakes an agent with a live run in the same channel is
held as `pending` and delivered into that run as its next turn once the current turn ends. It is
never steered into a running turn: the provider can end that turn without reading it. Each
(message, agent) has a delivery status — `pending`, `sent` (in a turn not yet running),
`delivered` (in a running turn) or `undelivered` — recorded by `channel.delivery-updated` and
shown under the message. A run that ends with messages still pending wakes the agent again in a
fresh run; a message sent into a turn that never ran is `undelivered` (invariant 10).
A wake from a different channel is rejected with a system message saying the agent is busy —
contexts are never mixed across channels. Waking past the project's concurrent-run cap (3, a
constant until a project needs another value) is rejected the same way.

**An agent's DM is its coding session — decided after M1.** DMs replace T3 threads: there are no
free-standing threads. Each agent has one continuous thread, `dm:<agentId>`, created on first
open with the agent's model and rendered with the full thread view and composer. Its provider
session starts with the agent's role appended to the harness instructions (Claude; other
providers ignore it for now) and keeps that role across recovery. A DM thread can only be created
for an existing agent in its project. Messages sent mid-turn follow the thread's own queueing:
because the session is continuous, a message the provider has not read yet is read on the next
turn rather than dropped. `kind: dm` channels from M1 remain in the model but are no longer shown.

**What is posted back.** When a run's session is ready again with no active turn, the latest
turn's final assistant message is posted to the run's channel as a `Message` (`authorKind: agent`,
`runThreadId` set). Reasoning, tool calls and
intermediate assistant text stay in the DM view. White rendering means any assistant text; an
agent `@mention`ing a human is a notification concern for M4, not a rendering rule.

**Mentions.** `@name`, matched case-insensitively against agent names in the project, parsed in
the decider and recorded on `channel.message-posted`. A mention of an unknown name is plain text. A
mention of an agent that isn't a member of the channel wakes nothing and posts a system message
saying so.

### New event types (minimum)

`AgentCreated`, `AgentUpdated`, `AgentArchived`, `ChannelCreated`, `ChannelUpdated`,
`MessagePosted`, `AgentMentioned`, `RunStarted`, `ScratchpadWritten`, `CardCreated`,
`CardPromoted`, `CardClaimed`, `CardStatusChanged`, `CardLanded`, `CardAbandoned`.

Implemented under local naming so far: `agent.created` / `updated` / `archived` / `unarchived`,
`channel.created` / `updated` / `archived` / `unarchived`, `channel.message-posted` (mentions on
the payload; there is no separate `AgentMentioned`), `channel.agent-wake-requested` and
`channel.run-started`.

---

## 5. Invariants

These are the rules the deciders enforce. Each needs a test that fails when the rule is
removed.

1. **No writes in channels.** A channel run has capabilities `["read"]` and is denied filesystem
   writes and shell commands at the adapter boundary, and the server refuses a run on any provider
   that cannot enforce that. Writing happens in an agent's DM, under that session's access mode,
   or on a card.
2. **One worktree per card, never per agent.** Created from current main at claim time,
   destroyed on land or abandon. Agents own no workspace.
3. **Agents are silent by default.** A run starts only on an explicit `@mention`, a human message
   in the agent's DM, a card assignment, or a routed webhook event. A channel message with no
   mentions wakes nobody.
4. **One live run per agent, one in-progress card per agent**, and a cap on concurrent runs per
   project (3; a constant until a project needs another value). Wakes beyond either limit are
   rejected with a system message, never dropped silently.
5. **Agent-created cards enter `triage`.** Only a human promotes `triage → ready`. Agents may
   claim only `ready` cards.
6. **Claims are atomic.** Single writer; a losing claim is rejected and the agent is told.
7. **Landing is serialized.** One merge queue per project, one card landing at a time: rebase
   onto main, run the project verify command in the worktree, merge on green. On conflict or
   failure the card returns to `inProgress` with the failure as context for its agent.
8. **Overlap flagging.** When a card lands, any `inProgress` card whose changed file set
   intersects it is flagged and its agent told to rebase before review.
9. **No agent-to-agent DMs.** Agents communicate in channels or through cards. A `dm` channel
   always has exactly one human and one agent; the decider rejects any other membership.
10. **No message is silently dropped.** A message sent to a running agent is held in a `pending`
    state until the provider demonstrably consumes it. If the turn it attached to ends without
    the message being read, it is re-delivered to the next turn or surfaced to the user as
    unanswered. It is never marked delivered on the strength of having been sent. Test the
    turn-ends-without-consuming path explicitly — it was traced in upstream code but not
    observed, so assume it happens.

---

## 6. Milestones

Each task lists its acceptance criteria. A task is done when those are demonstrable, not when
the code looks right. Do not start a milestone before the previous one is accepted.

### M0 — spikes

Answers, not systems. Each produces a written finding in `docs/findings/` and a minimal
reproduction. Do not build product code in M0.

**M0.1 — Mid-turn input (answered for Claude).** A message sent mid-turn is neither delivered
immediately nor rejected: it is read at the next natural break — after the current tool call, or
after the turn ends. Observed 4–19s, with no upper bound. Codex was read from code, not run.

**M0.2 — Deny write tools (answered for Claude).** Writes are blockable by the harness; see the
permission model above. Codex was read from code, not run.

**M0.3 — Fork bootstrap (done).** `vp` is the Vite+ CLI, installed globally with Node takeover
disabled; it appends a PATH line to `~/.zshenv` and `~/.zshrc`. `vp i` and `vp run dev` work on
Node 26 against a worktree copy of real state. Fork point recorded in `docs/fork-point.md`.

**Residual M0 work**, to be run before Codex is enabled as a provider: confirm mid-turn input
behaviour and sandbox denial semantics by running Codex, not reading it.

### M1 — the core bet

One project, one channel, persistent agents, read-only runs, grey/white DM view. **No cards,
no writes.** This milestone alone must feel better than a terminal; if it doesn't, stop.

**M1.1 — Agent entity.** Contracts, events (`AgentCreated`/`Updated`/`Archived`), decider
rules, projector, persistence. _Accept when:_ an agent can be created and survives a server
restart, with a test asserting the projection matches the event log. _Accepted:_ an engine test
restarts on the same SQLite file and compares the restored agents with a replay of the event log.

**M1.2 — Channel and messages.** Channel entity including `kind: dm`, `MessagePosted`,
append-only history projection, `wakeDepth` setting. _Accept when:_ messages persist and
paginate; changing `wakeDepth` changes what a later context build returns; a `dm` channel with
anything other than one human and one agent is rejected. _Accepted:_ an engine test pages posted
messages and shows wake history follow `wakeDepth`; decider tests reject invalid DM membership.

**M1.3 — Context builder.** A pure function from (agent, channel, pinned spec, wakeDepth,
optional card) to a structured context payload, plus a pure renderer from that payload to the
system prompt and first message. No IO. _Accept when:_ both are fully unit-tested and
deterministic for fixed inputs, and the builder returns a structured record — not a concatenated
string. _Accepted:_ builder and renderer unit tests, including exact rendered text and the payload
decoding through its stored schema.

**M1.4 — Read-only run lifecycle.** Start a run as a hidden upstream thread with a fresh Claude
session (no resume cursor), capability `read` only, using the verified configuration in the
permission model above. _Accept when:_ an agent answers a question about the repo; a write
attempt and a shell attempt are both denied at the adapter boundary and appear in the UI as
denial events; the run's thread does not appear in the upstream thread list; the final assistant
message is posted to the channel; and a test proves neither launch-argument flags nor a
mid-session `interactionMode` change can raise the run's capabilities. _Accepted:_ two live Claude
Haiku runs against a dev server — the agent answered from the code, a Write and a Bash attempt
were each refused and recorded as `tool.denied` on the run thread with no file created, the reply
was posted to the channel, and the run thread never appeared in the thread list. Adapter tests
cover launch-arg flags and interaction-mode changes. Rendering the denials is part of M1.7.

**M1.5 — Mention routing.** Parse `@name` mentions on `MessagePosted`; wake only mentioned
member agents, and the agent of a DM. Decider-level, pure. _Accept when:_ a message mentioning
one of three agents starts exactly one run; an unmentioned channel message starts none; a DM
message starts one; a mention of a non-member, of an agent busy in another channel, or beyond
the concurrent-run cap starts none and posts a system message. Test each. _Accepted:_ decider
tests cover each case, and the run reactor test turns a wake into exactly one run.

**M1.6 — Server shell UI.** `apps/web`: project sidebar, channel list, member list showing
agents with presence (idle / running / blocked). Reads the projection; no new state.
_Accept when:_ the shell renders live agent state and presence updates without a refresh.
The shell is Iskra-first: a project rail, then the project's channels and agents; a channel opens
its messages, a composer and its members. `/` opens a channel, and T3's thread view stays reachable
from the sidebar. A channel's messages arrive over `subscribeChannel` (recent messages, then each
new one). Agents run on Claude only: the server refuses a run on any provider that cannot enforce
run restrictions.
_Accepted:_ in a paired browser, an `@mention` sent from the composer showed the agent Working,
its reply arrived in the channel and the agent went back to Idle, with no reload. Server tests
cover the channel subscription and the non-Claude run refusal; an engine test covers idle, running,
blocked and back to idle.

**M1.7 — DM view.** The agent's DM channel, interleaved with the output of all of that agent's
runs (each labelled with its originating channel), rendering `addressedToUser: false` as grey
and `true` as full white. A message sent to a busy agent shows
as `pending` until consumed — upstream marks it sent immediately, which is wrong here (see
invariant 10). Delivery can take tens of seconds with no upper bound, so pending is a normal
state, not an error state. _Accept when:_ a single run visibly produces both grey and white; a
message sent mid-turn shows pending and resolves when read; a message whose turn ends without
consuming it does not silently disappear; and no continuously repainting animation appears in a
GPU profile.
_Accepted:_ in a paired browser, a DM shows the agent's runs labelled by channel, each with tool
activity and a denied Write in grey and the answer in white. A follow-up mentioning a working agent
showed "Waiting for @agent", went in as the run's next turn, and cleared once that turn ran.
`RunReactor` tests cover the next-turn delivery, a re-wake when a run ends with messages waiting,
and `undelivered` when the carrying turn never ran. The new views use no animation; a GPU profile
was not recorded.

**M1.8 — Context inspector.** For any run, show exactly the payload M1.3 produced.
_Accept when:_ the inspector is reachable from the DM view, shows the structured record and both
rendered strings, and the rendered strings match what the adapter sent byte for byte.
_Accepted:_ each run in a DM has a Context button showing the system prompt, first message and
context record. For every run in the test database, the stored first message equals the run
thread's first user message and the stored system prompt equals the one its provider session was
started with.

### M2–M5 (not yet briefed)

M2 cards, worktrees, merge queue. M3 scratchpads and cost display. M4 roles, webhooks, forked
attempts, auto-claim. M5 multiplayer. Brief these when M1 is accepted, not before.

---

## 7. Verifying

Follow upstream rules. In particular:

- Smallest proof the change works. Targeted tests, lint and typecheck for the scope touched.
- **Do not run repo-wide checks.** CI owns the full suite.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and
  worker drains. **A test that needs a timeout to pass is wrong.**
- Backend behavior changes ship with focused tests for that behavior.
- Test observable behavior, not wiring. Do not assert props or mirror the implementation.

---

## 8. Do not

- Do not build cards, worktrees, or any write path before M2.
- Do not add Iskra UI to `apps/mobile` before M4.
- Do not implement free-flowing agent-to-agent conversation, agent DMs, or an orchestrator
  agent. See `docs/iskra/iskra-concept.md` for why; they are not deferred, they are rejected.
- Do not add a second state store, ORM, or bus. SQLite and the event log are the state.
- Do not mass-rename upstream identifiers.
- Do not open a pull request unless explicitly asked.
- Do not commit implementation plans, research notes, or scratch files. Findings go in
  `docs/findings/`; durable decisions go in this file.
