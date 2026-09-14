import * as NodeOS from "node:os";

import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type CardId,
  type OrchestrationEvent,
  type Reason,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { environmentSessionCapOf, planStarts } from "./cardQueue.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { runSessionChange } from "./RunReactor.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Waits after the 1st, 2nd and 3rd failed start; the 4th failure pauses the card. */
export const START_RETRY_MINUTES = [1, 5, 30] as const;

/**
 * Starts card owner sessions from the queue. It re-plans when a card, a policy or a session changes
 * and once a minute, starts what `planStarts` picks with `card.session.start` (the decider re-checks
 * every gate), notes why the rest wait, and stops idle owners of cards in review so their slot frees.
 * A start that fails is retried after 1, 5 and 30 minutes, then the card is paused.
 */
export class CardScheduler extends Context.Service<
  CardScheduler,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardScheduler") {}

const REPLAN_EVENTS: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "card.created",
  "card.status-changed",
  "card.delegate-changed",
  "card.relation-added",
  "card.relation-removed",
  "card.session-started",
  "card.spec-state-changed",
  "card.budget-set",
  "card.unpriced-accepted",
  "card.acceptance-set",
  "card.paused",
  "card.resumed",
  "card.checkpoint-resolved",
  // An answer lets a card waiting on a person start again.
  "card.activity-recorded",
  "card.landing-linked",
  "card.spend-recorded",
  "project.orchestration-set",
]);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const admission = yield* HostAdmission;
  const crypto = yield* Crypto.Crypto;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const freshId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`${prefix}:${uuid}`)),
    );

  // In memory: a server restart forgets both, and every unstarted card is simply tried again.
  const starting = new Set<CardId>();
  const failures = new Map<CardId, { readonly attempts: number; readonly retryAt: number }>();

  const plan = Effect.fn("CardScheduler.plan")(function* () {
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const runtime = (yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    )).cardRuntime;
    const now = yield* nowMillis;
    const result = planStarts({
      readModel,
      environmentSessionCap: environmentSessionCapOf({
        cores: NodeOS.availableParallelism(),
        totalMemBytes: NodeOS.totalmem(),
        override: runtime.environmentSessionCap,
      }),
      starting,
      retryAt: new Map([...failures].map(([cardId, failure]) => [cardId, failure.retryAt])),
      memoryPressure: (yield* admission.snapshot).memoryPressureSince !== null,
      now,
    });

    for (const threadId of result.stop) {
      yield* engine
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`card-schedule-stop:${threadId}`),
          threadId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catch((error) => Effect.logWarning("idle owner was not stopped", { threadId, error: error.message })));
    }
    for (const { cardId, reason } of result.waits) {
      yield* engine
        .dispatch({
          type: "card.wait.note",
          commandId: yield* freshId(`card-schedule-wait:${cardId}`),
          cardId,
          threadId: null,
          reason,
          notedAt: yield* nowIso,
        })
        .pipe(Effect.catch((error) => Effect.logWarning("card wait was not noted", { cardId, error: error.message })));
    }
    for (const card of result.start) {
      starting.add(card.id);
      yield* engine
        .dispatch({
          type: "card.session.start",
          commandId: yield* freshId(`card-schedule:${card.id}`),
          cardId: card.id,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catch((error) => failed(card.id, error.message)));
    }
  });

  /** A start that failed backs off, then pauses the card on the fourth failure. */
  const failed = Effect.fn("CardScheduler.failed")(function* (cardId: CardId, message: string) {
    starting.delete(cardId);
    const attempts = (failures.get(cardId)?.attempts ?? 0) + 1;
    const minutes = START_RETRY_MINUTES[attempts - 1];
    if (minutes !== undefined) {
      failures.set(cardId, { attempts, retryAt: (yield* nowMillis) + minutes * 60_000 });
      return;
    }
    failures.delete(cardId);
    const reason: Reason = {
      code: "startFailed",
      text: `The agent's session failed to start ${attempts} times: ${message}`,
    };
    yield* engine
      .dispatch({
        type: "card.pause.system",
        commandId: yield* freshId(`card-schedule-pause:${cardId}`),
        cardId,
        reason,
      })
      .pipe(Effect.catch((error) => Effect.logWarning("card was not paused", { cardId, error: error.message })));
  });

  let planQueued = false;
  const worker = yield* makeDrainableWorker((request: "plan") =>
    Effect.suspend(() => {
      planQueued = false;
      return plan();
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card scheduler request failed", { request, cause: Cause.pretty(cause) }),
      ),
    ),
  );
  // Bursts of events collapse into one plan over the latest read model.
  const requestPlan = Effect.suspend(() => {
    if (planQueued) return Effect.void;
    planQueued = true;
    return worker.enqueue("plan");
  });

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.session-started":
        if (event.payload.role === "owner") {
          starting.delete(event.payload.cardId);
          failures.delete(event.payload.cardId);
        }
        return requestPlan;
      // The session reactor says a start it took failed.
      case "card.wait-noted":
        return event.payload.reason?.code === "startFailed" && starting.has(event.payload.cardId)
          ? Effect.andThen(failed(event.payload.cardId, event.payload.reason.text), requestPlan)
          : Effect.void;
      case "thread.session-set":
        return runSessionChange(event.payload.session) === null ? Effect.void : requestPlan;
      default:
        return REPLAN_EVENTS.has(event.type) ? requestPlan : Effect.void;
    }
  };

  const start = Effect.fn("CardScheduler.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // The tick retries backed-off starts and catches capacity that freed without an event.
    yield* forkParked(requestPlan.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
  });

  return { start, drain: worker.drain } satisfies CardScheduler["Service"];
});

export const layer = Layer.effect(CardScheduler, make);
