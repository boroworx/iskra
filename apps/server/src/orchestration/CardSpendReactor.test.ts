import {
  AgentId,
  CardId,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as CardSpendReactor from "./CardSpendReactor.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";

// A rate table of one model: output costs a tenth of a cent a token; anything else is unpriced.
const usageStub = Layer.mock(UsageService.UsageService)({
  priceTurn: ({ model, totals, reportedCostUsd }) =>
    Effect.succeed(
      reportedCostUsd !== null
        ? { costUsd: reportedCostUsd, costSource: "providerReported" as const }
        : model === "priced-model" && totals !== null
          ? { costUsd: totals.outputTokens * 0.001, costSource: "modelPriced" as const }
          : { costUsd: 0, costSource: "unpriced" as const },
    ),
});

const layer = CardSpendReactor.layer.pipe(
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
  ),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(Layer.mock(ProviderService)({ streamEvents: Stream.empty })),
  Layer.provide(usageStub),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-spend-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A card with an owner session on `model`, and a plain thread outside any card. */
const makeWorld = Effect.fn("makeWorld")(function* (name: string, model: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* CardSpendReactor.CardSpendReactor;
  const projectId = ProjectId.make(`project-${name}`);
  const agentId = AgentId.make(`agent-${name}`);
  const cardId = CardId.make(`card-${name}`);
  const ownerThreadId = ThreadId.make(`card-session-${name}`);
  const plainThreadId = ThreadId.make(`thread-${name}`);
  const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model };

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: name,
    workspaceRoot: `/tmp/${name}`,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: CommandId.make(`cmd-agent-${name}`),
    agentId,
    projectId,
    name,
    roleTags: [],
    rolePrompt: "",
    modelSelection,
    capabilities: ["read", "write"],
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "card.create",
    commandId: CommandId.make(`cmd-card-${name}`),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "",
    tags: [],
    createdAt: now,
  });
  for (const type of ["card.approve", "card.spec.skip"] as const) {
    yield* engine.dispatch({ type, commandId: CommandId.make(`cmd-${type}-${name}`), cardId });
  }
  yield* engine.dispatch({
    type: "card.assign",
    commandId: CommandId.make(`cmd-assign-${name}`),
    cardId,
    agentId,
  });
  yield* engine.dispatch({
    type: "card.workspace.set",
    commandId: CommandId.make(`cmd-workspace-${name}`),
    cardId,
    branch: `iskra/${name}`,
    worktreePath: `/tmp/worktrees/${name}`,
    portBase: 42000,
  });
  yield* engine.dispatch({
    type: "card.session.record",
    commandId: CommandId.make(`cmd-session-${name}`),
    threadId: ownerThreadId,
    cardId,
    agentId,
    role: "owner",
    capabilities: ["read", "write"],
    context: {
      agent: { id: agentId, name, rolePrompt: "" },
      role: "owner",
      card: { id: cardId, title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
      decisions: [],
      diff: "",
      diffTruncated: false,
      question: null,
    },
    rendered: { systemPrompt: "system", firstMessage: "brief" },
    startedAt: now,
  });
  for (const threadId of [ownerThreadId, plainThreadId]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${threadId}`),
      threadId,
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
  }

  const finished = (
    threadId: ThreadId,
    turnId: string,
    cost: { readonly totalCostUsd?: number; readonly outputTokens?: number },
  ) =>
    reactor.recordTurn({
      eventId: EventId.make(`event-${threadId}-${turnId}`),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId,
      createdAt: now,
      turnId: TurnId.make(turnId),
      type: "turn.completed",
      payload: {
        state: "completed",
        ...(cost.totalCostUsd === undefined ? {} : { totalCostUsd: cost.totalCostUsd }),
        ...(cost.outputTokens === undefined
          ? {}
          : {
              tokenUsage: {
                usageScope: "main_agent",
                usageStatus: "complete",
                inputTokens: 1_000,
                outputTokens: cost.outputTokens,
                hasSubagents: false,
              },
            }),
      },
    });

  const card = snapshotQuery
    .getCommandReadModel()
    .pipe(Effect.map((model) => (model.cards ?? []).find((candidate) => candidate.id === cardId)));
  const agentSpend = snapshotQuery
    .getAgentShellById(agentId)
    .pipe(Effect.map((agent) => Option.getOrThrow(agent).spentUsd));

  return { ownerThreadId, plainThreadId, finished, card, agentSpend };
});

it.layer(layer)("CardSpendReactor", (it) => {
  it.effect("records a card session turn's reported cost on its card and its agent, once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("reported", "any-model");
      yield* world.finished(world.ownerThreadId, "turn-1", { totalCostUsd: 1.25 });
      yield* world.finished(world.ownerThreadId, "turn-1", { totalCostUsd: 1.25 });
      yield* world.finished(world.ownerThreadId, "turn-2", { totalCostUsd: 0.5 });

      expect(yield* world.card).toMatchObject({ spentUsd: 1.75, unpricedTurns: 0 });
      expect(yield* world.agentSpend).toBe(1.75);
    }),
  );

  it.effect("prices a turn's tokens when no cost is reported", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("priced", "priced-model");
      yield* world.finished(world.ownerThreadId, "turn-1", { outputTokens: 500 });

      expect(yield* world.card).toMatchObject({ spentUsd: 0.5, unpricedTurns: 0 });
    }),
  );

  it.effect("counts a turn on a model with no price, and ignores threads outside cards", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("unpriced", "mystery-model");
      yield* world.finished(world.ownerThreadId, "turn-1", { outputTokens: 500 });
      yield* world.finished(world.plainThreadId, "turn-1", { totalCostUsd: 3 });

      expect(yield* world.card).toMatchObject({ spentUsd: 0, unpricedTurns: 1 });
      expect(yield* world.agentSpend).toBe(0);
    }),
  );
});
