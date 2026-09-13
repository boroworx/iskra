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

**Agent** — durable. `id`, `projectId`, `name`, `avatar`, `roleTags[]`, `rolePrompt`,
`providerId`, `model`, `reasoningLevel`, `permissions`, `channelIds[]`, `scratchpadRef`,
`archivedAt?`.

**Channel** — durable. `id`, `projectId`, `name`, `topic`, `pinnedSpecRef`, `wakeDepth`
(messages of history given to an agent on wake, default 30), `memberAgentIds[]`.

**Message** — durable, append-only. `id`, `channelId`, `authorKind` (`human` | `agent` |
`system` | `webhook`), `authorId`, `body`, `mentions[]`, `createdAt`, `runId?`.

**Card** — durable. `id`, `projectId`, `channelId`, `title`, `body`, `tags[]`,
`status` (`triage` | `ready` | `claimed` | `inProgress` | `inReview` | `landed` | `abandoned`),
`assigneeAgentId?`, `worktreePath?`, `branch?`, `createdBy`, `claimedAt?`.

**Run** — ephemeral, but its events are persisted. `id`, `agentId`, `providerId`, `scope`
(`card` | `conversation`), `cardId?`, `channelId?`, `writeAccess` (boolean),
`contextPayloadRef`, `startedAt`, `endedAt?`, `costTokens`.

### Message flag: `addressedToUser`

Run output events carry a boolean `addressedToUser`. False by default — reasoning, tool calls,
file reads, all ambient work. True only when the agent is speaking to a human. The client
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

### Permission model — shape decided by M0.2

`permissions` on the agent and `writeAccess` on the run are placeholders until M0.2 reports.
Constraints the eventual shape must satisfy:

- **Enforced at the adapter boundary**, through the provider's permission/approval path — never
  by instruction in a role prompt. An agent that can talk itself into a write has no permission
  model.
- **Denials are events.** A refused tool call emits a run output event and is visible in the UI.
  Silent denial is a bug.
- **Per-run, not per-agent.** The same agent is read-only in a conversation and writable on a
  claimed card. Permissions resolve at run start from agent config plus run scope.
- **Deny by default.** An unrecognized tool is denied, not allowed.

Express it as whatever the provider path actually supports — a tool allowlist, a capability
set, path scoping — but decide once, in `packages/contracts`, and translate per adapter. **Do
not implement M1.4 before this is settled.**

### New event types (minimum)

`AgentCreated`, `AgentUpdated`, `AgentArchived`, `ChannelCreated`, `ChannelUpdated`,
`MessagePosted`, `AgentMentioned`, `RunStarted`, `RunOutputEmitted`, `RunEnded`,
`ScratchpadWritten`, `CardCreated`, `CardPromoted`, `CardClaimed`, `CardStatusChanged`,
`CardLanded`, `CardAbandoned`.

---

## 5. Invariants

These are the rules the deciders enforce. Each needs a test that fails when the rule is
removed.

1. **No writes without a card.** A run with `scope: conversation` has `writeAccess: false` and
   is denied filesystem writes and destructive commands at the adapter boundary. To write, an
   agent opens a card.
2. **One worktree per card, never per agent.** Created from current main at claim time,
   destroyed on land or abandon. Agents own no workspace.
3. **Agents are silent by default.** A run starts only on an explicit `@mention`, a card
   assignment, or a routed webhook event. A message with no mentions wakes nobody.
4. **One in-progress card per agent**, and a configurable global cap on concurrent runs per
   project.
5. **Agent-created cards enter `triage`.** Only a human promotes `triage → ready`. Agents may
   claim only `ready` cards.
6. **Claims are atomic.** Single writer; a losing claim is rejected and the agent is told.
7. **Landing is serialized.** One merge queue per project, one card landing at a time: rebase
   onto main, run the project verify command in the worktree, merge on green. On conflict or
   failure the card returns to `inProgress` with the failure as context for its agent.
8. **Overlap flagging.** When a card lands, any `inProgress` card whose changed file set
   intersects it is flagged and its agent told to rebase before review.
9. **No agent-to-agent DMs.** Agents communicate in channels or through cards. There is no
   private agent channel.

---

## 6. Milestones

Each task lists its acceptance criteria. A task is done when those are demonstrable, not when
the code looks right. Do not start a milestone before the previous one is accepted.

### M0 — spikes

Answers, not systems. Each produces a written finding in `docs/findings/` and a minimal
reproduction. Do not build product code in M0.

**M0.1 — Mid-turn input delivery.** Interrupt is confirmed present for Claude. The remaining
question is what happens to a _message_ sent while a turn is running: delivered immediately,
queued to the turn boundary, or rejected. Answer for Claude and Codex; note the latency if
queued. _Accept when:_ a provider × behaviour table with a runnable reproduction each, and a
one-line verdict on whether the DM view needs a pending-message state. Do not redesign the DM
view in this task — report.

**M0.2 — Deny write tools through the permission path.** The Claude adapter already returns
deny decisions for pending approvals without prompting. Confirm that the same path can deny
write and destructive tools categorically for a whole session, and determine the Codex
equivalent. _Accept when:_ a session runs in which a write attempt is denied by the harness and
the denial surfaces as an event, plus a written verdict per provider. Invariant 1 is only
enforceable if this works; if it doesn't, say so rather than proposing a prompt-based
substitute.

**M0.3 — Fork bootstrap.** Fork, install, run dev, seed worktree state from a snapshot per the
upstream test-data procedure, confirm what `vp` is. _Accept when:_ server and web run locally
from the fork with seeded data, and `docs/fork-point.md` records the SHA.

### M1 — the core bet

One project, one channel, persistent agents, read-only runs, grey/white DM view. **No cards,
no writes.** This milestone alone must feel better than a terminal; if it doesn't, stop.

**M1.1 — Agent entity.** Contracts, events (`AgentCreated`/`Updated`/`Archived`), decider
rules, projector, persistence. _Accept when:_ an agent can be created and survives a server
restart, with a test asserting the projection matches the event log.

**M1.2 — Channel and messages.** Channel entity, `MessagePosted`, append-only history
projection, `wakeDepth` setting. _Accept when:_ messages persist and paginate; changing
`wakeDepth` changes what a later context build returns.

**M1.3 — Context builder.** A pure function from (agent, channel, pinned spec, wakeDepth,
optional card) to a structured context payload. No IO. _Accept when:_ fully unit-tested,
deterministic for fixed inputs, and returning a structured record — not a concatenated string.

**M1.4 — Read-only run lifecycle.** Spawn a provider session scoped to an agent with
`writeAccess: false`, streaming `RunOutputEmitted` events. **Blocked until the permission model
is settled from M0.2's finding.** _Accept when:_ an agent answers a question about the repo, a
write attempt is denied at the adapter boundary, and the denial appears in the UI as an event.

**M1.5 — Mention routing.** Parse mentions on `MessagePosted`; wake only mentioned agents.
Decider-level, pure. _Accept when:_ a message mentioning one of three agents starts exactly one
run, and an unmentioned message starts none. Test both.

**M1.6 — Server shell UI.** `apps/web`: project sidebar, channel list, member list showing
agents with presence (idle / running / blocked). Reads the projection; no new state.
_Accept when:_ the shell renders live agent state and presence updates without a refresh.

**M1.7 — DM view.** Per-agent conversation view rendering `RunOutputEmitted` with
`addressedToUser: false` as grey and `true` as full white. _Accept when:_ a single run visibly
produces both, and no continuously repainting animation appears in a GPU profile.

**M1.8 — Context inspector.** For any run, show exactly the payload M1.3 produced.
_Accept when:_ the inspector is reachable from the DM view and its content matches the stored
`contextPayloadRef` byte for byte.

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
