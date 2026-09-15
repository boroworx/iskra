import {
  AgentId,
  CardId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
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
import { CardWorkspace } from "./CardWorkspace.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-idle-owner");
const cardId = CardId.make("card-idle");

/** One owner session, settled at the epoch, on a card in progress. */
const readModel = {
  projects: [],
  threads: [],
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
      worktreePath: null,
      verification: { state: "off" },
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
const makeWatchdog = (
  dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  model: OrchestrationReadModel = readModel,
  workspace = Layer.mock(CardWorkspace)({ serviceHealth: () => Effect.succeed([]) }),
  events: Stream.Stream<OrchestrationEvent> = Stream.never,
) =>
  CardWatchdog.layer.pipe(
    Layer.provide(workspace),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
        subscribeDomainEvents: Effect.succeed(events),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getCommandReadModel: () => Effect.succeed(model),
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

it.effect("interrupts a running turn past 120% of its project's monthly budget and pauses its card", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const overBudget = (totalUsd: number) =>
      ({
        ...readModel,
        projects: [
          {
            id: ProjectId.make("project-watchdog"),
            orchestration: {
              ...DEFAULT_PROJECT_ORCHESTRATION,
              budgets: { projectUsd: 10, perAgentUsd: null, cardDefaultUsd: 5 },
            },
            // The test clock starts at the epoch, so this is the current month.
            spend: { month: "1970-01", totalUsd, byAgent: [] },
          },
        ],
        threads: [{ id: threadId, session: { status: "running", activeTurnId: "turn-over" } }],
      }) as unknown as OrchestrationReadModel;

    // At 110% the turn finishes; only new turns wait.
    yield* Effect.gen(function* () {
      const watchdog = yield* CardWatchdog.CardWatchdog;
      yield* watchdog.start();
      yield* watchdog.drain;
      expect(yield* Ref.get(dispatched)).toEqual([]);
    }).pipe(Effect.provide(makeWatchdog(dispatched, overBudget(11))), Effect.scoped);

    yield* Effect.gen(function* () {
      const watchdog = yield* CardWatchdog.CardWatchdog;
      yield* watchdog.start();
      const commands = yield* Ref.get(dispatched).pipe(Effect.repeat({ until: (all) => all.length >= 2 }));
      expect(commands).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId, commandId: `card-watchdog-budget:${threadId}:turn-over` }),
        expect.objectContaining({
          type: "card.pause.system",
          cardId,
          reason: { code: "budgetBreaker", text: "This project reached its $10 monthly budget; raise it in project settings." },
        }),
      ]);
    }).pipe(Effect.provide(makeWatchdog(dispatched, overBudget(12))), Effect.scoped);
  }),
);

it.effect("reports a card's service down for a minute on its tick, restarts it, and says when it is back", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    let up = false;
    const reviewModel = {
      projects: [],
      threads: [],
      cards: [
        {
          ...readModel.cards![0]!,
          id: CardId.make("card-review"),
          status: "inReview",
          worktreePath: "/tmp/card-review",
        },
      ],
      liveRuns: [],
    } as unknown as OrchestrationReadModel;
    const workspace = Layer.mock(CardWorkspace)({
      serviceHealth: () =>
        Effect.sync(() => [{ kind: "service" as const, name: "api", port: 42_000, up }]),
      ensureServices: () =>
        Effect.sync(() => {
          up = true;
        }),
    });
    yield* Effect.gen(function* () {
      const watchdog = yield* CardWatchdog.CardWatchdog;
      yield* watchdog.start();
      yield* watchdog.drain;
      expect(yield* Ref.get(dispatched)).toEqual([]);

      // The next tick finds it down a minute: reported, restarted, and back.
      yield* TestClock.adjust("1 minute");
      const commands = yield* Ref.get(dispatched).pipe(
        Effect.repeat({ until: (all) => all.length >= 2 }),
      );
      expect(recorded(commands)).toEqual([
        ["error", "serviceDown", null],
        ["message", "serviceRestored", null],
      ]);

      yield* TestClock.adjust("2 minutes");
      yield* watchdog.drain;
      expect(yield* Ref.get(dispatched)).toHaveLength(2);
    }).pipe(Effect.provide(makeWatchdog(dispatched, reviewModel, workspace)), Effect.scoped);
  }),
);

it.effect("restarts a card's services and its stopped preview when a person asks, and says they are back", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const calls: Array<string> = [];
    const workspace = Layer.mock(CardWorkspace)({
      serviceHealth: () =>
        Effect.succeed([{ kind: "preview" as const, name: "dev", port: 42_003, up: false }]),
      ensureServices: (id) =>
        Effect.sync(() => {
          calls.push(`ensureServices:${id}`);
        }),
      runScript: ({ cardId: id, scriptId }) =>
        Effect.sync(() => {
          calls.push(`runScript:${id}:${scriptId}`);
          return { terminalId: `script-${scriptId}` };
        }),
    });
    const requested = {
      type: "card.services-restart-requested",
      payload: { cardId, requestedAt: EPOCH },
    } as unknown as OrchestrationEvent;
    const noOwners = { ...readModel, liveRuns: [] } as unknown as OrchestrationReadModel;
    yield* Effect.gen(function* () {
      const watchdog = yield* CardWatchdog.CardWatchdog;
      yield* watchdog.start();
      const commands = yield* Ref.get(dispatched).pipe(
        Effect.repeat({ until: (all) => all.length >= 1 }),
      );
      expect(recorded(commands)).toEqual([["message", "serviceRestored", null]]);
      expect(calls).toEqual([`ensureServices:${cardId}`, `runScript:${cardId}:dev`]);
    }).pipe(
      Effect.provide(makeWatchdog(dispatched, noOwners, workspace, Stream.make(requested))),
      Effect.scoped,
    );
  }),
);
