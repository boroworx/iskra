import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  projectOrchestrationOf,
  type CardActivity,
  type CardId,
  type OrchestrationCard,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import {
  BLOCKED_PAUSE_CODES,
  firstCommitSha,
  FOREIGN_COMMIT_CODE,
  OUTCOME_WINDOW_MS,
  outcomeFlawedBody,
  outcomeOf,
  type LandedSignals,
} from "./outcomeRules.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Outcomes. Once a day, and when a card lands or is abandoned, every finished card without an
 * outcome is judged by `outcomeOf`: blocked at once, flawed as soon as a revert or a CI failure on
 * its base shows, manual or success after seven days. A flawed card asks a person for a hidden
 * scenario. When a card enters review, commits on its branch from another author are noted on it,
 * while the branch still exists. Outcomes only label; they move nothing.
 */
export class OutcomeReactor extends Context.Service<
  OutcomeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/OutcomeReactor") {}

type OutcomeJob =
  | { readonly kind: "all" }
  | { readonly kind: "card"; readonly cardId: CardId }
  | { readonly kind: "authors"; readonly cardId: CardId };

const lines = (text: string | null) =>
  (text ?? "").split("\n").filter((line) => line.trim().length > 0);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const runner = yield* ProcessRunner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** A git read: its output, or null when git failed. */
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", cwd, ...args], timeout: "30 seconds" }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    );
  const baseRefOf = (cardId: CardId) =>
    workspace.projectFile(cardId).pipe(
      Effect.map((file) => file.baseRef),
      Effect.orElseSucceed(() => null),
    );

  const record = (cardId: CardId, activityId: string, body: string, code: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-outcome-activity:${activityId}`),
        activityId,
        cardId,
        kind: "message",
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body,
        runThreadId: null,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code, text: body.slice(0, 200) },
        createdAt: yield* nowIso,
      });
    });

  const landedSignals = Effect.fn("OutcomeReactor.landedSignals")(function* (
    model: OrchestrationReadModel,
    card: OrchestrationCard & { readonly landedSha: string },
    activities: ReadonlyArray<CardActivity>,
  ) {
    const project = model.projects.find((candidate) => candidate.id === card.projectId);
    const cards = model.cards ?? [];
    const landedAt = activities.findLast((activity) => activity.status?.to === "landed")?.createdAt ?? card.updatedAt;
    const signals: LandedSignals = {
      landedAt,
      revertLanded: cards.some((other) => other.revertsCardId === card.id && other.status === "landed"),
      revertOnBase: false,
      ciFailureOnBase: false,
      mergedOnHost: card.landing?.mergedOnHostUrl !== undefined,
      foreignCommit: activities.some((activity) => activity.reason?.code === FOREIGN_COMMIT_CODE),
    };
    if (project === undefined || signals.revertLanded) return signals;
    const root = project.workspaceRoot;

    const baseRef = yield* baseRefOf(card.id);
    const reverting =
      baseRef === null
        ? null
        : yield* git(root, ["log", "--format=%H", "-F", `--grep=This reverts commit ${card.landedSha}`, baseRef]);
    if (lines(reverting).length > 0) return { ...signals, revertOnBase: true };

    // CI failure trigger fires in the window, on a commit that descends from the landed one and
    // whose failure text names a file the card changed.
    const ciTriggers = new Set(
      projectOrchestrationOf(project)
        .triggers.filter((trigger) => trigger.kind === "ciFailure")
        .map((trigger) => trigger.id),
    );
    const shell = yield* snapshotQuery.getProjectShellById(project.id);
    const fires = (Option.getOrNull(shell)?.recentTriggerFires ?? []).filter(
      (fire) =>
        ciTriggers.has(fire.triggerId) &&
        fire.outcome === "created" &&
        fire.cardId !== null &&
        fire.firedAt >= landedAt &&
        Date.parse(fire.firedAt) - Date.parse(landedAt) < OUTCOME_WINDOW_MS,
    );
    if (fires.length === 0) return signals;
    const files = lines(yield* git(root, ["diff", "--name-only", `${card.landedSha}^1`, card.landedSha]));
    for (const fire of fires) {
      const failure = cards.find((other) => other.id === fire.cardId);
      const sha = failure === undefined ? null : firstCommitSha(failure.spec);
      if (failure === undefined || sha === null || !files.some((file) => failure.spec.includes(file))) continue;
      if ((yield* git(root, ["merge-base", "--is-ancestor", card.landedSha, sha])) !== null) {
        return { ...signals, ciFailureOnBase: true };
      }
    }
    return signals;
  });

  const evaluate = Effect.fn("OutcomeReactor.evaluate")(function* (
    model: OrchestrationReadModel,
    card: OrchestrationCard,
  ) {
    if (card.outcome !== null) return;
    const landedSha = card.landedSha;
    const landed =
      card.status === "landed" && landedSha !== null
        ? yield* landedSignals(
            model,
            { ...card, landedSha },
            (yield* snapshotQuery.getCardActivity(card.id, { limit: 200 })).activities,
          )
        : null;
    const outcome = outcomeOf({ card, now: yield* nowIso, landed });
    if (outcome === null) return;
    yield* engine.dispatch({
      type: "card.outcome.record",
      commandId: CommandId.make(`card-outcome:${card.id}`),
      cardId: card.id,
      outcome,
    });
    if (outcome.state === "flawed") {
      yield* record(card.id, `outcome-flawed:${card.id}`, outcomeFlawedBody(outcome), "outcomeFlawed");
    }
  });

  /** A card still to judge: landed through Iskra (so it has a landed commit), or abandoned after a failing pause. */
  const awaitsOutcome = (card: OrchestrationCard) =>
    card.outcome === null &&
    ((card.status === "landed" && card.landedSha !== null) ||
      (card.status === "abandoned" && BLOCKED_PAUSE_CODES.includes(card.paused?.reason.code ?? "")));

  /** Notes commits on a card's branch by anyone but this machine's git author, once per card. */
  const noteForeignAuthors = Effect.fn("OutcomeReactor.noteForeignAuthors")(function* (cardId: CardId) {
    const card = (yield* snapshotQuery.getCommandReadModel()).cards?.find((candidate) => candidate.id === cardId);
    const baseRef = yield* baseRefOf(cardId);
    if (card?.worktreePath == null || baseRef === null) return;
    const me = yield* git(card.worktreePath, ["config", "user.email"]);
    const others = [
      ...new Set(lines(yield* git(card.worktreePath, ["log", "--format=%ae", `${baseRef}..HEAD`]))),
    ].filter((author) => author !== me);
    if (others.length === 0) return;
    yield* record(
      cardId,
      `foreign-commit:${cardId}`,
      `The card's branch has commits by ${others.join(", ")}, so its outcome will count as manual.`,
      FOREIGN_COMMIT_CODE,
    );
  });

  const handle = Effect.fn("OutcomeReactor.handle")(function* (job: OutcomeJob) {
    if (job.kind === "authors") return yield* noteForeignAuthors(job.cardId);
    const model = yield* snapshotQuery.getCommandReadModel();
    const cards = model.cards ?? [];
    const judged =
      job.kind === "all"
        ? cards.filter(awaitsOutcome)
        : cards.filter((card) => {
            const landed = cards.find((candidate) => candidate.id === job.cardId);
            // A landed revert makes the card it reverts flawed right away.
            return card.id === job.cardId || card.id === landed?.revertsCardId;
          });
    for (const card of judged.filter(awaitsOutcome)) {
      yield* evaluate(model, card).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("card outcome could not be judged", { cardId: card.id, cause: Cause.pretty(cause) }),
        ),
      );
    }
  });

  const worker = yield* makeDrainableWorker((job: OutcomeJob) =>
    handle(job).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("outcome job failed", { job, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    if (event.type !== "card.status-changed") return Effect.void;
    switch (event.payload.to) {
      case "landed":
      case "abandoned":
        return worker.enqueue({ kind: "card", cardId: event.payload.cardId });
      case "inReview":
        return worker.enqueue({ kind: "authors", cardId: event.payload.cardId });
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("OutcomeReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // ponytail: one pass a day over every card still awaiting an outcome, however many there are.
    yield* forkParked(
      worker.enqueue({ kind: "all" }).pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 day")),
        Effect.asVoid,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies OutcomeReactor["Service"];
});

export const layer = Layer.effect(OutcomeReactor, make);
