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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as CardWorkspace from "../../../orchestration/CardWorkspace.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as HostAdmission from "../../../orchestration/HostAdmission.ts";
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

const leadRun = {
  ...ownerRun("lead"),
  channelId: CHANNEL_ID,
  cardId: null,
  triggerMessageId: "message-export",
} as unknown as OrchestrationRun;

const card = { id: CARD_ID, projectId: PROJECT_ID, channelId: CHANNEL_ID } as OrchestrationCardShell;

const channelShell = { id: CHANNEL_ID, projectId: PROJECT_ID } as unknown as OrchestrationChannelShell;

const reviewInput = {
  summary: "Adds a token bucket per key.",
  risks: { sideEffect: "low", performance: "medium", compatibility: "low", notes: "" },
} as const;

const triageInput = {
  title: "Limit webhook calls",
  spec: "Webhooks need their own limit.",
  reasoning: "Asked for in #api; the open card leaves webhooks out.",
  criteria: [
    { text: "A webhook over its limit gets a 429." },
    { text: "The limit shows in the dashboard.", verification: "manual" },
  ],
  estimate: { size: "S", likelyAreas: ["apps/server/webhooks"], risks: [], split: null },
  premise: { goal: "Stop webhook floods.", getsThere: true, pushback: null },
} as const;

const makeHarness = Effect.fn("makeBoardToolkitHarness")(function* (
  options: {
    readonly run?: OrchestrationRun | null;
    readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
  } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const run = options.run === undefined ? ownerRun() : options.run;
  const planProgress = ThreadPlanProgress.make();
  // Resolves with the result a run_checks job hands the owner.
  const checksDelivered = yield* Deferred.make<OrchestrationCommand>();
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "card.activity.record" && command.reason?.code === "runChecksResult") {
        yield* Deferred.succeed(checksDelivered, command);
      }
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
    Layer.succeed(
      HostAdmission.HostAdmission,
      HostAdmission.HostAdmission.of({
        run: (_job, effect) => effect,
        snapshot: Effect.succeed({ running: [], waiting: [], memoryPressureSince: null }),
        cancelLowestPriority: Effect.succeed(null),
      }),
    ),
    Layer.mock(CardWorkspace.CardWorkspace)({
      runChecks: (input) =>
        Effect.succeed({
          passed: false,
          summary: "test failed.",
          results: [
            {
              id: "test",
              name: `test ${input.filter ?? ""}`.trim(),
              exitCode: 1,
              timedOut: false,
              durationMs: 4_200,
              logTail: "FAIL limits.test.ts\n",
              logArtifactPath: null,
            },
          ],
        }),
    }),
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
  return { commands, call, planProgress, checksDelivered };
});

describe("board toolkit handlers", () => {
  it("offers no tool that approves, assigns, moves or lands", () => {
    expect(Object.keys(BoardToolkit.tools)).toEqual([
      "propose_card",
      "record_decision",
      "update_plan",
      "run_checks",
      "request_review",
      "request_checkpoint",
      "ask_owner",
      "propose_criteria_change",
      "propose_triage_card",
      "ask_clarification",
    ]);
  });

  it.effect("works only for the session building a card", () =>
    Effect.gen(function* () {
      const withoutBoard = yield* makeHarness();
      expect(
        yield* withoutBoard.call("request_review", reviewInput, ["pull-requests"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "board" });

      for (const role of ["helper", "critic", "lead"] as const) {
        const other = yield* makeHarness({ run: ownerRun(role) });
        expect(
          yield* other.call("request_checkpoint", { whatToTry: "Open /limits" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "BoardSessionRequiredError" });
        expect(yield* Ref.get(other.commands)).toEqual([]);
      }
    }),
  );

  it.effect("proposes a card into triage as the session's agent, in its card's project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("propose_card", {
        title: "Rate limit webhooks",
        spec: "They share the API's limits.",
        criteria: [{ text: "Webhooks have their own limit." }],
        subCard: true,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "card.propose",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          channelId: CHANNEL_ID,
          parentCardId: CARD_ID,
          subCard: true,
          criteria: [{ id: "c1", text: "Webhooks have their own limit.", verification: "automated" }],
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
            detail: "Only a card in progress can ask for a checkpoint.",
          }),
      });
      const refusal = yield* refusing
        .call("request_checkpoint", { whatToTry: "Open /limits" })
        .pipe(Effect.flip);
      expect(refusal.message).toBe("Only a card in progress can ask for a checkpoint.");
    }),
  );

  it.effect("shows the plan's current step and records the plan on the card", () =>
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
        { type: "thread.activity.append", threadId: THREAD_ID, activity: { kind: "turn.plan.updated" } },
        {
          type: "card.activity.record",
          cardId: CARD_ID,
          kind: "plan",
          author: { kind: "agent", id: AGENT_ID },
          body: "- [x] Add the limiter\n- [~] Wire it into the router\n- [ ] Test it",
        },
      ]);
    }),
  );

  it.effect("asks the owner a question with a recommended answer, on the card and the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { requestId } = yield* harness.call("ask_owner", {
        question: "Per key or per account?",
        options: ["Per key", "Per account"],
        recommended: "Per key",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "card.activity.record",
          activityId: requestId,
          kind: "elicitation",
          deliverTo: null,
          elicitation: {
            question: "Per key or per account?",
            options: [
              { id: "o1", label: "Per key" },
              { id: "o2", label: "Per account" },
            ],
            recommendedOptionId: "o1",
            allowText: true,
          },
        },
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
                  options: [
                    { label: "Per key", description: "Recommended" },
                    { label: "Per account", description: "" },
                  ],
                },
              ],
            },
          },
        },
      ]);
    }),
  );

  it.effect("runs the checks through the machine's queue and hands the result to the owner's next turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("run_checks", { scope: "targeted", filter: "limits" });
      expect(result.position).toBe(0);
      expect(result.jobId).toMatch(/^run-checks-/);

      const delivered = yield* Deferred.await(harness.checksDelivered);
      expect(delivered).toMatchObject({
        type: "card.activity.record",
        activityId: result.jobId,
        cardId: CARD_ID,
        author: { kind: "system" },
        deliverTo: "builder",
        runThreadId: THREAD_ID,
        body: "run_checks (targeted) failed.\n- test limits: exit 1 in 4s\n```\nFAIL limits.test.ts\n```",
      });

      const helper = yield* makeHarness({ run: ownerRun("helper") });
      expect(yield* helper.call("run_checks", { scope: "full" }).pipe(Effect.flip)).toMatchObject({
        _tag: "BoardSessionRequiredError",
      });
    }),
  );

  it.effect("records a review request and a checkpoint as intent, never as a status move", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("request_review", reviewInput);
      yield* harness.call("request_checkpoint", { whatToTry: "Open /limits", question: "Right shape?" });
      yield* harness.call("propose_criteria_change", {
        criteria: [{ text: "Limits are per account." }],
        reason: "Keys are shared across an account.",
      });
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).not.toContain("card.review.request");
      expect(commands).toMatchObject([
        {
          type: "card.activity.record",
          kind: "message",
          deliverTo: null,
          reason: { code: "reviewRequested" },
          body: "Adds a token bucket per key.\n\nRisks (claimed): side effects low, performance medium, compatibility low.",
        },
        {
          type: "card.checkpoint.request",
          cardId: CARD_ID,
          checkpoint: { whatToTry: "Open /limits", question: "Right shape?", evidenceId: null },
        },
        {
          type: "card.activity.record",
          kind: "elicitation",
          reason: { code: "criteriaChange" },
          body: "Keys are shared across an account.\n\nProposed acceptance criteria:\n- Limits are per account.",
        },
      ]);
    }),
  );

  it.effect("lets a channel lead propose a triage card from the message that woke it, and nothing else", () =>
    Effect.gen(function* () {
      const lead = yield* makeHarness({ run: leadRun });
      yield* lead.call(
        "propose_triage_card",
        { ...triageInput, likelyDuplicateCardIds: ["card-limits"], suggestedAgent: "frontend" },
        ["lead"],
      );
      expect(yield* Ref.get(lead.commands)).toMatchObject([
        {
          type: "card.propose",
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          channelId: CHANNEL_ID,
          criteria: [
            { id: "c1", verification: "automated" },
            { id: "c2", verification: "manual" },
          ],
          estimate: { size: "S" },
          premise: { getsThere: true },
          lead: {
            sourceMessageId: "message-export",
            likelyDuplicateCardIds: ["card-limits"],
            suggestedAgentName: "frontend",
          },
        },
      ]);
      expect(
        yield* lead.call("propose_card", { title: "Other", spec: "" }, ["lead"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "board" });

      const owner = yield* makeHarness();
      expect(
        yield* owner.call("propose_triage_card", triageInput).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "lead" });
      expect(
        yield* owner
          .call("ask_clarification", { question: "Which?", options: ["A", "B"], recommended: "A" }, ["lead"])
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "LeadSessionRequiredError" });
    }),
  );

  it.effect("posts a lead's clarifying question in its channel with answers to pick", () =>
    Effect.gen(function* () {
      const lead = yield* makeHarness({ run: leadRun });
      const { messageId } = yield* lead.call(
        "ask_clarification",
        { question: "Per key or per account?", options: ["Per key", "Per account"], recommended: "Per account" },
        ["lead"],
      );
      expect(yield* Ref.get(lead.commands)).toMatchObject([
        {
          type: "channel.message.agent.post",
          channelId: CHANNEL_ID,
          messageId,
          agentId: AGENT_ID,
          runThreadId: THREAD_ID,
          body: "Per key or per account?",
          elicitation: { recommendedOptionId: "o2", allowText: true },
        },
      ]);
    }),
  );
});
