import {
  AgentId,
  CardId,
  ChannelId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCardShell,
  type OrchestrationChannelShell,
  type OrchestrationCommand,
  type OrchestrationRun,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BoardToolkitHandlersLive } from "./handlers.ts";
import { BoardToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("card-session-1");
const CARD_ID = CardId.make("card-limits");
const AGENT_ID = AgentId.make("agent-backend");
const PROJECT_ID = ProjectId.make("project-1");
const CHANNEL_ID = ChannelId.make("channel-api");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const ownerRun = (role: OrchestrationRun["role"] = "owner") =>
  ({
    threadId: THREAD_ID,
    role,
    channelId: null,
    cardId: CARD_ID,
    agentId: AGENT_ID,
    triggerMessageId: null,
    capabilities: ["read", "write"],
  }) as unknown as OrchestrationRun;

const card = { id: CARD_ID, projectId: PROJECT_ID, channelId: CHANNEL_ID } as OrchestrationCardShell;

const channelShell = { id: CHANNEL_ID, projectId: PROJECT_ID } as unknown as OrchestrationChannelShell;

const makeHarness = Effect.fn("makeBoardToolkitHarness")(function* (options: {
  readonly run?: OrchestrationRun | null;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
} = {}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const run = options.run === undefined ? ownerRun() : options.run;
  const planProgress = ThreadPlanProgress.make();
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getRunByThreadId: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.fromNullishOr(run) : Option.none()),
      getCardShellById: (cardId) =>
        Effect.succeed(cardId === CARD_ID ? Option.some(card) : Option.none()),
      getChannelShellById: (channelId) =>
        Effect.succeed(channelId === CHANNEL_ID ? Option.some(channelShell) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ThreadPlanProgress.ThreadPlanProgressService, planProgress),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* BoardToolkit.pipe(
    Effect.provide(BoardToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof BoardToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["board"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BoardToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { commands, call, planProgress };
});

describe("board toolkit handlers", () => {
  it("offers no tool that approves, assigns or lands", () => {
    expect(Object.keys(BoardToolkit.tools)).toEqual([
      "propose_card",
      "record_decision",
      "update_plan",
      "request_review",
      "ask_owner",
      "propose_triage_card",
    ]);
  });

  it.effect("works only for the session building a card", () =>
    Effect.gen(function* () {
      const withoutBoard = yield* makeHarness();
      expect(
        yield* withoutBoard.call("request_review", {}, ["pull-requests"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "board" });

      const helper = yield* makeHarness({ run: ownerRun("helper") });
      expect(yield* helper.call("request_review", {}).pipe(Effect.flip)).toMatchObject({
        _tag: "BoardSessionRequiredError",
      });
      expect(yield* Ref.get(helper.commands)).toEqual([]);
    }),
  );

  it.effect("proposes a card into triage as the session's agent, in its card's project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("propose_card", {
        title: "Rate limit webhooks",
        spec: "They share the API's limits.",
        subCard: true,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "card.propose",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          channelId: CHANNEL_ID,
          parentCardId: CARD_ID,
          title: "Rate limit webhooks",
          tags: [],
        },
      ]);
    }),
  );

  it.effect("records a decision on its card, and passes a refusal's reason to the agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("record_decision", { text: "Use a token bucket." });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "card.decision.agent.record", cardId: CARD_ID, agentId: AGENT_ID },
      ]);

      const refusing = yield* makeHarness({
        reject: (command) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Only a card in progress can be sent to review.",
          }),
      });
      const refusal = yield* refusing.call("request_review", {}).pipe(Effect.flip);
      expect(refusal.message).toBe("Only a card in progress can be sent to review.");
    }),
  );

  it.effect("shows the plan's current step and logs the plan on the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("update_plan", {
        steps: [
          { step: "Add the limiter", status: "completed" },
          { step: "Wire it into the router", status: "inProgress" },
          { step: "Test it", status: "pending" },
        ],
      });
      expect(result).toEqual({ completedSteps: 1, totalSteps: 3 });
      expect(harness.planProgress.getThreadPlanProgress(THREAD_ID)).toEqual({
        step: "Wire it into the router",
        completedSteps: 1,
        totalSteps: 3,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.activity.append",
          threadId: THREAD_ID,
          activity: { kind: "turn.plan.updated" },
        },
      ]);
    }),
  );

  it.effect("asks the owner a question answered by message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { requestId } = yield* harness.call("ask_owner", {
        question: "Per key or per account?",
        options: ["Per key", "Per account"],
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.activity.append",
          threadId: THREAD_ID,
          activity: {
            kind: "user-input.requested",
            payload: {
              requestId,
              responseMode: "message",
              questions: [
                {
                  question: "Per key or per account?",
                  options: [{ label: "Per key" }, { label: "Per account" }],
                },
              ],
            },
          },
        },
      ]);
    }),
  );
  it.effect("lets a channel lead propose a triage card from the message that woke it, and nothing else", () =>
    Effect.gen(function* () {
      const leadRun = {
        ...ownerRun("lead"),
        channelId: CHANNEL_ID,
        cardId: null,
        triggerMessageId: "message-export",
      } as unknown as OrchestrationRun;
      const lead = yield* makeHarness({ run: leadRun });
      yield* lead.call(
        "propose_triage_card",
        {
          title: "Limit webhook calls",
          spec: "Webhooks need their own limit.",
          reasoning: "Asked for in #api; the open card leaves webhooks out.",
          likelyDuplicateCardIds: ["card-limits"],
        },
        ["lead"],
      );
      expect(yield* Ref.get(lead.commands)).toMatchObject([
        {
          type: "card.propose",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          channelId: CHANNEL_ID,
          lead: { sourceMessageId: "message-export", likelyDuplicateCardIds: ["card-limits"] },
        },
      ]);
      expect(
        yield* lead.call("propose_card", { title: "Other", spec: "" }, ["lead"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "board" });

      const owner = yield* makeHarness();
      expect(
        yield* owner
          .call("propose_triage_card", { title: "Other", spec: "", reasoning: "None." })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "lead" });
    }),
  );
});
