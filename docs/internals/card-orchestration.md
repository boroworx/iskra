# Card orchestration

Decisions and traps behind cards running on their own. The user-facing flow is in
[channels, agents, and the board](../user/channels-agents-board.md); the acceptance test that
drives it end to end is [cardFlow.integration.test.ts](../../apps/server/integration/cardFlow.integration.test.ts).

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
- The decider can't see the environment session cap. Channel wakes honor only a project's
  `sessionCap`, while the scheduler enforces both.

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

- Only Claude runs card sessions in M1; `ProviderService` refuses providers that can't enforce the
  run's limits. See [m1-claude-run-enforcement.md](../findings/m1-claude-run-enforcement.md).
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

## Traps for agents working on this code

- `vp` output is colored with ANSI escapes, so `grep "error TS"` over a typecheck log matches
  nothing. Judge a typecheck by its exit code, or strip the escapes first.
- Reactor tests share one engine per `it.layer`. Command ids must be unique per dispatch:
  a repeated id replays its receipt, and the second event never happens.
