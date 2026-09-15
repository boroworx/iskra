import {
  CardId,
  ProjectId,
  type OrchestrationCard,
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

import { ProcessRunner } from "../processRunner.ts";
import { CardWorkspace } from "./CardWorkspace.ts";
import * as OutcomeReactor from "./OutcomeReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-outcomes");

const finished = (id: string, fields: Partial<OrchestrationCard>) =>
  ({
    id: CardId.make(id),
    projectId,
    status: "landed",
    outcome: null,
    paused: null,
    landing: null,
    landedSha: `${id}-sha`,
    revertsCardId: null,
    spec: "",
    updatedAt: EPOCH,
    ...fields,
  }) as OrchestrationCard;

/**
 * The reactor over fakes: a read model whose outcomes follow the commands it records, git that
 * finds nothing, and no domain events, so only its daily tick drives it.
 */
const makeLayer = (dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) => {
  const cards = [
    finished("card-reverted", {}),
    finished("card-revert", { landedSha: null, revertsCardId: CardId.make("card-reverted") }),
    finished("card-stuck", {
      status: "abandoned",
      landedSha: null,
      paused: { reason: { code: "fixRoundsExhausted", text: "Out of rounds." }, by: { kind: "system", id: "system" }, pausedAt: EPOCH } as never,
    }),
    finished("card-quiet", {}),
  ];
  const model = () =>
    ({
      projects: [{ id: projectId, workspaceRoot: "/tmp/outcomes" }],
      cards,
    }) as unknown as OrchestrationReadModel;
  return OutcomeReactor.layer.pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (command.type !== "card.outcome.record") return;
                const index = cards.findIndex((card) => card.id === command.cardId);
                cards[index] = { ...cards[index]!, outcome: command.outcome };
              }),
            ),
            Effect.as({ sequence: 0 }),
          ),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getCommandReadModel: () => Effect.sync(model),
        getCardActivity: () => Effect.succeed({ activities: [], hasMore: false } as never),
        getProjectShellById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(CardWorkspace)({
        projectFile: () =>
          Effect.succeed({ baseBranch: "main", baseRef: "origin/main", file: null, checks: [] }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProcessRunner)({
        run: () => Effect.succeed({ stdout: "", stderr: "", code: 1 } as never),
      }),
    ),
  );
};

const recorded = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) =>
    command.type === "card.outcome.record"
      ? [command.cardId, command.outcome.state]
      : command.type === "card.activity.record"
        ? [command.cardId, command.reason?.code ?? null, command.deliverTo]
        : [command.type],
  );

it.effect("judges a reverted card flawed and a failed one blocked at once, and a quiet one a success after seven days", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    yield* Effect.gen(function* () {
      const reactor = yield* OutcomeReactor.OutcomeReactor;
      yield* reactor.start();

      const first = yield* Ref.get(dispatched).pipe(Effect.repeat({ until: (all) => all.length >= 3 }));
      expect(recorded(first)).toEqual([
        ["card-reverted", "flawed"],
        // A flawed card asks a person for a hidden scenario, through Needs you.
        ["card-reverted", "outcomeFlawed", null],
        ["card-stuck", "blocked"],
      ]);

      yield* TestClock.adjust("6 days");
      yield* reactor.drain;
      expect(yield* Ref.get(dispatched)).toHaveLength(3);

      yield* TestClock.adjust("1 day");
      const all = yield* Ref.get(dispatched).pipe(Effect.repeat({ until: (commands) => commands.length >= 4 }));
      expect(recorded(all).slice(3)).toEqual([["card-quiet", "success"]]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  }).pipe(Effect.scoped),
);
