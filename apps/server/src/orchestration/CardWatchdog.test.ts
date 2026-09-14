import {
  AgentId,
  CardId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CardWatchdog from "./CardWatchdog.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-idle-owner");
const cardId = CardId.make("card-idle");

/** One owner session, settled at the epoch, on a card in progress. */
const readModel = {
  cards: [
    {
      id: cardId,
      projectId: ProjectId.make("project-watchdog"),
      status: "inProgress",
      paused: null,
      priority: 0,
      spentUsd: 0,
      budgetCapUsd: 10,
      checks: null,
    },
  ],
  liveRuns: [
    { threadId, cardId, role: "owner", agentId: AgentId.make("agent-idle"), startedAt: EPOCH },
  ],
} as unknown as OrchestrationReadModel;

/**
 * The watchdog over fakes for everything but its own clock-driven loop: the real engine's work
 * never has to run under the test clock, so moving the clock only drives the watchdog's tick.
 */
const makeWatchdog = (dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) =>
  CardWatchdog.layer.pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getCommandReadModel: () => Effect.succeed(readModel),
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              session: { status: "ready", activeTurnId: null, updatedAt: EPOCH },
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            } as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(HostAdmission)({
        snapshot: Effect.succeed({ running: [], waiting: [], memoryPressureSince: null }),
        cancelLowestPriority: Effect.succeed(null),
      }),
    ),
    Layer.provide(SqlitePersistenceMemory),
  );

const recorded = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) =>
    command.type === "card.activity.record"
      ? [command.kind, command.reason?.code ?? null, command.deliverTo]
      : [command.type],
  );

it.effect("checks live owners on its minute tick and nudges one left idle for five minutes", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    yield* Effect.gen(function* () {
      const watchdog = yield* CardWatchdog.CardWatchdog;
      yield* watchdog.start();
      yield* watchdog.drain;
      expect(yield* Ref.get(dispatched)).toEqual([]);

      // Four ticks later the owner has been idle four minutes: still nothing.
      yield* TestClock.adjust("4 minutes");
      yield* watchdog.drain;
      expect(yield* Ref.get(dispatched)).toEqual([]);

      // The fifth tick finds it idle for five minutes and nudges it once.
      yield* TestClock.adjust("1 minute");
      const commands = yield* Ref.get(dispatched).pipe(
        Effect.repeat({ until: (all) => all.length >= 2 }),
      );
      expect(recorded(commands)).toEqual([
        ["error", "idleInProgress", null],
        ["message", null, "builder"],
      ]);
    }).pipe(Effect.provide(makeWatchdog(dispatched)), Effect.scoped);
  }),
);
