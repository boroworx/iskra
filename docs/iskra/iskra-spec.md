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
| — (new)       | **agent**                            | A named worker defined by a repo file (role prompt, model, permissions), with a record in the server |
| thread        | **run**                              | One provider session. Ephemeral. Scoped to a card or a conversation                           |
| turn          | **turn**                             | Unchanged: one user-to-agent cycle inside a run                                               |
| project       | **server** (UI) / **project** (code) | A git repo plus its Iskra state. "Server" is user-facing only                                 |
| — (new)       | **channel**                          | A context partition with durable history and a pinned spec                                    |
| — (new)       | **card**                             | A unit of work, called a **feature** in the UI. Owns a worktree and branch for its lifetime   |
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

**Agent** — durable. Defined by a file in the project checkout, `.iskra/agents/<name>.md`:
frontmatter `id`, `name` (`[a-z0-9-]+`, unique per project), `avatar`, `tags[]`, `model`
(upstream's provider instance + model + options, including reasoning effort) and `capabilities`
(the ceiling for any of its sessions; see permission model); the body is the role prompt. The
format follows Claude Code's subagent files, so `.claude/agents/*.md` and `.github/agents/*.md`
definitions can be imported. The server writes `id` into a file it sees for the first time, so a
rename keeps the agent's history. The server holds what a file cannot: `archivedAt?`, presence,
and the agent's record — spend, cards landed, review returns, Needs you items raised — keyed by
`id`. Definitions are read from the project checkout; editing an agent in the UI writes its file
there. M1 stored definitions in the event log; M2.0 moves them to files. Channel membership lives
only on the channel.

**Channel** — durable. `id`, `projectId`, `kind` (`channel` | `dm`), `name`, `topic`,
`pinnedSpec` (plain text in M1; M3 decides whether agents write it), `wakeDepth` (messages of
history given to an agent on wake, default 30), `memberAgentIds[]`. A `dm` channel has exactly
one agent member; its human is implicit until M5 adds more than one.

**Message** — durable, append-only. `id`, `channelId`, `authorKind` (`human` | `agent` |
`system` | `webhook`), `authorId`, `body`, `mentions[]`, `createdAt`, `runThreadId?` (set on an
agent's reply to the run it came from). `mentions` are resolved to agent ids when the message is
posted and recorded on the event; the message projection does not store them yet. Messages are
never part of the command read model; history is ordered and paged by event sequence.

**Card** — durable. `id`, `projectId`, `channelId?` (where it was proposed), `parentCardId?`,
`attemptGroupId?` (set on best-of-N attempts), `title`, `spec` (plain text), `specState`
(`draft` | `approved` | `skipped`), `tags[]`, `status` (`triage` | `ready` | `inProgress` |
`inReview` | `landing` | `landed` | `abandoned`), `ownerHumanId` (the accountable person; the
single local human until M5), `delegateAgentId?` (the writing agent), `baseBranch?` (null means
the repository's default branch; a sub-card uses its parent's branch), `branch?`, `worktreePath?`,
`budgetCapUsd`, `spentUsd`, `plan[]` (the owner's checklist), `relations[]` (`blocks` |
`blockedBy` | `duplicateOf` | `related` | `overlaps`, each with a card id; a relation is recorded
once and its inverse is applied to the other card), `linearIssueId?`, `createdBy`, `createdAt`.
Each field arrives with the milestone task that uses it. The decision log is the card's
append-only events, projected to its own table and never held in the read model.

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

Channel runs get `read` only. An agent's DM has no session of its own and grants nothing: it writes into
sessions that already exist, under their capabilities. A card's owner
session gets whatever the agent's config allows; a card's helper runs get `read` only.

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
turns it into two strings: the **system prompt** (role prompt, pinned spec) and the
**first message** (the last `wakeDepth` channel messages, then the triggering message; the card
in M2). `channel.run-started` stores the record as `context` and both strings as `rendered`. The
Claude adapter appends the system prompt to Claude Code's own preset, which keeps its tool
instructions, and sends the first message unchanged. Repo knowledge (AGENTS.md) reaches the
agent through the harness itself; a per-agent scratchpad joins the system prompt only if the M3
experiment keeps it.

**Every run is a fresh session.** Never pass a resume cursor to a run. Durable memory is the
channel, the card record and the repo's reviewed knowledge, not the provider's session. When a run's turn settles, `RunReactor`
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

**An agent's DM is a window onto its sessions — decided in M2.** After M1 the DM became a
continuous coding thread, `dm:<agentId>`, working in the project checkout with the agent's role
appended to the harness instructions and its `@name` title kept. In M2 the DM stops writing. It
shows every live and recent session of that agent — card owner sessions, helper and critic runs,
channel and lead runs — labelled by card or channel, grey and white, each with its context or
handoff brief in the inspector and a link to open it in full. Its composer writes into one of the
agent's live sessions, chosen explicitly and defaulting to the most recently active, and the
message follows that session's delivery rules. A DM message never starts a session, and nothing
reached from a DM writes outside a card worktree. An agent's presence is its most urgent session:
`blocked` when any waits on an approval or an answer, `running` when any is working, otherwise
`idle`. The `dm:` thread is retired in M2.3; `kind: dm` channels from M1 remain in the model but
are not shown.

**What is posted back.** When a run's session is ready again with no active turn, the latest
turn's final assistant message is posted to the run's channel as a `Message` (`authorKind: agent`,
`runThreadId` set). Reasoning, tool calls and
intermediate assistant text stay on the run, opened from the reply's "Show work". White rendering means any assistant text; an
agent `@mention`ing a human is a notification concern for M4, not a rendering rule.

**Mentions.** `@name`, matched case-insensitively against agent names in the project, parsed in
the decider and recorded on `channel.message-posted`. A mention of an unknown name is plain text. A
mention of an agent that isn't a member of the channel wakes nothing and posts a system message
saying so.

### Cards, board and integrations — decided (M2 brief)

**A card is a feature.** One branch, one worktree, created from its `baseBranch` when its first
write session starts. The card, not the agent, is the unit of work: an agent can be the delegate on
several cards, each in its own session and worktree.

**Owner and delegate.** `ownerHumanId` is accountable and receives the card's "Needs you" items.
`delegateAgentId` is the only agent that writes. Reassigning the delegate swaps the agent; the
owner does not change.

**One writer, many sessions.** A card has at most one live write session. Planning, building and
fixing CI may each be a fresh session; each new session, and every delegate change, starts from a
**handoff brief** rendered from the spec, the decision log and the diff against `baseBranch`, the
way M1.3 renders run context. **Helpers** are read-only runs scoped to the card (spec, log, diff);
their replies go to the card's activity and are delivered to the owner session's next turn with the
channel delivery statuses. Parallel writing is a **sub-card** with its own branch cut from the
parent's branch, landing into that branch.

**Session states** (from Linear's agent sessions), derived from the upstream thread: `pending`
(starting), `active` (a turn is running), `awaitingInput` (a pending approval or user-input
request), `error` (the session or turn failed), `complete` (settled, waiting for instructions),
`stale` (the session was lost without reaching a terminal state, e.g. across a restart without
recovery). Silence during a long tool call is `active`, not stale.

**Status is derived.** Columns move on events, not drags:

| Status | Entered when | By |
| --- | --- | --- |
| `triage` | Created by an agent, the channel lead, Linear intake, or a human | Event |
| `ready` | A human approves it | **Human** |
| `inProgress` | The delegate's first write session starts | Assigning (human, or the lead's suggestion accepted) |
| `inReview` | The owner calls `request_review` | Agent |
| `landing` | A human approves the merge; the card joins the queue | **Human** |
| `landed` | The queue merged it into `baseBranch` | Event |
| `abandoned` | A human abandons it | **Human** |

Every human decision has its reverse: unapprove, unassign, cancel landing, reopen. A failed check
or merge returns the card to `inProgress` with the failure attached for its delegate.

**Plan gate.** A write session cannot start until `specState` is `approved` or `skipped`. When a
spec is submitted, a cheap read-only **critic** run reviews it and posts findings to the card; a
human approves. Skipping is a human action, recorded with who skipped. Editing an approved spec
returns it to `draft`.

**Review loop.** Entering `inReview` runs the project's checks (tests, lint, verify command) in the
worktree, identically for every provider. A failure, or a human review comment, goes to the
delegate as its next turn. After 3 failed autofix attempts the card raises a "Needs you" item
instead of trying again.

**Budgets.** `spentUsd` is the sum of the card's session and run costs, priced by the existing usage
pricing (`providerReported`, else `modelPriced`). Default `budgetCapUsd` is 10, a constant until a
project needs another value. A turn does not start once `spentUsd` reaches the cap; raising it is a
human command. A model whose cost is `unpriced` needs a human to accept running it uncapped.
Attempts spend from their parent card's budget.

**Best-of-N attempts.** On a `ready` card a human starts 2–4 attempts: sibling sub-cards sharing
the spec and an `attemptGroupId`, each with its own branch, worktree and chosen agent or model.
Review shows their diffs side by side. Promoting one makes its branch the card's branch; the other
attempts are abandoned and their worktrees and branches removed. An attempt never lands on its own.

**Relations and landing.** `blockedBy` holds a card out of `landing` until the blocker lands; the
blocker's relation then becomes `related`. A parent card cannot enter `landing` while a child is
unlanded. When a card lands, any `inProgress` card whose changed files intersect gets an `overlaps`
relation and its delegate is told to rebase.

**Needs you.** One list across projects, derived, never stored: triage cards to approve, specs to
approve, `awaitingInput` and `error` sessions, cards in review with passing checks, exhausted
autofix, reached budgets, merge conflicts. An item can be snoozed until a time or until the card
has new activity. Items show how long they have waited.

**Board tools for agents.** Extend the existing MCP server (which already exposes
`link_pull_request`) with typed tools: `propose_card` (enters `triage`), `record_decision`,
`update_plan`, `request_review`, `ask_owner` (raises `awaitingInput`). Tools create commands; they
never approve, assign or land.

**Channel lead.** An optional agent per channel, on a cheap model, woken by channel messages with no
mentions. It reads the message, the channel's members and open cards, and either proposes cards
into `triage` (with its reasoning and likely duplicates) or does nothing. It never answers, assigns,
approves or wakes other agents. An `@mention` bypasses it.

**Linear, two-way.** Iskra is a Linear OAuth agent app; the token lives in server secrets.

- *Linking.* A card has at most one Linear issue. Issues delegated to Iskra, or matching a project's
  configured team and label, create cards: in `triage`, or `ready` when a human delegated it in
  Linear. Cards approved in Iskra create issues when the project has a linked team.
- *Fields both ways:* title, description ↔ spec, priority, comments. Last write per field wins by
  update time. A description change from Linear edits the spec, and so clears its approval.
- *Status:* Iskra pushes its derived status to the team's mapped workflow states. A status change
  made in Linear is accepted only when it maps to a human decision (backlog/triage → todo approves,
  canceled abandons). Any other change is overwritten on the next sync with a comment explaining
  why.
- *Agent sessions:* the delegate's session posts to the issue as Linear agent activity (thought,
  action, elicitation, response). Answering an elicitation in Linear answers the session.
- *Transport:* a local server usually has no public URL for Linear's webhooks. Sync polls the API
  on an interval and on client focus; webhooks are used only when the server is reachable.

### New event types (minimum)

`AgentCreated`, `AgentUpdated`, `AgentArchived`, `ChannelCreated`, `ChannelUpdated`,
`MessagePosted`, `AgentMentioned`, `RunStarted`, `KnowledgeProposed`, `CardCreated`,
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
   that cannot enforce that. Writing happens only in a card's owner session, inside the card's
   worktree.
2. **One worktree per card, never per agent.** Created from the card's `baseBranch` when its first
   write session starts, removed when it lands or is abandoned. Agents own no workspace.
3. **Agents are silent by default.** A run starts only on an explicit `@mention`, a card
   assignment, a card's helper or critic request, or a routed webhook event. A channel message
   with no mentions wakes only the channel's lead, if it has one; a DM message never starts a
   session.
4. **One live run per agent per channel**, and a cap on concurrent live sessions per project,
   counting channel runs and card sessions (3 by default, a project setting). Wakes beyond either
   limit are rejected with a system message, never dropped silently.
5. **Agent-created cards enter `triage`.** Only a human promotes `triage → ready`. Agents,
   the channel lead and Linear intake never create a `ready` card.
6. **Assignment is atomic.** A card has at most one delegate; a losing assignment is rejected.
7. **Landing is serialized.** One merge queue per project, one card landing at a time: rebase
   onto `baseBranch`, run the project checks in the worktree, merge on green. On conflict or
   failure the card returns to `inProgress` with the failure as context for its delegate. A card
   with an unlanded child or an open `blockedBy` cannot enter the queue.
8. **Overlap flagging.** When a card lands, any `inProgress` card whose changed file set
   intersects it gets an `overlaps` relation and its delegate is told to rebase before review.
9. **No agent-to-agent DMs.** Agents communicate in channels or through cards. A `dm` channel
   always has exactly one human and one agent; the decider rejects any other membership.
10. **No message is silently dropped.** A message sent to a running agent is held in a `pending`
    state until the provider demonstrably consumes it. If the turn it attached to ends without
    the message being read, it is re-delivered to the next turn or surfaced to the user as
    unanswered. It is never marked delivered on the strength of having been sent. Test the
    turn-ends-without-consuming path explicitly — it was traced in upstream code but not
    observed, so assume it happens.
11. **One writer per card.** A write-capable session cannot start on a card that already has a
    live one. Helpers and the critic are read-only.
12. **No writing before the plan gate.** A write session starts only when the card's spec is
    `approved` or `skipped` by a human. Editing the spec returns it to `draft`.
13. **Budgets hold.** No turn starts on a card whose `spentUsd` has reached `budgetCapUsd`; only a
    human raises the cap. An `unpriced` model runs only after a human accepts it uncapped.
14. **Status is derived.** The decider rejects any status command other than the human decisions
    (approve, assign, approve merge, abandon) and their reverses.
15. **Sync cannot move derived status.** A Linear change that does not map to a human decision is
    overwritten and explained; it never changes a card's status.
16. **Attempts do not land alone.** Only the promoted attempt's branch becomes the card's branch;
    promoting abandons the rest.

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

**After M1.** M1 was accepted with DMs as `kind: dm` channels. The DM then became a coding
thread and free-standing threads were removed; M2 turns the DM into a window onto the agent's
sessions (see "An agent's DM is a window onto its sessions"). The M1.7 DM view no longer exists. A run's grey and white output and its M1.8
context inspector now open from "Show work" under the agent's reply in the channel. The
acceptance notes below record M1 as it was accepted.

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
its messages, a composer and its members. `/` opens a channel. A channel's messages arrive over `subscribeChannel` (recent messages, then each
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

### M2 — the board

Cards as features on a derived board, with worktrees, a plan gate, a review loop, a merge queue,
budgets, best-of-N attempts and two-way Linear sync. See "Cards, board and integrations". Build in
order; M2.0–M2.6 is the first usable board, and M2.7 lands before anything starts agent work
without a human in the loop.

**M2.0 — Agents as repo files.** Load agent definitions from `.iskra/agents/*.md`, import from
`.claude/agents/*.md` and `.github/agents/*.md`, write edits made in the UI back to the file,
migrate M1's event-log agents to files. _Accept when:_ a file added to the checkout appears in the
roster without a restart; an imported Claude Code subagent keeps its prompt, model and tools as
capabilities; renaming a file keeps the agent's history; deleting a file archives the agent
rather than erasing its record. _Accepted:_ against a paired dev server, a new `notes.md` appeared
in the sidebar within one poll and had its id written back, renaming it to `scribe.md` with a new
name kept the same agent id, deleting it archived that agent, and the test project's existing
agents were written out as files on first sync. "Import existing agents" turned a Claude Code
subagent (`tools: Read, Glob, Grep`, `model: sonnet`) into `code-reviewer.md` with `read` only,
`claude-sonnet-5` and its prompt. `AgentDefinitionSync` tests cover create, rename, archive and
restore, migration without churn, a broken file archiving nothing, save with rename, and importing
Claude Code and Copilot files once.

**M2.1 — Card entity and derived status.** Contracts, events, decider rules, projection for cards,
relations and the decision log; the human decisions and their reverses. _Accept when:_ decider
tests cover every transition in the status table and each reverse; non-decision status commands
are rejected; agent-created cards land in `triage`; a restart restores cards equal to a replay.
_Accepted:_ `cardRules.ts` holds the status rules as pure functions, tested for every move from
every status. `decider.cards.test.ts` walks a card from triage to landed through each reverse,
rejects forbidden moves with the rule's reason, holds a merge on an open sub-card or blocker,
limits assignment to an active agent of the project after approval, keeps relations symmetric
and within one project, and refuses edits once finished. Every create path produces a `triage`
card. Work start, review request, return to work and land are internal commands a client cannot
send. An engine test restarts on the same SQLite file and compares cards, including their
relations, with a replay of the event log. Cards are not yet streamed to clients; that is M2.5.

**M2.2 — Worktrees and project scripts.** Create and remove card worktrees; extend the existing
project setup script with `run` and `archive` scripts, an `ISKRA_PORT` range per card, and a
non-concurrent run mode for scripts that share a port or database. _Accept when:_ two cards run
the app at the same time on different ports; abandoning a card runs `archive` and removes its
worktree and branch.
_Accepted:_ `CardWorkspace.ts` gives a card an `iskra/<title>-<id>` branch off its base (a
sub-card's parent branch, else the repository default), a worktree, and a free block of ten ports
from 42000, recorded on the card by the internal `card.workspace.set` command. Project scripts
gain `role` (`setup`, `run`, `archive`) and `exclusive`, in `iskra.json` and the stored project
scripts. Its test runs against a real git repository: two cards get distinct worktrees, branches
and port blocks, and each card's setup script writes its own `ISKRA_PORT`; running a `run` script
opens a terminal in each card's worktree with that card's port, and an exclusive script stops
itself on the other card first; a failed setup leaves no worktree or branch behind; abandoning a
card runs `archive`, removes the worktree and branch, and clears the card's workspace. Nothing
creates a workspace yet; card sessions call it in M2.3, and the board's run button arrives in M2.5.

**M2.3 — Card sessions.** Owner write sessions in the card worktree, session states, the handoff
brief, delegate reassignment, helper runs, and the DM as a window onto the agent's sessions.
_Accept when:_ a second write session is refused; reassigning starts a session whose first
message is the brief (spec, decisions, diff), checked byte for byte in the inspector; a helper's
write is denied and its reply reaches the owner's next turn; a session lost across a restart shows
`stale`; an agent's DM lists its sessions by card and channel with their context, a message sent
from it reaches the chosen session, and the `dm:` coding thread is gone.

**M2.4 — Plan gate.** Spec states, the critic run, approval and skip. _Accept when:_ a write
session is refused on a `draft` spec; the critic's findings appear on the card; a skip is recorded
with who skipped; editing an approved spec returns it to `draft`.

**M2.5 — Board and Needs you.** Web: the board by status with card faces (owner, delegate, branch,
badges, diff size, plan progress, spend, children); drag only for human decisions, snapping back
with a reason otherwise; the cross-project Needs you list with snooze and waiting time.
_Accept when:_ statuses and badges update live without a refresh; an illegal drag shows its reason;
a snoozed item returns on new card activity; no continuously repainting animation.

**M2.6 — Review loop and merge queue.** Checks on `inReview`, autofix up to 3 attempts, diff
review with comments to the delegate, approve merge, serialized landing, sub-cards into parents,
`blockedBy` holds, overlap relations. _Accept when:_ a failing check is fixed by the delegate with
no human action; a third failure raises Needs you; two approved cards land one after the other; a
conflicting card returns to `inProgress` with the conflict in its next turn; an overlap is flagged.

**M2.7 — Budgets.** Spend per card from usage pricing, the default cap, stopping at the cap,
raising it, accepting unpriced models. _Accept when:_ a turn is refused at the cap and resumes after
a raise; spend on the card matches the priced usage of its sessions and runs; each agent's page
shows its spend, cards landed, review returns and Needs you items raised.

**M2.8 — Best-of-N attempts.** _Accept when:_ three attempts run in parallel on separate branches;
review shows their diffs side by side; promoting one removes the others' worktrees and branches;
attempt spend counts against the parent's budget.

**M2.9 — Board tools for agents.** The MCP tools. _Accept when:_ a delegate's `propose_card`
creates a `triage` card; `record_decision` appears in the log and in the next handoff brief;
`update_plan` shows on the card face; no tool can approve, assign or land.

**M2.10 — Linear, two-way.** _Accept when:_ an issue delegated to Iskra in Linear becomes a `ready`
card; a card approved in Iskra creates an issue; title, description and comments round-trip; a
Linear status change that is not a decision is overwritten with a comment; a question from the
delegate is answered from Linear; all of it works by polling with no public URL.

**M2.11 — Channel lead.** _Accept when:_ an unmentioned request in a channel produces a `triage`
card linked to the message, with reasoning and likely duplicates; an `@mention` bypasses the lead;
the lead cannot answer, assign, approve or wake another agent.

### M3–M5 (not yet briefed)

M3 knowledge: agents propose AGENTS.md edits as items a human reviews; a per-agent scratchpad
runs as an experiment measured against fresh sessions and is kept only if it wins; cost reporting
across projects. M4 roles, webhooks and scheduled triggers into
triage, auto-claim. M5 multiplayer. Brief each when the previous milestone is accepted.

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

- Do not build M3 or later features (knowledge proposals, scratchpads, roles, webhooks, scheduled triggers,
  auto-claim, multiplayer) during M2.
- Do not add Iskra UI to `apps/mobile` before M4.
- Do not implement free-flowing agent-to-agent conversation, agent-to-agent DMs, or a manager
  agent that directs other agents or merges their work. The channel lead only proposes `triage`
  cards. See `docs/iskra/iskra-concept.md` for why; these are rejected, not deferred.
- Do not add a second state store, ORM, or bus. SQLite and the event log are the state. Agent
  definitions are repo files, like AGENTS.md: configuration, not state.
- Do not mass-rename upstream identifiers.
- Do not open a pull request unless explicitly asked.
- Do not commit implementation plans, research notes, or scratch files. Findings go in
  `docs/findings/`; durable decisions go in this file.
