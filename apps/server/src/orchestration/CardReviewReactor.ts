import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  projectOrchestrationOf,
  type CardActivity,
  type CardEvidenceItem,
  type CardEvidencePurpose,
  type CardId,
  type CardRiskClaims,
  type OrchestrationEvent,
  type Reason,
} from "@iskra/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import {
  captureUiEvidence,
  type CaptureServices,
  commitAndRebase,
  fetchBase,
  inspectChanges,
  judgeScope,
  REVIEW_REQUESTED_CODE,
  riskClaimsOf,
  runScriptOf,
  uiEvidenceRequired,
} from "./CardEvidence.ts";
import { fixRoundRefusal, NO_CHECKS_REASON } from "./cardRules.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The review gate. An owner's review request, or its checkpoint, runs one deterministic blueprint
 * in the card's worktree: fetch the base, commit leftovers and rebase, run the project's local
 * checks through machine admission, judge the change's scope, screenshot the app when UI files
 * changed, and record it all as evidence for the commit. Review passes only through
 * `card.review.enter`, which the decider refuses without passing evidence for that commit. Failing
 * checks go back to the owner as its next turn and use a CI fix round; past the project's rounds
 * the card pauses for a person. A checkpoint records the same evidence and moves nothing. Landing
 * is CardLandingReactor's.
 */
export class CardReviewReactor extends Context.Service<
  CardReviewReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardReviewReactor") {}

interface ReviewJob {
  readonly purpose: CardEvidencePurpose;
  readonly cardId: CardId;
  readonly key: string;
  readonly risks: CardRiskClaims | null;
}

/** A check's result as an evidence item. */
const checkItem = (result: CardWorkspace.CardCheckResult): CardEvidenceItem => ({
  itemId: `check:${result.id}`,
  kind: "check",
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

/** What the owner reads when its checks fail: which failed, and each failing tail. */
export function checksFeedback(input: {
  readonly headSha: string;
  readonly results: ReadonlyArray<CardWorkspace.CardCheckResult>;
  readonly round: number;
  readonly cap: number;
}): string {
  const failed = input.results.filter((result) => result.exitCode !== 0 || result.timedOut);
  return [
    `The checks failed on ${input.headSha.slice(0, 7)} (fix round ${input.round} of ${input.cap}). Fix them, commit, then call request_review again.`,
    ...failed.map(
      (result) =>
        `### ${result.name}: ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "none"}`}\n\n\`\`\`\n${result.logTail.trimEnd()}\n\`\`\``,
    ),
  ].join("\n\n");
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const admission = yield* HostAdmission.HostAdmission;
  const environment = yield* ServerEnvironment;
  // Jobs run on workers made when a card's first event arrives, so they carry these services along.
  const context = yield* Effect.context<CaptureServices>();
  const scope = yield* Scope.Scope;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // ponytail: reads the whole command read model per step, like the other card reactors.
  const readModel = () => snapshotQuery.getCommandReadModel();

  /** An entry in the card's activity from Iskra; `deliverTo` builder reaches the owner's next turn. */
  const record = (
    cardId: CardId,
    activityId: string,
    entry: Pick<CardActivity, "kind" | "body" | "deliverTo"> & { readonly reason: Reason },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-review-activity:${activityId}`),
        activityId,
        cardId,
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

  const tellBuilder = (cardId: CardId, key: string, code: string, body: string) =>
    record(cardId, `review-feedback:${key}`, {
      kind: "message",
      body,
      deliverTo: "builder",
      reason: { code, text: body.split("\n")[0]!.slice(0, 200) },
    });

  const blueprint = Effect.fn("CardReviewReactor.blueprint")(function* (job: ReviewJob) {
    const { cardId, key, purpose } = job;
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    const project = model.projects.find((candidate) => candidate.id === card?.projectId);
    if (card === undefined || project === undefined || card.status !== "inProgress") return;
    if (card.worktreePath === null || card.portBase === null) {
      return yield* tellBuilder(
        cardId,
        key,
        "noWorktree",
        "The card has no worktree yet, so nothing can be checked.",
      );
    }
    const policy = projectOrchestrationOf(project);
    const worktreePath = card.worktreePath;

    const base = yield* workspace.projectFile(cardId);
    yield* fetchBase({ worktreePath, baseBranch: base.baseBranch });
    const { baseRef, checks, file } = yield* workspace.projectFile(cardId);
    const prepared = yield* workspace.withCardLock(
      cardId,
      commitAndRebase({ worktreePath, baseRef, message: `${card.title}: work in progress` }),
    );
    if (prepared.kind === "conflict") {
      return yield* tellBuilder(
        cardId,
        key,
        "rebaseConflict",
        `Rebasing onto \`${baseRef}\` conflicts in ${prepared.files.join(", ") || "the worktree"}. Rebase onto \`${baseRef}\`, resolve the conflicts, commit, then call ${purpose === "review" ? "request_review" : "request_checkpoint"} again.`,
      );
    }

    const heavy = { cardId, projectId: card.projectId, priority: card.priority, label: card.title };
    const localChecks = checks.filter((check) => check.source !== "ci");
    const run =
      localChecks.length === 0
        ? { passed: true, summary: "", results: [] }
        : yield* admission.run(
            { ...heavy, kind: "checks" },
            workspace.runChecks({ cardId, scope: "full", checks: localChecks }),
          );

    const changes = yield* inspectChanges({ worktreePath, base: baseRef });
    const flags = judgeScope({
      files: changes.files,
      manifests: changes.manifests,
      likelyAreas: card.estimate?.likelyAreas ?? [],
    });
    const evidenceId = `evidence-${key}`;

    const ui: Array<CardEvidenceItem> = [];
    if (run.passed && uiEvidenceRequired(changes.files)) {
      const script = runScriptOf(project.scripts);
      if (script === null) {
        ui.push({
          itemId: "preview:unavailable",
          kind: "screenshot",
          source: "preview",
          name: "Preview /",
          criterionId: null,
          exitCode: null,
          timedOut: false,
          durationMs: null,
          logTail: "",
          artifactPath: null,
          unavailable: {
            code: "noRunScript",
            text: "The project has no run script, so the preview couldn't start.",
          },
        });
      } else {
        yield* workspace.runScript({ cardId, scriptId: script.id });
        ui.push(
          ...(yield* admission.run(
            { ...heavy, kind: "evidence" },
            captureUiEvidence({
              cardId,
              environmentId: yield* environment.getEnvironmentId,
              port: card.portBase + (file?.ports["web"] ?? 0),
              portBase: card.portBase,
              paths: ["/"],
              evidenceId,
            }),
          )),
        );
      }
    }

    // Before recording: failing review evidence uses a CI round, so whether one is left is read now.
    const roundsLeft = fixRoundRefusal(card, policy, "ci") === null;
    yield* engine.dispatch({
      type: "card.evidence.record",
      commandId: CommandId.make(`card-evidence:${evidenceId}`),
      cardId,
      evidenceId,
      headSha: changes.headSha,
      purpose,
      items: [...run.results.map(checkItem), ...ui],
      flags,
      risks: job.risks,
      recordedAt: yield* nowIso,
    });
    if (purpose === "checkpoint") return;

    if (!run.passed) {
      if (!roundsLeft) {
        return yield* engine.dispatch({
          type: "card.pause.system",
          commandId: CommandId.make(`card-rounds-exhausted:${key}`),
          cardId,
          reason: {
            code: "fixRoundsExhausted",
            text: `The checks still fail after ${policy.ciFixRounds} fix rounds; a person can give the card more.`,
          },
        });
      }
      return yield* tellBuilder(
        cardId,
        key,
        "checksFailed",
        checksFeedback({
          headSha: changes.headSha,
          results: run.results,
          round: card.fixRounds.ci + 1,
          cap: policy.ciFixRounds,
        }),
      );
    }

    yield* engine
      .dispatch({
        type: "card.review.enter",
        commandId: CommandId.make(`card-review-enter:${key}`),
        cardId,
        headSha: changes.headSha,
      })
      .pipe(
        Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
          Effect.gen(function* () {
            yield* tellBuilder(
              cardId,
              key,
              "reviewRefused",
              `The card didn't enter review: ${refusal.detail}`,
            );
            // A project without checks needs a person: it shows in Needs you.
            if (refusal.detail === NO_CHECKS_REASON) {
              yield* record(cardId, `review-checks-missing:${key}`, {
                kind: "error",
                body: NO_CHECKS_REASON,
                deliverTo: null,
                reason: { code: "checksMissing", text: NO_CHECKS_REASON },
              });
            }
          }),
        ),
      );
  });

  const handle = (job: ReviewJob) =>
    blueprint(job).pipe(
      Effect.provide(context),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card review job failed", {
              purpose: job.purpose,
              cardId: job.cardId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  // One worker per card: a card's jobs run in order, different cards side by side. Heavy steps
  // still wait for the machine through HostAdmission.
  const workers = new Map<CardId, DrainableWorker<ReviewJob>>();
  const enqueue = (job: ReviewJob) =>
    Effect.gen(function* () {
      let worker = workers.get(job.cardId);
      if (worker === undefined) {
        worker = yield* makeDrainableWorker(handle).pipe(Scope.provide(scope));
        workers.set(job.cardId, worker);
      }
      yield* worker.enqueue(job);
    });
  const drain = Effect.suspend(() =>
    Effect.forEach(workers.values(), (worker) => worker.drain, {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.activity-recorded": {
        const activity = event.payload;
        return activity.author.kind === "agent" && activity.reason?.code === REVIEW_REQUESTED_CODE
          ? enqueue({
              purpose: "review",
              cardId: activity.cardId,
              key: event.eventId,
              risks: riskClaimsOf(activity.body),
            })
          : Effect.void;
      }
      case "card.checkpoint-requested":
        return enqueue({
          purpose: "checkpoint",
          cardId: event.payload.cardId,
          key: event.eventId,
          risks: null,
        });
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardReviewReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain } satisfies CardReviewReactor["Service"];
});

export const layer = Layer.effect(CardReviewReactor, make);
