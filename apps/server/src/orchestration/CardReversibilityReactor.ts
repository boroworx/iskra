import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  type CardActivity,
  type CardEvidenceItem,
  type CardId,
  type OrchestrationEvent,
  type Reason,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionRunLivenessRepositoryLive } from "../persistence/Layers/ProjectionRunLiveness.ts";
import { ProjectionRunLivenessRepository } from "../persistence/Services/ProjectionRunLiveness.ts";
import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import { inspectChanges, judgeScope } from "./CardEvidence.ts";
import { landsByPullRequest, PENDING_CI_CODE } from "./cardRules.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Reversibility. A person's revert makes a card no agent works on: the server gives it a worktree
 * from the base, reverts the landed commit there, runs the project's checks and journeys, records
 * the evidence and moves it into review. A conflict (or failing checks) stops there and asks a
 * person to assign an agent, which makes it an ordinary card. A person's restore puts the card's
 * worktree back through the owner thread's checkpoints and tells the builder.
 */
export class CardReversibilityReactor extends Context.Service<
  CardReversibilityReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardReversibilityReactor") {}

type ReversibilityJob =
  | { readonly kind: "revert"; readonly cardId: CardId; readonly landedSha: string; readonly key: string }
  | { readonly kind: "restore"; readonly cardId: CardId; readonly turnCount: number; readonly key: string };

/** The reason code a revert that needs a person is raised with; its attention offers assignAgent. */
export const REVERT_CONFLICT_CODE = "revertConflict";
export const CHECKPOINT_RESTORED_CODE = "checkpointRestored";

const EPOCH = "1970-01-01T00:00:00.000Z";

/** The reactor without its run liveness repository, which `layer` provides. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const admission = yield* HostAdmission.HostAdmission;
  const liveness = yield* ProjectionRunLivenessRepository;
  const runner = yield* ProcessRunner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", cwd, ...args], timeout: "5 minutes" });

  const record = (
    cardId: CardId,
    activityId: string,
    entry: Pick<CardActivity, "body" | "deliverTo"> & { readonly reason: Reason },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-reversibility-activity:${activityId}`),
        activityId,
        cardId,
        kind: "message",
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        runThreadId: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        createdAt: yield* nowIso,
        ...entry,
      });
    });

  const needsPerson = (cardId: CardId, key: string, body: string) =>
    record(cardId, `revert-needs-person:${key}`, {
      body,
      deliverTo: null,
      reason: { code: REVERT_CONFLICT_CODE, text: body.split("\n")[0]!.slice(0, 200) },
    });

  const revert = Effect.fn("CardReversibilityReactor.revert")(function* (
    job: Extract<ReversibilityJob, { kind: "revert" }>,
  ) {
    const model = yield* snapshotQuery.getCommandReadModel();
    const card = model.cards?.find((candidate) => candidate.id === job.cardId);
    const project = model.projects.find((candidate) => candidate.id === card?.projectId);
    // Only the untouched revert card: once an agent is assigned or evidence exists, it isn't ours.
    if (
      card === undefined ||
      project === undefined ||
      card.status !== "inProgress" ||
      card.delegateAgentId !== null ||
      card.evidence !== null
    ) {
      return;
    }
    const { worktreePath } = yield* workspace.ensure(card.id);
    const short = job.landedSha.slice(0, 7);

    const conflict = yield* workspace.withCardLock(
      card.id,
      Effect.gen(function* () {
        // A restart may have reverted already; the commit message says so.
        const head = yield* git(worktreePath, ["log", "-1", "--format=%B"]);
        if (head.stdout.includes(`This reverts commit ${job.landedSha}`)) return null;
        const parents = (yield* git(worktreePath, ["rev-list", "--parents", "-n", "1", job.landedSha])).stdout
          .trim()
          .split(/\s+/).length;
        // A merge commit reverts against its first parent, the base it was merged into.
        const reverted = yield* git(worktreePath, [
          "revert",
          "--no-edit",
          ...(parents > 2 ? ["-m", "1"] : []),
          job.landedSha,
        ]);
        if (reverted.code === 0) return null;
        const files = (yield* git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])).stdout
          .split("\n")
          .filter((line) => line.trim().length > 0);
        yield* git(worktreePath, ["revert", "--abort"]);
        return files.length > 0 ? files.join(", ") : reverted.stderr.trim().split("\n")[0] || "the worktree";
      }),
    );
    if (conflict !== null) {
      return yield* needsPerson(
        card.id,
        job.key,
        `Reverting ${short} conflicts in ${conflict}. Assign an agent to finish the revert.`,
      );
    }

    // The review blueprint's evidence, minus the builder's steps: checks, journeys, scope.
    const { baseRef, checks, file } = yield* workspace.projectFile(card.id);
    const heavy = { cardId: card.id, projectId: card.projectId, priority: card.priority, label: card.title };
    const localChecks = checks.filter((check) => check.source !== "ci");
    const pendingCi = checks.length > 0 && localChecks.length === 0 && landsByPullRequest(project);
    const run =
      localChecks.length === 0
        ? { passed: true, results: [] }
        : yield* admission.run(
            { ...heavy, kind: "checks" },
            workspace.runChecks({ cardId: card.id, scope: "full", checks: localChecks }),
          );
    const journeys =
      run.passed && (file?.journeys.length ?? 0) > 0
        ? yield* admission.run({ ...heavy, kind: "journey" }, workspace.runJourneys({ cardId: card.id }))
        : null;
    const changes = yield* inspectChanges({ worktreePath, base: baseRef });
    const resultItem =
      (kind: "check" | "journey") =>
      (result: CardWorkspace.CardCheckResult): CardEvidenceItem => ({
        itemId: `${kind}:${result.id}`,
        kind,
        source: "local",
        name: result.name,
        criterionId: null,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        logTail: result.logTail,
        artifactPath: result.logArtifactPath,
        unavailable: null,
      });
    yield* engine.dispatch({
      type: "card.evidence.record",
      commandId: CommandId.make(`card-evidence:evidence-revert-${job.key}`),
      cardId: card.id,
      evidenceId: `evidence-revert-${job.key}`,
      headSha: changes.headSha,
      purpose: "review",
      items: [
        ...run.results.map(resultItem("check")),
        ...(journeys?.results ?? []).map(resultItem("journey")),
        ...(pendingCi
          ? checks.map(
              (check): CardEvidenceItem => ({
                itemId: `ci:${check.id}`,
                kind: "check",
                source: "ci",
                name: check.name,
                criterionId: null,
                exitCode: null,
                timedOut: false,
                durationMs: null,
                logTail: "",
                artifactPath: null,
                unavailable: { code: PENDING_CI_CODE, text: "Waiting for CI on the pull request." },
              }),
            )
          : []),
      ],
      // A revert deletes what the card added, tests included; a person still sees those flags.
      flags: judgeScope({ files: changes.files, manifests: changes.manifests, likelyAreas: [] }),
      risks: null,
      recordedAt: yield* nowIso,
    });
    if (!run.passed || journeys?.passed === false) {
      return yield* needsPerson(
        card.id,
        job.key,
        `The ${run.passed ? "journeys" : "checks"} failed on the revert of ${short}. Assign an agent to fix it.`,
      );
    }
    yield* engine
      .dispatch({
        type: "card.review.enter",
        commandId: CommandId.make(`card-review-enter:revert-${job.key}`),
        cardId: card.id,
        headSha: changes.headSha,
      })
      .pipe(
        Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
          needsPerson(card.id, job.key, `The revert of ${short} didn't enter review: ${refusal.detail}`),
        ),
      );
  });

  const restore = Effect.fn("CardReversibilityReactor.restore")(function* (
    job: Extract<ReversibilityJob, { kind: "restore" }>,
  ) {
    // The decider already refused a restore while the owner works; its latest session is the one.
    const [owner] = yield* liveness.listCardOwnerRuns({ cardId: job.cardId, since: EPOCH });
    if (owner === undefined) {
      return yield* record(job.cardId, `restore-refused:${job.key}`, {
        body: "The worktree wasn't restored: the card has no agent session with checkpoints.",
        deliverTo: null,
        reason: { code: "restoreFailed", text: "The worktree wasn't restored." },
      });
    }
    yield* engine.dispatch({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make(`card-checkpoint-restore:${job.key}`),
      threadId: owner.threadId,
      turnCount: job.turnCount,
      createdAt: yield* nowIso,
    });
    const body = `A person restored the worktree to turn ${job.turnCount}.`;
    yield* record(job.cardId, `restored:${job.key}`, {
      body,
      deliverTo: "builder",
      reason: { code: CHECKPOINT_RESTORED_CODE, text: body },
    });
  });

  const worker = yield* makeDrainableWorker((job: ReversibilityJob) =>
    (job.kind === "revert" ? revert(job) : restore(job)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : job.kind === "revert"
            ? needsPerson(
                job.cardId,
                job.key,
                `The revert couldn't run: ${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}. Assign an agent to do it.`,
              ).pipe(Effect.ignore)
            : Effect.logWarning("card checkpoint restore failed", { cardId: job.cardId, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.revert-requested":
        return worker.enqueue({
          kind: "revert",
          cardId: event.payload.revertCardId,
          landedSha: event.payload.landedSha,
          key: event.eventId,
        });
      case "card.checkpoint-restore-requested":
        return worker.enqueue({
          kind: "restore",
          cardId: event.payload.cardId,
          turnCount: event.payload.turnCount,
          key: event.eventId,
        });
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardReversibilityReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies CardReversibilityReactor["Service"];
});

export const layer = Layer.effect(CardReversibilityReactor, make).pipe(
  Layer.provide(ProjectionRunLivenessRepositoryLive),
);
