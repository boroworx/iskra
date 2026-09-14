import {
  CARD_AUTOFIX_ATTEMPTS,
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  MessageId,
  type CardChecks,
  type CardId,
  type OrchestrationCard,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The review loop and the merge queue. A card entering review runs the project's
 * checks; a failure goes back to its agent as its next turn, until the third
 * failure in a row, which waits for a person instead. A card approved to merge
 * lands in turn: one at a time (invariant 7), rebased, checked and fast-forwarded
 * into its base. A conflict or failure sends it back to work with the reason.
 * When a card lands, what it blocked becomes related, and cards in progress that
 * change the same files are flagged as overlapping and told to rebase (invariant 8).
 */
export class CardReviewReactor extends Context.Service<
  CardReviewReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardReviewReactor") {}

type ReviewRequest =
  | { readonly kind: "checks"; readonly cardId: CardId; readonly key: string }
  | { readonly kind: "land"; readonly cardId: CardId; readonly key: string };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // ponytail: reads the whole command read model per step, like the other card reactors.
  const readCards = () =>
    snapshotQuery.getCommandReadModel().pipe(Effect.map((model) => model.cards ?? []));
  const readCard = (cardId: CardId) =>
    readCards().pipe(Effect.map((cards) => cards.find((card) => card.id === cardId)));

  const recordChecks = (
    cardId: CardId,
    key: string,
    state: CardChecks["state"],
    summary: string,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.checks.record",
        commandId: CommandId.make(`card-checks:${state}:${key}`),
        cardId,
        state,
        summary,
        updatedAt: yield* nowIso,
      });
    });

  /** A note for the card's agent, delivered as its next turn. */
  const tellOwner = (cardId: CardId, key: string, body: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.message.record",
        commandId: CommandId.make(`card-review-note:${key}`),
        cardId,
        messageId: MessageId.make(`card-review-note:${key}`),
        authorKind: "system",
        authorId: CHANNEL_SYSTEM_AUTHOR_ID,
        body,
        runThreadId: null,
        forOwner: true,
        createdAt: yield* nowIso,
      });
    });

  const returnToWork = (cardId: CardId, key: string, reason: string) =>
    engine.dispatch({
      type: "card.work.return",
      commandId: CommandId.make(`card-return:${key}`),
      cardId,
      reason,
    });

  const reviewChecks = Effect.fn("CardReviewReactor.reviewChecks")(function* (
    cardId: CardId,
    key: string,
  ) {
    yield* recordChecks(cardId, key, "running", "");
    const result = yield* workspace.runChecks(cardId);
    const card = yield* readCard(cardId);
    if (card === undefined) {
      return;
    }
    yield* recordChecks(cardId, key, result.passed ? "passed" : "failed", result.summary);
    if (result.passed || card.status !== "inReview") {
      return;
    }
    const failedRuns = (card.checks?.failedRuns ?? 0) + 1;
    if (failedRuns >= CARD_AUTOFIX_ATTEMPTS) {
      return; // Needs you takes it from here.
    }
    yield* tellOwner(
      cardId,
      key,
      `The project's checks failed (attempt ${failedRuns} of ${CARD_AUTOFIX_ATTEMPTS}). Fix them, then ask for review again.\n\n${result.summary}`,
    );
    yield* returnToWork(cardId, key, "The project's checks failed.");
  });

  const afterLanding = Effect.fn("CardReviewReactor.afterLanding")(function* (
    landed: OrchestrationCard,
    files: ReadonlyArray<string>,
    key: string,
  ) {
    const others = (yield* readCards()).filter(
      (card) => card.projectId === landed.projectId && card.id !== landed.id,
    );
    // What this card blocked is free now; the relation stays as history.
    for (const blocked of others.filter((card) =>
      card.relations.some((relation) => relation.kind === "blockedBy" && relation.cardId === landed.id),
    )) {
      yield* engine.dispatch({
        type: "card.relation.remove",
        commandId: CommandId.make(`card-unblock:${key}:${blocked.id}`),
        cardId: blocked.id,
        kind: "blockedBy",
        otherCardId: landed.id,
      });
      yield* engine
        .dispatch({
          type: "card.relation.add",
          commandId: CommandId.make(`card-related:${key}:${blocked.id}`),
          cardId: blocked.id,
          kind: "related",
          otherCardId: landed.id,
        })
        .pipe(Effect.catch(() => Effect.void));
    }

    const landedFiles = new Set(files);
    for (const other of others.filter(
      (card) => card.status === "inProgress" && card.worktreePath !== null,
    )) {
      const shared = (yield* workspace
        .changedFiles(other.id)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter((file) =>
        landedFiles.has(file),
      );
      if (
        shared.length === 0 ||
        other.relations.some((relation) => relation.kind === "overlaps" && relation.cardId === landed.id)
      ) {
        continue;
      }
      yield* engine.dispatch({
        type: "card.overlap.flag",
        commandId: CommandId.make(`card-overlap:${key}:${other.id}`),
        cardId: other.id,
        otherCardId: landed.id,
      });
      yield* tellOwner(
        other.id,
        `${key}:${other.id}`,
        `"${landed.title}" just landed and changes files you are changing too: ${shared.join(", ")}. Rebase onto its base branch before you ask for review.`,
      );
    }
  });

  const land = Effect.fn("CardReviewReactor.land")(function* (cardId: CardId, key: string) {
    const card = yield* readCard(cardId);
    // Taken out of the queue while it waited.
    if (card === undefined || card.status !== "landing") {
      return;
    }
    const result = yield* workspace
      .land(cardId)
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({ kind: "notMerged" as const, message: error.message }),
        ),
      );
    switch (result.kind) {
      case "landed":
        yield* engine.dispatch({
          type: "card.land",
          commandId: CommandId.make(`card-land:${key}`),
          cardId,
        });
        return yield* afterLanding(card, result.files, key);
      case "conflict":
        yield* tellOwner(
          cardId,
          key,
          `Landing stopped: rebasing onto \`${result.baseBranch}\` conflicts in ${result.files.join(", ") || "the worktree"}. Rebase onto \`${result.baseBranch}\`, resolve the conflicts, then ask for review again.`,
        );
        return yield* returnToWork(cardId, key, `Rebasing onto ${result.baseBranch} conflicts.`);
      case "checksFailed":
        yield* recordChecks(cardId, key, "failed", result.summary);
        yield* tellOwner(
          cardId,
          key,
          `Landing stopped: the project's checks failed after rebasing.\n\n${result.summary}`,
        );
        return yield* returnToWork(cardId, key, "The project's checks failed while landing.");
      case "notMerged":
        yield* tellOwner(cardId, key, `Landing stopped: ${result.message}`);
        return yield* returnToWork(cardId, key, "The card could not be merged into its base.");
    }
  });

  // One worker for every project: cards land strictly one after another.
  // ponytail: a queue per project if unrelated projects wait on each other's checks.
  const worker = yield* makeDrainableWorker((request: ReviewRequest) =>
    (request.kind === "checks"
      ? reviewChecks(request.cardId, request.key)
      : land(request.cardId, request.key)
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card review request failed", {
              kind: request.kind,
              cardId: request.cardId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    if (event.type !== "card.status-changed") {
      return Effect.void;
    }
    switch (event.payload.to) {
      case "inReview":
        return worker.enqueue({ kind: "checks", cardId: event.payload.cardId, key: event.eventId });
      case "landing":
        return worker.enqueue({ kind: "land", cardId: event.payload.cardId, key: event.eventId });
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardReviewReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies CardReviewReactor["Service"];
});

export const layer = Layer.effect(CardReviewReactor, make);
