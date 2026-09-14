import {
  CommandId,
  type ProviderRuntimeEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import { turnUsageTotals } from "./cardSpend.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

type FinishedTurnEvent = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.completed" | "turn.aborted" }
>;

/**
 * Records what each turn of a card session cost, on the card and against its
 * agent. A turn is priced like the usage page prices it: the provider's reported
 * cost, else its tokens at the model's rate, else unpriced. A turn is recorded
 * once, however often its completion arrives.
 */
export class CardSpendReactor extends Context.Service<
  CardSpendReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly recordTurn: (event: FinishedTurnEvent) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardSpendReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const usage = yield* UsageService.UsageService;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const recordTurnUnsafe = Effect.fn("CardSpendReactor.recordTurn")(function* (
    event: FinishedTurnEvent,
  ) {
    if (event.turnId === undefined) {
      return;
    }
    const run = yield* snapshotQuery.getRunByThreadId(event.threadId);
    if (Option.isNone(run) || run.value.cardId === null) {
      return;
    }
    // An attempt spends from its card's budget (invariant 13 over best-of-N).
    const cards = (yield* snapshotQuery.getCommandReadModel()).cards ?? [];
    const card = cards.find((candidate) => candidate.id === run.value.cardId);
    const spendCardId =
      card !== undefined && card.attemptGroupId !== null && card.parentCardId !== null
        ? card.parentCardId
        : run.value.cardId;
    const thread = yield* snapshotQuery.getThreadShellById(event.threadId);
    const model = Option.isSome(thread) ? thread.value.modelSelection.model : "";
    const priced = yield* usage.priceTurn({
      model,
      totals: turnUsageTotals(event.payload.tokenUsage),
      reportedCostUsd:
        event.type === "turn.completed" ? (event.payload.totalCostUsd ?? null) : null,
    });
    yield* engine.dispatch({
      type: "card.spend.record",
      // The turn names the record, so a repeated completion is counted once.
      commandId: CommandId.make(`card-spend:${event.threadId}:${event.turnId}`),
      cardId: spendCardId,
      threadId: event.threadId,
      agentId: run.value.agentId,
      turnId: event.turnId,
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      recordedAt: yield* nowIso,
    });
  });

  const recordTurn = (event: FinishedTurnEvent) =>
    recordTurnUnsafe(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("card spend could not be recorded", {
              threadId: event.threadId,
              turnId: event.turnId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(recordTurn);

  const start = Effect.fn("CardSpendReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        event.type === "turn.completed" || event.type === "turn.aborted"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return { start, recordTurn, drain: worker.drain } satisfies CardSpendReactor["Service"];
});

export const layer = Layer.effect(CardSpendReactor, make);
