# Iskra

_Local-first, Discord-shaped orchestrator for AI coding agents._

---

## One-liner

You open a local project and it looks like a Discord server. Agents are users. Channels group
them by concern. Work is a board of features, each on its own branch with one agent writing it,
and one list tells you everything that is waiting on you. Everything runs on your machine; you
pay only for the agent subscriptions you already have.

---

## Positioning

The reference point is T3 Code: a local Node server that wraps provider CLIs (Claude Code,
Codex, Cursor, Grok, OpenCode), normalizes their event streams, and serves web, desktop and
mobile clients. Thread per task, worktree per thread, inline diff, one-click PR. MIT, ~200k
users, large contributor base, forks explicitly encouraged.

**The harness layer is solved and permissively licensed.** Process supervision, event-stream
normalization across five providers, worktree lifecycle, diff rendering — months of grinding
work that already exists. Reuse it.

**The layout is not the moat.** Free + BYO-subscription is table stakes in this category. A
sidebar reskin gets copied in a week by a project with 114 contributors. The delta is the data
model underneath.

### The delta

|              | T3 Code                 | Iskra                                      |
| ------------ | ----------------------- | ------------------------------------------ |
| Unit         | Thread = task           | Agent = entity, card = feature, run = session |
| Lifetime     | Disposable, isolated    | Durable identity, disposable context       |
| Coordination | None                    | Channels + derived board + merge queue + Linear |
| Memory       | In the thread           | In the channel, the feature record and reviewed repo knowledge |
| Audience     | Single player by design | Multiplayer by design                      |

---

## Data model

Five entities. Getting these boundaries right is the whole architecture.

**Project** — a git repo plus its Iskra server. One sidebar entry. Owns everything below.

**Channel** — a context partition with durable history and a pinned, agent-writable spec. Not
a branch. `#backend` agents don't read `#design` history. Channel history is the long-term
memory of the project.

**Agent** — durable identity, defined as a file in the repo (`.iskra/agents/<name>.md`, close to
Claude Code's subagent format, so existing `.claude/agents` definitions import): name, avatar,
role prompt, model and reasoning level, permissions, tags. Versioned and reviewable like code. The
server keeps what a file can't: presence and a track record — spend, features landed, how often
review sent its work back, how often it needed you. **Owns no worktree.**

**Card** — the unit of work, shown as a **feature**. Owns a worktree and a branch for its
lifetime. One accountable human and one writing agent at a time; many sessions over time sharing
the card's spec and decision log; any number of read-only helpers; sub-cards and best-of-N
attempts for parallel writing. Status: `triage → ready → in progress → in review → landing →
landed | abandoned`, derived from what happened rather than set by hand.

**Run** — one CLI session. Belongs to an agent, scoped to either a card or a conversation.
Ephemeral, disposable, reconstructed from scratch on every wake. This is what actually maps
onto a Claude Code or Codex session.

### The core rule: features code, channels talk

A channel message spawns a **read-only run**: the agent reads the repo, reasons and answers,
but cannot write. Writing happens on a **feature**: its own branch and worktree, one writing
agent at a time, the full controls of a coding thread. An agent's DM writes nothing: it is a
window onto every session that agent is running.

This resolves several things at once:

- A room full of agents can never write over each other: channels only talk.
- Many features in parallel never collide: each has its own worktree and exactly one writer.
- Long-lived agent branches can't drift, because feature branches are task-scoped and short.
- "Spin this into a feature" stays the central gesture for work that needs coordinating.

### Context reconstruction

Provider CLIs are session-per-task. A "persistent agent" is a fiction maintained by rebuilding
context on every wake, from:

- role prompt
- the repo's reviewed knowledge (AGENTS.md), and the agent's scratchpad only if the M3
  experiment keeps it
- the channel's pinned spec
- the last N messages of the channel (N configurable per channel)
- the feature's spec, decision log and diff, if the session is on a feature

This assembly is the core engineering problem of Iskra, not a design nicety. It should be one
function, and **the UI should show exactly what an agent was handed on any given wake.**
Nothing else in the category does this, and it's the difference between debugging an agent and
guessing at it.

Cost consequence: every wake re-reads context. A chatty channel is expensive. Wake depth per
channel is therefore a real, user-facing cost dial.

### What survives a reset

Identity is durable, context is disposable. Auto-compaction is inherited from the underlying
CLI — not built.

Where durable knowledge lives:

1. **Reviewed repo knowledge.** Agents propose edits to AGENTS.md — conventions, corrections
   they keep receiving, decisions and rationale — as items you approve. Shared by every agent,
   versioned in git. This is where the rest of the category keeps memory too (Devin Knowledge,
   Codex skills, Cursor rules), because per-agent memory drifts and is hard to inspect.
2. **Channel and feature records.** Channel history persists forever, as in real Discord, and a
   feature's spec and decision log carry it across sessions and owners. Compaction stops being a
   loss because the durable record was never in the context window.
3. **Per-agent scratchpad — an experiment.** A small file the agent writes and you can edit.
   Kept only if agents with one measurably beat fresh sessions given the same spec; otherwise an
   agent is a named, permissioned preset with a track record, and that is enough.

---

## The DM view

The strongest interaction idea in the concept.

A DM is where you see exactly what an agent is doing. It lists every session the agent is
running — the feature it owns, a review it's helping with, a question in a channel — each
labelled, each with the exact context it was handed, and you can write into any of them. The DM
never has a session of its own and never writes code: work happens on features.

Open a DM with an agent and you see all of its work — reasoning, tool calls, file reads —
rendered in **grey**. When it wants you specifically, it tags you, and that message renders in
**full white**.

Agent work today is either invisible (a spinner) or a firehose (raw terminal). This is a
typographic protocol that makes reading over an agent's shoulder cheap and makes "this needs
you" unmissable, in one visual grammar.

The same idea generalizes: _blocked, needs you_ is a first-class status everywhere, not a
buried log line.

**Verified, with one caveat.** Stopping a running agent works: the Claude adapter interrupts
the SDK stream fiber and normalizes the result into a completed-interrupted turn. Agents
speaking unprompted also already works — the adapter creates a synthetic turn when output
arrives outside a user turn, which is exactly the wake-up-and-tag-you case.

The caveat is timing. A message sent mid-turn isn't delivered immediately; the agent reads it
at the next natural break, measured at 4 to 19 seconds with no upper bound. So barge-in is real
but asynchronous, and the DM view has to show a pending state rather than claiming the message
landed. There's also a path where a message attaches to a turn that ends without reading it —
which must be re-delivered or surfaced, never silently dropped.

---

## Board and landing

A per-project board of features, and the project's home page.

**Why it matters structurally:** agents coordinate through state, not conversation. A card
with an owner and a status is unambiguous in a way six agents talking never is. Most serious
orchestrators converged here independently, pulling work from GitHub Issues or Linear.

**Columns are derived, not dragged.** A card moves because something happened: a session
started, review was requested, the queue merged it. A human drags only to decide: approve a
proposal, assign an agent, approve a merge. The board therefore never disagrees with the code.

**Needs you.** The scarce resource with many agents is your attention. One list across projects
holds everything waiting on you — approvals, questions, specs, reviews, exhausted fixes, budgets,
conflicts — and can be snoozed until something new happens.

**Guardrails built into the flow.** A feature needs an approved plan before any code is written
(a cheap critic reviews it first; small fixes can skip). Review runs the project's checks and
sends failures back to the agent a few times before asking you. Every feature has a spend cap.
Best-of-N attempts run several agents on the same spec and keep the best diff.

**Linear, both ways.** Linear now runs coding agents on issues itself, so Iskra does not rebuild
a tracker: issues flow in as proposals or delegated work, features flow out as issues, and the
agent's questions can be answered from either side. Iskra owns the status, because only Iskra
knows what actually happened in the worktree.

### Auto-claim, with guardrails

Agents get notified on new cards and grab ones matching their role.

- **Cost.** "Every agent evaluates every card" is N inference calls per card. Match
  deterministically — tags on cards, tags on agents — or let one cheap router model assign and
  consult nobody else.
- **Races.** Two agents will claim the same card. Atomic claim, single writer, optimistic
  lock, loser backs off. Cheap if designed for, nasty otherwise.
- **Runaway loops.** Agents creating _and_ claiming cards is a machine that generates and
  executes its own work overnight with your card attached. Agent-created cards land in
  `triage`, which only a human can promote to `ready`. Hard limits: N concurrent sessions per
  project and a spend cap per feature.

### Landing (the part every parallel agent system dies on)

Claiming is easy. Landing is where N branches against one main goes wrong.

- Each card branches from its base (main, or its parent feature's branch) when work starts.
- `in review` runs the project's checks, then presents the diff. Approving the merge is one click.
- Landing is serialized through a **single merge queue per project**. One card lands at a
  time: rebase onto main, run the project's verify command (build/test/lint) inside the
  worktree, merge on green.
- On rebase conflict or verify failure, the card returns to `in progress` with the conflict as
  new context for its agent. The agent fixes its own merge.
- When a card lands, any in-progress card whose changed files overlap gets flagged
  (`git diff --name-only` is enough) and its agent is told to rebase before review.

Boring and serial, on purpose. Parallelism belongs in the work, not the merge.

---

## Discord mechanics worth adopting

**Roles as literal permissions.** Discord's per-role, per-channel model maps directly onto repo
write access, push rights, destructive commands, migration access. Needed anyway; here it's
legible as a server setting rather than a config file.

**Reactions as feedback.** Approving a diff, rejecting a plan, "continue" — one click, no
sentence. Better fit for supervised mode than a modal.

**Forked attempts.** A Discord thread branches off a message; a worktree branches off a commit.
Three attempts on one feature = three branches, three diffs side by side, keep one. Parallel
attempts are the real superpower of agent work; they ship with the board in M2.

**Webhooks into channels.** Point Sentry, CI and Railway at `#alerts` and the agents in it have
a live event feed with no ingestion layer to build. An agent that wakes because a deploy
failed, reads the trace, opens a triage card and tags you is a categorically different product
from a GUI over Claude Code.

**Mention-only notifications.** The only push you get is an agent blocking on you. With the
mobile client: kick off work from bed, get pinged for decisions.

---

## Explicitly out of scope

**Free-flowing agent chatter.** Six agents in a channel means six inference calls per message,
each deciding whether to speak. Result: silence, six near-identical replies, or an agreement
spiral. **Agents are silent by default and wake only on `@mention` or explicit routing.**

**Agent-to-agent DMs.** Where coordination goes to die — invisible token burn, no audit trail,
failures surface three steps downstream. Agents talk in channels or through cards.

**Manager agent.** An agent that directs other agents or merges their work degrades past small
N and breaks one writer per branch. The channel lead is not that: it only turns a request into
proposed features, which you approve. You stay the orchestrator; the board and Needs you make
that cheap.

**Hosted compute.** See below.

---

## Sync, hosting, and revenue

Three things get bundled as "cloud."

**Remote access.** Already solved — the control plane serves web, desktop and mobile, and
Tailscale covers the rest. Selling a managed tunnel is selling ngrok.

**Hosted compute.** Real value, different company: renting sandboxes, holding repo credentials
and secrets, per-tenant isolation, egress. Thin margins, heavy ops, direct competition with the
model providers' own cloud agent products on their cost structure. It also destroys the
"entirely local" positioning, which is currently the clearest thing about Iskra.

**State sync.** Fits. The durable layer — channel history, board, agent records and definitions —
is all small text. Repos, worktrees and containers are local by definition and never sync.
Cheap to build and run, which is good, but also hard to charge for.

### Sell multiplayer, not hosting

The gap in this category is teams. T3 Code is explicitly single-player: seats, SSO, audit
trails and spend caps are stated as outside the product, not unshipped features. Iskra is the
one app whose metaphor is multiplayer by default — Discord is a room with people in it, not a
personal tool with sharing bolted on. Two humans and six agents in one server, roles spanning
both, a shared board, and a record of who approved which diff, is a coherent product nothing
else is shaped right to become.

- **Free, local, open:** single human, unlimited agents, fully offline forever.
- **Paid:** coordination server — multiple humans, shared agent fleet, shared board and
  history, roles across people and agents, org-wide spend caps, cost attribution by project
  and agent. Self-hostable, or users will fork it.

Nobody pays to sync their own state between their own two machines. Teams pay for shared state
and an audit trail.

**Act on now, not later:** keep durable state (history, board, agent records, configs) as a
small, clean, serializable layer with a hard boundary against local execution state. Sharp
boundary from day one keeps every model available. Smeared through the app, none are.

---

## Reuse strategy — decided

**Hard fork of `pingdotgg/t3code`, no upstream tracking.**

The deciding factor is that upstream is event-sourced: commands → pure decider → persisted
events → projector → read model. A Discord-shaped UI is a _different projection over the same
log_, and Iskra's rules (claiming, merge ordering, mention routing, permissions) are decider
logic — pure and testable without touching a provider or the filesystem. That makes the fork
additive rather than surgical, which removes the usual argument for vendoring pieces instead.

Effect-TS is kept as the server style. Web is the only client surface through M3; desktop
wraps web for free, mobile is deferred.

Implementation details live in `docs/iskra/iskra-spec.md`.

---

## Build order

**M0 — answered for Claude.** Writes can be blocked by the harness, so the
no-writes-without-a-card rule is enforceable rather than advisory — the central structural bet
holds. Mid-turn messages arrive at the next natural break rather than instantly. Codex verdicts
were read from code, not run, so M1 targets Claude only.

**M1 — the core bet.** One project, one channel, 2–3 agents as persistent entities, mention
routing, read-only runs, grey/white DM view, context-builder inspector. No cards, no writes.
This alone should feel better than a terminal. If it doesn't, stop.

**M2 — the board.** Features with worktrees and derived status, the plan gate, the review loop,
the serialized merge queue with overlap flagging, Needs you, budgets, best-of-N attempts,
board tools for agents, two-way Linear sync, and the channel lead proposing features.

**M3 — memory.** Reviewed knowledge proposals, a measured per-agent scratchpad experiment, pinned
specs, per-channel wake depth, cost reporting across projects.

**M4 — server furniture.** Roles and permissions, webhooks and scheduled triggers into triage,
auto-claim with guardrails.

**M5 — multiplayer.** Second human, shared board, audit trail, spend caps.

---

## Success tests

- **M1:** two weeks of real use on a live project without opening a terminal for agent work.
- **M2:** a card goes from creation to landed on main without manual git.
- **External:** someone who isn't the author installs it, uses it twice, and comes back.

"Feels better than a terminal" is not a test. Terminal-open count is.

---

## Open risks

1. **Does a persistent agent beat a fresh session?** Long-lived context is where agents rot. If
   a three-week-old backend agent is worse than a clean one given a good spec, the model
   collapses back to threads with avatars. Most orchestrators have no persistent agents at all
   and keep knowledge in the repo. Iskra's hedge is that an agent is still useful as a named,
   permissioned preset with a track record, and the per-agent record is how the scratchpad
   experiment gets measured rather than assumed.
2. **Is the Discord framing load-bearing?** Load-bearing version: roles are permissions, cards
   are merge slots, channels are context scopes. Skin version loses to whoever ships a better
   diff view.
3. **Distribution is the biggest risk and the least addressed.** The incumbent has 200k users
   and a founder with an audience. "Developers running multiple agents" is not a wedge.
   Plausible angles: be the thing people fork; the DM view is inherently demoable in a
   15-second clip; teams are an underserved segment nobody in the category serves.
4. **Cost legibility.** Nobody answers "what did agent work cost this month, by project." Wake
   depth, per-feature budgets and per-channel caps are a differentiator hiding in plain sight.
5. **Linear moved into the space.** Since 2026 Linear runs Claude Code and Codex sessions on
   issues, reviews their diffs and schedules agent jobs. Iskra's answer is what an issue tracker
   cannot be: local, any provider, worktrees that actually run the app, and live rooms — synced
   with Linear rather than competing with it as a tracker.
