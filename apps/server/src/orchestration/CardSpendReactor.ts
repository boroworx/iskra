import { CommandId, type ProviderRuntimeEvent } from "@iskra/contracts";
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
import { budgetCardOf } from "./decider.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

type FinishedTurnEvent = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.completed" | "turn.aborted" }
>;

/**
 * Records what each turn of a run cost: a card session's on the card and against its agent, a
 * conversation's or lead's against its project, so every run counts toward the monthly budgets. A turn is priced like the usage page prices it: the provider's reported
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
    if (Option.isNone(run)) {
      return;
    }
    const { cardId, agentId, role } = run.value;
    const thread = yield* snapshotQuery.getThreadShellById(event.threadId);
    const priced = yield* usage.priceTurn({
      model: Option.isSome(thread) ? thread.value.modelSelection.model : "",
      totals: turnUsageTotals(event.payload.tokenUsage),
      reportedCostUsd:
        event.type === "turn.completed" ? (event.payload.totalCostUsd ?? null) : null,
    });
    // The turn names the record, so a repeated completion is counted once.
    const turn = {
      threadId: event.threadId,
      agentId,
      turnId: event.turnId,
      role,
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      recordedAt: yield* nowIso,
    };
    if (cardId === null) {
      // A conversation or lead run: its hidden thread lives in the channel's project.
      if (Option.isNone(thread)) return;
      yield* engine.dispatch({
        type: "project.spend.record",
        commandId: CommandId.make(`project-spend:${event.threadId}:${event.turnId}`),
        projectId: thread.value.projectId,
        ...turn,
      });
      return;
    }
    // An attempt, sub-card, or plan or migration child spends from the budget the decider checks
    // for it (invariant 13), so its parent's cap sees what its children cost.
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const card = readModel.cards?.find((candidate) => candidate.id === cardId);
    yield* engine.dispatch({
      type: "card.spend.record",
      commandId: CommandId.make(`card-spend:${event.threadId}:${event.turnId}`),
      cardId: card === undefined ? cardId : budgetCardOf(readModel, card).id,
      ...turn,
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
