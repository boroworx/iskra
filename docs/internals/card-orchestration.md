# Card orchestration

Decisions and traps behind cards running on their own. The user-facing flow is in
[channels, agents, and the board](../user/channels-agents-board.md); the acceptance tests that
drive it end to end are [cardFlow.integration.test.ts](../../apps/server/integration/cardFlow.integration.test.ts)
and, for verifiers, hidden scenarios and agent instances,
[cardVerifier.integration.test.ts](../../apps/server/integration/cardVerifier.integration.test.ts),
and for plans, migrations, triggers, budgets, knowledge, outcomes and reverts,
[cardFactory.integration.test.ts](../../apps/server/integration/cardFactory.integration.test.ts).

## Where policy lives

The decider sees only the command and the read model, so where a setting lives decides who can
enforce it.

| Class              | Where                                                                                                                   | Holds                                                                                                             | Why there                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Authority       | `OrchestrationProject.orchestration`, changed only by a person's `project.orchestration.set`                            | base branch, caps, landing, fix rounds, checks waiver, egress, exclusive paths, side-effect guard, heavy commands | Anything that widens what agents may do, or needs an audit trail, must be decider-readable and evented. No board tool or reactor sends it.                                    |
| B. Build knowledge | `.iskra/project.json`, read from `origin/<base>` ([ProjectFile.ts](../../apps/server/src/orchestration/ProjectFile.ts)) | checks, ports, services, env files, resource hints                                                                | Versioned and reviewed with the code. It is never read from a card's worktree, so a builder editing it changes nothing until a person merges it, and it can't grant anything. |
| C. Machine         | server settings `cardRuntime` and `ServerSecretStore`                                                                   | heavy-job concurrency, admission thresholds, environment session cap, resource profile, secrets                   | Differs per laptop. Enforced by reactors, not the decider.                                                                                                                    |

Consequences:

- `exclusivePaths` is class A, so a builder can't turn off its own landing serialization.
- The decider can't see the environment session cap. It refuses a channel wake only at a project's
  `sessionCap`; [RunReactor.ts](../../apps/server/src/orchestration/RunReactor.ts) keeps a wake past
  the machine's cap pending until a session ends (or the minute tick), and the scheduler enforces
  both for cards.

## Slots

A live run holds a slot unless its session is idle: ready with no active turn
([wakeRouting.ts](../../apps/server/src/orchestration/wakeRouting.ts) `holdsSlot`). A run with no
session yet counts, because it was just recorded. [cardQueue.ts](../../apps/server/src/orchestration/cardQueue.ts)
stops idle owners of cards in review or landing, and owners that have waited on a person's answer
for 10 minutes. A card that comes back to work restarts from its worklog, so stopping an idle owner
loses nothing.

The scheduler only picks cards. `card.session.start` re-checks every gate in the decider (plan
gate, one writer, pause, side-effect guard, project cap). Its in-flight and backoff state is in
memory, and a restart simply plans again.

## Agent instances

Every wake is its own run of the agent (`decideWake` in [wakeRouting.ts](../../apps/server/src/orchestration/wakeRouting.ts)):
a message joins the agent's live run only in the same channel or DM, and anywhere else starts another
instance. This replaced M1's one live context per agent, which refused wakes from a second channel and
queued DMs, so an agent at work in one place was unreachable everywhere else. Nothing is keyed on the
agent id alone: each run has its own thread credential, and tools bind to the run.

With no per-agent limit, the machine's session cap is what bounds concurrent runs. The wait is in
memory and said once in the channel; after a restart the still-pending messages wake the agent on the
next message or run end. `queued` deliveries from before instances are woken at startup, and the
status stays in the contract only so old events decode.

## Verifier

When a project's verifier is on, or the builder's blueprint always verifies, a card entering review
is checked by a second agent before approveMerge, plan-child landing or auto-merge can pass
(`verificationRefusal` in [cardRules.ts](../../apps/server/src/orchestration/cardRules.ts)). Verdicts
are pinned to the commit under review; a verdict for an older commit is refused.

Selection order ([verifierSelection.ts](../../apps/server/src/orchestration/verifierSelection.ts)):
the builder template's `verifyWith`, then a verifier-role agent on a different provider that is ready
and can enforce a verifier run (OpenCode first), then the builder's template on another model of its
provider, then the builder's own model. Codex is never chosen. Each step records its reason code, so
review can say why this verifier is the one checking.

Independence is structural, not a prompt:

- The verifier works in a detached snapshot worktree at the commit, with its own port block and
  services ([CardWorkspace.ts](../../apps/server/src/orchestration/CardWorkspace.ts) `snapshot`). It
  can't move the card's branch, and the builder's running services never answer for it.
- The brief ([verifierBrief.ts](../../apps/server/src/orchestration/verifierBrief.ts)) carries the
  criteria, spec, evidence, diff and hidden scenarios, never the owner's decisions, plan, messages,
  critiques, transcript or risk claims.
- A verifier run reads. A verifier-role template may add a shell, which its provider must then
  enforce, so an OpenCode verifier never gets one.

A verifier that ends without a verdict is started once more, then the card asks a person. Rerun is
refused only while a live verifier run exists, and selection never refuses a running verification, so
a verifier that died can't lock its card.

## Hidden scenarios

Scenarios live in one file per project under the server's state directory
([HoldoutStore.ts](../../apps/server/src/orchestration/HoldoutStore.ts), mode 0600), never in the
repository, where any builder could read them, and never as events, which reach every client. People
edit them over write-scoped RPCs; the list returns titles only. Command scenarios run on the server in
the verifier's snapshot, through admission, with only `PATH`, `HOME` and the snapshot's ports.

What keeps them from the builder:

- Builders can't read the store: Claude runs deny reads of the Iskra home, OpenCode runs deny
  `external_directory` and have no shell, and Codex runs are refused.
- A failed verdict reaches the builder as criterion notes and a count of failed scenarios. Notes and
  concerns pass through `redactHoldouts` before they are recorded, which catches quotes but not a
  paraphrase.
- The verifier run's stored context shows `[hidden scenario <id>]` in place of each scenario, because
  the context inspector renders stored contexts. Verdict rows keep scenario ids only.

The honest limit: the scenario text does reach the local event log, in the verifier's own hidden
thread. Its first `thread.turn.start` is the provider input, so the thread's user message stores the
full brief, and a person opening that thread sees it (people wrote the scenarios). Anyone who can read
the environment's database can read them. Keeping the turn input out of band would close this; it is
not done. The acceptance test pins exactly this boundary: every other event, card activity, stream
item and verdict row is checked clean.

## Evidence is pinned to a commit

`card.review.enter {headSha}` is refused unless the card's latest evidence is for review, passed, and
was captured on that same `headSha` (`reviewEntryRefusal` in [cardRules.ts](../../apps/server/src/orchestration/cardRules.ts)).
The review gate records evidence and then enters review. Any commit after capture needs new evidence.
CI results replace pending CI items under the id `evidence-ci-<cardId>-<sha>`.

An agent's risk claims are parsed from its review request text and shown as claims. They never count
as evidence.

## Heavy jobs

[HostAdmission.ts](../../apps/server/src/orchestration/HostAdmission.ts) is one queue for the whole
environment: server-run checks, `run_checks`, evidence capture, setup, and landing checks. Per-card
locks in `CardWorkspace` guard worktree mutation only.

- **Wrap `CardWorkspace.runChecks` in `HostAdmission.run` exactly once.** `runChecks` doesn't take a
  slot itself, and `land` wraps its own call. A nested wrap deadlocks at the default concurrency of 1.
- The queue has no table. `run_checks` requests without a result are queued again at startup
  (`CardReviewReactor` `resumeRunChecks`).
- Cancelling for memory pressure interrupts the job and requeues it. Only processes Iskra spawned
  are killed.

## Sandbox limits

- `ProviderService` refuses a run before its adapter starts when the provider can't enforce the run's
  limits (`runRefusal` in [runEnforcement.ts](../../apps/server/src/provider/runEnforcement.ts));
  providers not in the table are refused. The client copy in
  [runEnforcementView.ts](../../packages/client-runtime/src/runEnforcementView.ts) must say the same.

  | Provider | Runs                                                             | Why                                                                                                                                                                                                                                                                                                                                                              |
  | -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Claude   | read, write, shell, network, with the project's egress allowlist | OS sandbox plus permission rules. See [m1-claude-run-enforcement.md](../findings/m1-claude-run-enforcement.md).                                                                                                                                                                                                                                                  |
  | OpenCode | read, and read with write                                        | No OS sandbox, so a shell or network can't be confined. Each run gets its own `opencode serve` with a temporary config home, project config disabled, deny-by-default permission rules, only Iskra's MCP server, asks auto-rejected, no resume; an external server is refused. See [m2-opencode-run-enforcement.md](../findings/m2-opencode-run-enforcement.md). |
  | Codex    | none                                                             | The sandbox and home are built but refused until the gated real-binary test passes on a machine with Codex. See [m2-codex-run-enforcement.md](../findings/m2-codex-run-enforcement.md).                                                                                                                                                                          |

- OpenCode resolves a session's directory to its real path. A worktree reached through a symlink
  (macOS `/var` is `/private/var`) reads as external, and the run is denied its own files. It fails
  closed; give card worktrees real paths.
- The Claude sandbox refuses writes under `~/.claude`. A card worktree below it gets a read-only
  shell, so run a dev server with an Iskra home outside `~/.claude`. Tests make their repositories
  in the OS temp dir.
- A card's shell can write the repository's shared `.git`, including other branches' refs. The
  sandbox can't prevent that without also blocking the card's own commits: a directory deny beats
  the allow, and literal denies miss new refs. [CardRefGuard.ts](../../apps/server/src/orchestration/CardRefGuard.ts)
  is therefore detection, not prevention. It snapshots `refs/heads` and `refs/tags` per turn, then
  reports changes and pauses the card, and a person restores (compare-and-swap) or keeps them.
  Iskra's own ref writes go through `serverRefWrite` so they are never reported. The snapshots are
  in memory: a restart mid-turn leaves that turn unchecked, and a restart between the decision and
  the git write loses the restore. The report keeps full ids for manual recovery.
- Heavy-command denial matches command patterns, so `sh -c` or `npx` wrappers can slip through. The
  throttled resource environment is the backstop.

## Plans and their coordinator

A plan card's session is a coordinator: a read-only run with no worktree, briefed on its plan
([coordinatorBrief.ts](../../apps/server/src/orchestration/coordinatorBrief.ts)). Its tools
([coordinator toolkit](../../apps/server/src/mcp/toolkits/coordinator/handlers.ts)) take the plan
card and agent from the run behind the thread credential, never from tool input, and resolve a
child key only under that plan. The question and lesson tools are named `ask_plan_owner` and
`propose_plan_lesson` because every toolkit registers on one MCP server, where a second tool with the
same name replaces the first.

Authority stays with people:

- `card.plan.approve` is a client command; no tool dispatches it. It names the revision it read, and a
  new proposal replaces the revision, so a person can't approve a plan they didn't see.
- Approval creates every child in one batch: ready, criteria confirmed, `blockedBy` from `dependsOn`,
  and held for its slice checkpoint past the current slice. A suggested agent without the builder role
  refuses the approval; an unknown one leaves the child for a person to assign.
- Children land into the plan's integration branch (`planChild`), which checks, evidence and the
  verifier gate as usual. Only the plan opens a pull request, against the base, and a person merges
  it. Plan and migration checkpoints skip the checkpoint blueprint, which would rebase the pushed
  integration branch.
- A child spends from its plan's budget (`budgetCardOf`): its turns are charged to the plan card, so
  the plan's cap sees what its children cost.

## Migrations

A migration lists its items with its enumerate command in a snapshot of its own branch, through
admission, one item per output line. It samples three, spread across the list, and asks a person to
tune once they reached review; a redirect note replaces the instructions later children get. The sweep
starts items while running ones stay under `max(1, sessionCap ?? machine cap)`, in as many batches as
that takes. Items land into the migration's branch like plan children (`planChild`), with no person's
approval; only the migration's pull request waits for one.

- A migration is capped at 1000 items: it is one card, its shell carries the item list, and all of it
  lands through one pull request. A longer listing pauses the migration with the refusal.
- An item whose child is abandoned or paused for a person (fix rounds exhausted, start or session
  failed) is blocked, and the sweep goes on. The paused child is still an open sub-card, so merging
  the migration waits until a person lands or drops it.

## Triggers

Triggers turn the outside into cards, so everything a person decides lives in the trigger (class A),
and the outside only ever supplies text ([triggerRules.ts](../../apps/server/src/orchestration/triggerRules.ts)):

- A pull request comment counts only from a repository collaborator (write, maintain or admin; the gh
  viewer without a host permission API), the same rule as comments on card pull requests. Anyone else
  gets a refused fire with the reason on the project; nothing is written back to the host.
- The outside text lands in the spec only, inside a backtick fence longer than any backtick run in it
  and labelled untrusted. Title, criteria, agent, intake and budget come from the template.
- Only a schedule trigger with fixed criteria may create ready work. Such a card is unattended: its
  pull request opens as a draft, and auto-merge refuses trigger and unattended work.
- A fire's command and card id are `trigger:<projectId>:<triggerId>:<sourceKey>` (a run id, a
  comment id, a scheduled minute), so reading the same source again is an engine receipt no-op. No
  duplicate event is ever recorded. A schedule fires this minute and the one before, so a tick that
  drifts past a boundary still fires once.
- What was already read is in memory: runs and comments from before a start, or while the server was
  down, never fire.

## Budgets

Every run's turns are spend: card runs on the card that holds the budget (`budgetCardOf`: attempts,
sub-cards and plan or migration children spend from their parent), conversation and lead runs on the
channel's project. Monthly totals are per calendar month; a past month reads as zero, and the decider
takes "now" from the command's `createdAt`.

Where a cap holds:

| Point                         | At                              | What happens                                                                |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `decideWake`                  | project or agent cap            | the wake is refused and the refusal is said in the channel                  |
| scheduler                     | any cap, the machine's included | the card waits with `budgetCap`, `agentBudgetCap` or `environmentBudgetCap` |
| run and card session reactors | 100%                            | no follow-up turn starts; messages wait                                     |
| watchdog                      | 120%                            | running turns are interrupted and their cards paused with `budgetBreaker`   |

The machine's monthly budget is class C: the decider can't see it, so a wake past it waits instead of
being refused, and raising it has no event (held messages go out on the next card or project event).
Budgets have no agent tools.

## Auto-merge

Off by default. A card lands without a person only when, in order: auto-merge is on; the work
wasn't started by a trigger or unattended; its review evidence passed; a verifier passed the commit
under review with at least one hidden scenario (an override never counts); and the scenarios
satisfied reach `minSatisfaction`. Unacknowledged hard flags refuse it like any merge. Auto-merge can't
be on while the verifier is off, which also keeps the verifier from being turned off under it. The
server merges; no agent can.

## Outcomes

Outcomes label finished cards and never move one ([outcomeRules.ts](../../apps/server/src/orchestration/outcomeRules.ts)):
blocked at once when a card was abandoned after running out of rounds or failing to start; flawed as
soon as, within seven days, a revert card for it lands, a `This reverts commit <sha>` commit reaches
the base, or a CI failure fire on a descendant commit names a file it changed; manual at seven days
when a person merged it on the host or another author committed to its branch; success otherwise.
A flawed card asks a person for a hidden scenario. A person's outcome is never replaced.

The signals are heuristics, and known to miss: foreign commits are read once at review entry, only
the project's last 20 fires are consulted, a pull request merge's commit is origin's base tip right
after the merge, and a fix a person made later is not seen.

## Reverts and restores

Both are client commands; agents have neither. A revert creates a new card in progress with no
agent, so the scheduler never starts one. The server reverts the landed commit in that card's
worktree under the card lock (`-m 1` for a merge commit), runs the checks and journeys, records the
evidence and enters review, where a person merges it like any card. A conflict or failing check stops
there and asks a person to assign an agent; from then on it is an ordinary card and the reactor leaves
it alone. A restore needs the card paused with no turn running, and goes through the latest owner
thread's `thread.checkpoint.revert`.

## Traps for agents working on this code

- `vp` output is colored with ANSI escapes, so `grep "error TS"` over a typecheck log matches
  nothing. Judge a typecheck by its exit code, or strip the escapes first.
- Reactor tests share one engine per `it.layer`. Command ids must be unique per dispatch:
  a repeated id replays its receipt, and the second event never happens.
- The same holds in reactors: ids derived from only a card and a commit replay on a second pass at that
  commit. Verifier runs are keyed on the event that asked for them, so a rerun starts a new run.
