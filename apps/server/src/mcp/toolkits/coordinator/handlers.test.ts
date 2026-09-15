import {
  AgentId,
  CardId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCard,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationRun,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { COORDINATOR_OWN_CHILDREN_REASON } from "../../../orchestration/planRules.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CoordinatorToolkitHandlersLive } from "./handlers.ts";
import { CoordinatorToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("card-session-coordinate-1");
const PLAN_ID = CardId.make("card-plan");

const run = (role: OrchestrationRun["role"]) =>
  ({
    threadId: THREAD_ID,
    role,
    cardId: PLAN_ID,
    agentId: AgentId.make("agent-coordinator"),
  }) as unknown as OrchestrationRun;

const child = (id: string, parentCardId: string, planKey: string) =>
  ({
    id: CardId.make(id),
    parentCardId: CardId.make(parentCardId),
    planKey,
  }) as unknown as OrchestrationCard;

// "api" is this plan's child; "web" belongs to another plan, and so does the other "api".
const readModel = {
  cards: [
    child("card-api", PLAN_ID, "api"),
    child("card-web", "card-other-plan", "web"),
    child("card-other-api", "card-other-plan", "api"),
  ],
  agents: [],
} as unknown as OrchestrationReadModel;

type ToolName = keyof typeof CoordinatorToolkit.tools;

const makeHarness = (
  options: { readonly role?: OrchestrationRun["role"]; readonly capability?: boolean } = {},
) => {
  const commands: Array<OrchestrationCommand> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getRunByThreadId: (threadId) =>
        Effect.succeed(
          threadId === THREAD_ID ? Option.some(run(options.role ?? "coordinator")) : Option.none(),
        ),
      getCommandReadModel: () => Effect.succeed(readModel),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => (commands.push(command), { sequence: commands.length })),
      readEvents: () => Stream.empty,
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const call = (name: ToolName, params: unknown) =>
    Effect.gen(function* () {
      const toolkit = yield* CoordinatorToolkit;
      return yield* toolkit.handle(name, params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)!.result),
      );
    }).pipe(
      Effect.provide(CoordinatorToolkitHandlersLive.pipe(Layer.provide(dependencies))),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(
          options.capability === false ? (["board"] as const) : (["coordinator"] as const),
        ),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { commands, call };
};

describe("coordinator toolkit handlers", () => {
  it.effect(
    "reaches only its own plan's children, and only from the plan's coordinator session",
    () =>
      Effect.gen(function* () {
        const noCapability = makeHarness({ capability: false });
        expect(
          yield* noCapability
            .call("message_child", { childKey: "api", body: "Use the shared client." })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
        });
        const owner = makeHarness({ role: "owner" });
        expect(
          yield* owner
            .call("pause_child", { childKey: "api", reason: "Wrong approach." })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "CoordinatorSessionRequiredError",
        });

        const coordinator = makeHarness();
        for (const [name, params] of [
          ["message_child", { childKey: "web", body: "Use the shared client." }],
          ["pause_child", { childKey: "web", reason: "Wrong approach." }],
          ["read_child_worklog", { childKey: "web" }],
        ] as const) {
          expect(yield* coordinator.call(name, params).pipe(Effect.flip)).toMatchObject({
            _tag: "CoordinatorCommandRefusedError",
            detail: COORDINATOR_OWN_CHILDREN_REASON,
          });
        }
        expect([...owner.commands, ...noCapability.commands, ...coordinator.commands]).toEqual([]);

        yield* coordinator.call("message_child", {
          childKey: "api",
          body: "Use the shared client.",
        });
        yield* coordinator.call("pause_child", { childKey: "api", reason: "Wrong approach." });
        expect(coordinator.commands).toMatchObject([
          {
            type: "card.coordinator.message",
            cardId: "card-api",
            planCardId: PLAN_ID,
            body: "Use the shared client.",
          },
          {
            type: "card.coordinator.pause",
            cardId: "card-api",
            planCardId: PLAN_ID,
            reason: "Wrong approach.",
          },
        ]);
      }),
  );

  it.effect(
    "proposes the plan on the session's own plan card, numbering criteria and defaulting slices",
    () =>
      Effect.gen(function* () {
        const coordinator = makeHarness();
        yield* coordinator.call("propose_plan", {
          premise: "The API first, then the page.",
          children: [
            {
              key: "api",
              title: "Health endpoint",
              spec: "GET /health.",
              criteria: [{ text: "GET /health returns ok" }],
              suggestedAgent: "@backend",
            },
            {
              key: "ui",
              title: "Status page",
              spec: "Show it.",
              criteria: [{ text: "The page shows ok", verification: "manual" }],
              dependsOn: ["api"],
              slice: 2,
            },
          ],
        });
        expect(coordinator.commands).toMatchObject([
          {
            type: "card.plan.propose",
            cardId: PLAN_ID,
            children: [
              {
                key: "api",
                criteria: [{ id: "c1", text: "GET /health returns ok", verification: "automated" }],
                suggestedAgent: "backend",
                dependsOn: [],
                slice: 1,
              },
              {
                key: "ui",
                criteria: [{ id: "c1", verification: "manual" }],
                suggestedAgent: null,
                dependsOn: ["api"],
                slice: 2,
              },
            ],
          },
        ]);
      }),
  );
});
