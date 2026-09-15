import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  DEFAULT_AGENT_BLUEPRINT,
  projectOrchestrationOf,
  type CardActivity,
  type CardEvidenceItem,
  type CardEvidencePurpose,
  type CardId,
  type CardRiskClaims,
  type OrchestrationCard,
  type OrchestrationEvent,
  type OrchestrationReadModel,
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
import {
  PreviewAutomationBroker,
  type PreviewAutomationHostConnected,
} from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionCardRepositoryLive } from "../persistence/Layers/ProjectionCards.ts";
import { ProjectionCardRepository } from "../persistence/Services/ProjectionCards.ts";
import { forkParked } from "../serverActivation.ts";
import {
  captureUiEvidence,
  type CaptureServices,
  commitAndRebase,
  fetchBase,
  inspectChanges,
  judgeScope,
  NO_PREVIEW_HOST,
  REVIEW_REQUESTED_CODE,
  riskClaimsOf,
  RUN_CHECKS_RESULT_CODE,
  runChecksJob,
  runChecksRequestOf,
  runScriptOf,
  uiEvidenceRequired,
} from "./CardEvidence.ts";
import {
  CI_ONLY_NO_PULL_REQUEST_REASON,
  EVIDENCE_CAPTURE_CODE,
  fixRoundRefusal,
  landsByPullRequest,
  NO_CHECKS_REASON,
  PENDING_CI_CODE,
} from "./cardRules.ts";
import { catchReactorCause } from "./CardWatchdog.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The review gate. An owner's review request, or its checkpoint, runs one deterministic blueprint
 * in the card's worktree: fetch the base, commit leftovers and rebase, run targeted checks first
 * when the builder's blueprint asks, run the project's local checks through machine admission, run
 * its declared journeys against running services, judge the change's scope, screenshot the app per
 * the blueprint's UI capture, and record it all as evidence for the commit. Review passes only
 * through `card.review.enter`, which the decider refuses without passing evidence for that commit.
 * Failing checks or journeys go back to the owner as its next turn and use a CI fix round; past the
 * project's rounds the card pauses for a person. A checkpoint records the same evidence and moves
 * nothing. When a desktop host connects, a card in review whose screenshots found no host is
 * captured again, once per connection. Landing is CardLandingReactor's.
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
  /** A person's capture for a card already in review: record evidence for its head, nothing more. */
  readonly capture?: boolean;
  /** A desktop host connected: capture this evidence's screenshots again, onto the same evidence. */
  readonly previewRetry?: { readonly evidenceId: string };
}

/** The reason a screenshot captured again after a desktop host connected is recorded with. */
export const PREVIEW_HOST_CONNECTED_CODE = "previewHostConnected";

/** A check's or journey's result as an evidence item. */
const resultItem = (
  kind: "check" | "journey",
  result: CardWorkspace.CardCheckResult,
): CardEvidenceItem => ({
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

/** A CI check that hasn't reported: it passes review entry and holds the merge until it does. */
const pendingCiItem = (check: CardWorkspace.CardProjectFile["checks"][number]): CardEvidenceItem => ({
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
});

/** What the owner reads when its checks or journeys fail: which failed, and each failing tail. */
export function checksFeedback(input: {
  readonly headSha: string;
  readonly results: ReadonlyArray<CardWorkspace.CardCheckResult>;
  readonly round: number;
  readonly cap: number;
  readonly what?: "checks" | "journeys";
}): string {
  const failed = input.results.filter((result) => result.exitCode !== 0 || result.timedOut);
  return [
    `The ${input.what ?? "checks"} failed on ${input.headSha.slice(0, 7)} (fix round ${input.round} of ${input.cap}). Fix them, commit, then call request_review again.`,
    ...failed.map(
      (result) =>
        `### ${result.name}: ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "none"}`}\n\n\`\`\`\n${result.logTail.trimEnd()}\n\`\`\``,
    ),
  ].join("\n\n");
}

/** The blueprint the card's builder follows: its agent template's, else the default. */
const blueprintOf = (model: OrchestrationReadModel, card: OrchestrationCard) =>
  (model.agents ?? []).find((agent) => agent.id === card.delegateAgentId)?.blueprint ??
  DEFAULT_AGENT_BLUEPRINT;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const admission = yield* HostAdmission.HostAdmission;
  const environment = yield* ServerEnvironment;
  const broker = yield* PreviewAutomationBroker;
  const cardRepository = yield* ProjectionCardRepository;
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

  /** Screenshots of the card's app at the blueprint's paths, with its services and preview running. */
  const captureScreens = (input: {
    readonly model: OrchestrationReadModel;
    readonly card: OrchestrationCard & { readonly portBase: number };
    readonly file: CardWorkspace.CardProjectFile["file"];
    readonly evidenceId: string;
  }) =>
    Effect.gen(function* () {
      const { card } = input;
      const project = input.model.projects.find((candidate) => candidate.id === card.projectId);
      const script = project === undefined ? null : runScriptOf(project.scripts);
      if (script === null) {
        return [
          {
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
          },
        ] satisfies ReadonlyArray<CardEvidenceItem>;
      }
      yield* workspace.ensureServices(card.id);
      yield* workspace.runScript({ cardId: card.id, scriptId: script.id });
      const { uiPaths } = blueprintOf(input.model, card);
      return yield* admission.run(
        {
          cardId: card.id,
          projectId: card.projectId,
          priority: card.priority,
          label: card.title,
          kind: "evidence",
        },
        captureUiEvidence({
          cardId: card.id,
          environmentId: yield* environment.getEnvironmentId,
          port: card.portBase + (input.file?.ports["web"] ?? 0),
          portBase: card.portBase,
          paths: uiPaths.length > 0 ? uiPaths : ["/"],
          evidenceId: input.evidenceId,
        }),
      );
    });

  const blueprint = Effect.fn("CardReviewReactor.blueprint")(function* (job: ReviewJob) {
    const { cardId, key, purpose } = job;
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    const project = model.projects.find((candidate) => candidate.id === card?.projectId);
    const capture = job.capture === true;
    const expectedStatus = capture ? "inReview" : "inProgress";
    if (card === undefined || project === undefined || card.status !== expectedStatus) return;
    if (card.worktreePath === null || card.portBase === null) {
      return yield* tellBuilder(
        cardId,
        key,
        "noWorktree",
        "The card has no worktree yet, so nothing can be checked.",
      );
    }
    const policy = projectOrchestrationOf(project);
    const plan = blueprintOf(model, card);
    const worktreePath = card.worktreePath;

    const base = yield* workspace.projectFile(cardId);
    yield* fetchBase({ worktreePath, baseBranch: base.baseBranch });
    const { baseRef, checks, file } = yield* workspace.projectFile(cardId);
    // A capture describes the branch under review as it is, so it neither commits nor rebases it.
    const prepared = capture
      ? null
      : yield* workspace.withCardLock(
          cardId,
          commitAndRebase({ worktreePath, baseRef, message: `${card.title}: work in progress` }),
        );
    if (prepared?.kind === "conflict") {
      return yield* tellBuilder(
        cardId,
        key,
        "rebaseConflict",
        `Rebasing onto \`${baseRef}\` conflicts in ${prepared.files.join(", ") || "the worktree"}. Rebase onto \`${baseRef}\`, resolve the conflicts, commit, then call ${purpose === "review" ? "request_review" : "request_checkpoint"} again.`,
      );
    }

    const heavy = { cardId, projectId: card.projectId, priority: card.priority, label: card.title };
    const localChecks = checks.filter((check) => check.source !== "ci");
    // Checks that only run in CI are verified on the pull request, so review needs one to open.
    const ciOnly = checks.length > 0 && localChecks.length === 0;
    // A capture refuses nothing: it records what the checks say, and CI items only where CI can report.
    const pendingCi = ciOnly && (!capture || landsByPullRequest(project));
    if (ciOnly && purpose === "review" && !capture && !landsByPullRequest(project)) {
      yield* record(cardId, `review-ci-only:${key}`, {
        kind: "error",
        body: CI_ONLY_NO_PULL_REQUEST_REASON,
        deliverTo: null,
        reason: { code: "ciChecksNeedPullRequest", text: CI_ONLY_NO_PULL_REQUEST_REASON },
      });
      return yield* tellBuilder(
        cardId,
        key,
        "reviewRefused",
        `The card didn't enter review: ${CI_ONLY_NO_PULL_REQUEST_REASON}`,
      );
    }

    const changes = yield* inspectChanges({ worktreePath, base: baseRef });
    // Targeted checks first when the blueprint asks: a quick failure spares the full suite.
    const targeted = localChecks.filter((check) => check.targetedCommand !== null);
    const preflight =
      capture || plan.preflight !== "targeted" || targeted.length === 0
        ? null
        : yield* admission.run(
            { ...heavy, label: `Targeted checks for ${card.title}`, kind: "checks" },
            workspace.runChecks({
              cardId,
              scope: "targeted",
              filter: changes.files.map((changed) => changed.path).join(" "),
              checks: targeted,
            }),
          );
    const run =
      preflight !== null && !preflight.passed
        ? preflight
        : localChecks.length === 0
          ? { passed: true, summary: "", results: [] }
          : yield* admission.run(
              { ...heavy, kind: "checks" },
              workspace.runChecks({ cardId, scope: "full", checks: localChecks }),
            );
    // Journeys are required once declared, and run only on code whose checks pass.
    const journeys =
      run.passed && (file?.journeys.length ?? 0) > 0
        ? yield* admission.run({ ...heavy, kind: "journey" }, workspace.runJourneys({ cardId }))
        : null;
    const passed = run.passed && (journeys?.passed ?? true);

    const flags = judgeScope({
      files: changes.files,
      manifests: changes.manifests,
      likelyAreas: card.estimate?.likelyAreas ?? [],
    });
    const evidenceId = `evidence-${key}`;

    const wantsUi =
      plan.uiCapture === "always" ||
      (plan.uiCapture === "auto" && uiEvidenceRequired(changes.files));
    const ui =
      passed && wantsUi
        ? yield* captureScreens({ model, card: { ...card, portBase: card.portBase }, file, evidenceId })
        : [];

    // Before recording: failing review evidence uses a CI round, so whether one is left is read now.
    const roundsLeft = fixRoundRefusal(card, policy, "ci") === null;
    yield* engine.dispatch({
      type: "card.evidence.record",
      commandId: CommandId.make(`card-evidence:${evidenceId}`),
      cardId,
      evidenceId,
      headSha: changes.headSha,
      purpose,
      items: [
        ...run.results.map((result) => resultItem("check", result)),
        ...(journeys?.results ?? []).map((result) => resultItem("journey", result)),
        ...(pendingCi ? checks.map(pendingCiItem) : []),
        ...ui,
      ],
      flags,
      risks: job.risks,
      recordedAt: yield* nowIso,
    });
    if (purpose === "checkpoint" || capture) return;

    if (!passed) {
      const what = run.passed ? "journeys" : "checks";
      if (!roundsLeft) {
        return yield* engine.dispatch({
          type: "card.pause.system",
          commandId: CommandId.make(`card-rounds-exhausted:${key}`),
          cardId,
          reason: {
            code: "fixRoundsExhausted",
            text: `The ${what} still fail after ${policy.ciFixRounds} fix rounds; a person can give the card more.`,
          },
        });
      }
      return yield* tellBuilder(
        cardId,
        key,
        run.passed ? "journeyFailed" : "checksFailed",
        checksFeedback({
          headSha: changes.headSha,
          results: run.passed ? (journeys?.results ?? []) : run.results,
          round: card.fixRounds.ci + 1,
          cap: policy.ciFixRounds,
          what,
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

  /** Captures a card's screenshots again onto evidence that found no desktop host. */
  const retryPreview = Effect.fn("CardReviewReactor.retryPreview")(function* (
    job: ReviewJob & { readonly previewRetry: { readonly evidenceId: string } },
  ) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === job.cardId);
    const evidence = card?.evidence ?? null;
    if (
      card === undefined ||
      card.status !== "inReview" ||
      card.portBase === null ||
      evidence === null ||
      evidence.evidenceId !== job.previewRetry.evidenceId
    ) {
      return;
    }
    const items = yield* cardRepository.listEvidenceItems({
      cardId: card.id,
      evidenceId: evidence.evidenceId,
    });
    const kept = items.filter((item) => item.kind !== "screenshot" || item.source !== "preview");
    const { file } = yield* workspace.projectFile(card.id);
    const screens = yield* captureScreens({
      model,
      card: { ...card, portBase: card.portBase },
      file,
      evidenceId: evidence.evidenceId,
    });
    const recordedAt = yield* nowIso;
    yield* engine.dispatch({
      type: "card.evidence.record",
      commandId: CommandId.make(`card-evidence-preview-retry:${job.key}`),
      cardId: card.id,
      evidenceId: evidence.evidenceId,
      headSha: evidence.headSha,
      purpose: evidence.purpose,
      items: [
        ...kept.map(
          (item): CardEvidenceItem => ({
            itemId: item.itemId,
            kind: item.kind,
            source: item.source,
            name: item.name,
            criterionId: item.criterionId,
            exitCode: item.exitCode,
            timedOut: item.timedOut,
            durationMs: item.durationMs,
            logTail: item.logTail,
            artifactPath: item.artifactPath,
            unavailable: item.unavailable,
          }),
        ),
        ...screens,
      ],
      flags: evidence.flags,
      risks: null,
      recordedAt,
    });
    const text = "A desktop app connected, so the preview was captured again.";
    yield* record(card.id, `preview-retry:${job.key}`, {
      kind: "message",
      body: text,
      deliverTo: null,
      reason: { code: PREVIEW_HOST_CONNECTED_CODE, text },
    });
  });

  const handle = (job: ReviewJob) =>
    (job.previewRetry === undefined
      ? blueprint(job)
      : retryPreview({ ...job, previewRetry: job.previewRetry })
    ).pipe(
      Effect.provide(context),
      catchReactorCause({ engine, reactor: "The review blueprint", cardId: job.cardId }),
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
        if (activity.author.kind === "human" && activity.reason?.code === EVIDENCE_CAPTURE_CODE) {
          return enqueue({
            purpose: "review",
            cardId: activity.cardId,
            key: event.eventId,
            risks: null,
            capture: true,
          });
        }
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
        // A plan's slice and a migration's tuning checkpoints must not rebase the integration branch.
        if (/^(plan-slice-|migration-tune-)/.test(event.payload.checkpoint.checkpointId)) {
          return Effect.void;
        }
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

  /**
   * A desktop host connected to this environment: every card in review whose latest evidence found
   * no host gets its screenshots captured again, at most once for this connection.
   */
  const onHostConnected = Effect.fn("CardReviewReactor.onHostConnected")(function* (
    host: PreviewAutomationHostConnected,
  ) {
    if (host.environmentId !== (yield* environment.getEnvironmentId)) return;
    const model = yield* readModel();
    for (const card of model.cards ?? []) {
      if (card.status !== "inReview" || card.evidence === null) continue;
      const items = yield* cardRepository.listEvidenceItems({
        cardId: card.id,
        evidenceId: card.evidence.evidenceId,
      });
      if (!items.some((item) => item.unavailable?.code === NO_PREVIEW_HOST.code)) continue;
      yield* enqueue({
        purpose: card.evidence.purpose,
        cardId: card.id,
        key: `${host.connectionId}:${card.id}`,
        risks: null,
        previewRetry: { evidenceId: card.evidence.evidenceId },
      });
    }
  });

  /** run_checks jobs a restart dropped: every request on a card at work without its result runs again. */
  const resumeRunChecks = Effect.fn("CardReviewReactor.resumeRunChecks")(function* () {
    const model = yield* readModel();
    for (const card of model.cards ?? []) {
      if (card.status !== "inProgress" || card.worktreePath === null) continue;
      const { activities } = yield* snapshotQuery.getCardActivity(card.id, { limit: 200 });
      const answered = new Set(
        activities.flatMap((activity) =>
          activity.reason?.code === RUN_CHECKS_RESULT_CODE ? [activity.activityId] : [],
        ),
      );
      for (const activity of activities) {
        const request = runChecksRequestOf(activity);
        if (request === null || answered.has(request.jobId)) continue;
        yield* Effect.forkScoped(
          runChecksJob({ engine, admission, workspace, card, threadId: activity.runThreadId, ...request }),
        );
      }
    }
  });

  const logCause = (what: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.logWarning(what, { cause: Cause.pretty(cause) });

  const start = Effect.fn("CardReviewReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(
      Stream.runForEach(broker.hostConnected, (host) =>
        onHostConnected(host).pipe(
          Effect.catchCause(logCause("screenshots were not captured again on host connect")),
        ),
      ),
    );
    yield* forkParked(
      resumeRunChecks().pipe(Effect.catchCause(logCause("queued run_checks jobs were not resumed"))),
    );
  });

  return { start, drain } satisfies CardReviewReactor["Service"];
});

export const layer = Layer.effect(CardReviewReactor, make).pipe(
  Layer.provide(ProjectionCardRepositoryLive),
);
