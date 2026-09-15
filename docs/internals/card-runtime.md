# Card runtime

The card runtime is where a card's work physically happens: its checkout, ports, services, checks
and git writes. Its one implementation today is the `CardWorkspace` service in
[CardWorkspace.ts](../../apps/server/src/orchestration/CardWorkspace.ts). Read this before adding
a second runtime (a container, a remote machine) or a reactor that touches a worktree.

## The seam is the service, not a new interface

There is no `CardRuntime` interface or rename. `CardWorkspace` is already an Effect service, and
every reactor reaches the runtime only through it, so another runtime is another layer for the
same service. Extract an interface when a second implementation exists, not before.

What a runtime must provide, grouped by who relies on it:

- **Lifecycle:** `ensure` gives a card its own branch, checkout and port block, idempotently, and
  removes everything again if a step fails. Teardown on land or abandon is the runtime's.
- **Snapshots:** `snapshot` is a detached checkout of one commit on its own ports, used by the
  verifier and hidden-scenario commands so they never see or change the builder's worktree.
- **Services:** `ensureServices` and `serviceHealth` keep the project file's services up at the
  worktree's current commit; the watchdog restarts from these alone.
- **Execution:** `runChecks` and `runJourneys` run commands; callers wrap them in
  `HostAdmission.run`, so a runtime never admits its own heavy work.
- **Git:** `diff`, `changedFiles`, `land` and `withCardLock`. Every server-side write to a
  worktree (commit and rebase for review, landing, a revert) runs under the card's lock.
- **Project file:** `projectFile` reads `.iskra/project.json` from the base ref, never the
  worktree, so a builder can't change its own checks.

## Constraints any runtime keeps

- **Agents never write git history outside their worktree.** Merges, reverts and restores are
  server-side. Refs outside the card go through `CardRefGuard`.
- **One writer per worktree.** The owner session edits the checkout. The server writes only under
  `withCardLock`, and only between the owner's turns (review requests and restores need the agent
  stopped).
- **Ports are a block per card** (`ISKRA_PORT` plus the file's offsets). A snapshot gets a separate
  block, so two checkouts of one card can run at once.
- **Heavy work waits for the machine.** Checks, journeys, setup, evidence and holdouts all pass
  through admission with their kind; a runtime that spreads work elsewhere still reports through it.
- **Everything is replayable from events.** A runtime keeps no state the read model can't rebuild:
  worktree path, branch and port base live on the card, and a restart re-ensures services.

## Why no containers yet

The container runtime and twin containers were cut. Cards run as host processes, so the limits in
[card orchestration: sandbox limits](./card-orchestration.md#sandbox-limits) apply: egress allowlists
don't isolate host credential helpers, and digital twins are ordinary processes. A container
runtime would change those limits, not the service's shape.

## Traps

- A reactor that shells out to git in a worktree without `withCardLock` can race `ensure`, `land`
  or teardown. [CardReversibilityReactor.ts](../../apps/server/src/orchestration/CardReversibilityReactor.ts)
  reverts under the lock for this reason.
- A revert card has no agent. Its worktree comes from `ensure` like any other card's, and assigning
  an agent later turns it into an ordinary card on that same worktree.
- Release a snapshot when its user finishes. Its ports stay reserved until you do.
