import {
  AgentId,
  CardId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type HoldoutScenario,
  type OrchestrationCardShell,
  type OrchestrationCommand,
  type OrchestrationRun,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { HoldoutStore } from "../../../orchestration/HoldoutStore.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VerifierToolkitHandlersLive } from "./handlers.ts";
import { VerifierToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("card-session-verify-1");
const CARD_ID = CardId.make("card-health");
const HEAD_SHA = "abc1234def";

const run = (role: OrchestrationRun["role"]) =>
  ({ threadId: THREAD_ID, role, cardId: CARD_ID, agentId: AgentId.make("agent-verifier") }) as unknown as OrchestrationRun;

const card = {
  id: CARD_ID,
  projectId: ProjectId.make("project-1"),
  verification: { state: "running", headSha: HEAD_SHA },
} as unknown as OrchestrationCardShell;

const scenarios: ReadonlyArray<HoldoutScenario> = [
  { scenarioId: "h1", title: "Health says ok", kind: "text", body: "GET /health returns the word ok", command: null, timeoutMinutes: 5 },
  { scenarioId: "h2", title: "Health is JSON", kind: "command", body: "", command: "node holdout-status.js", timeoutMinutes: 5 },
];

const makeHarness = (role: OrchestrationRun["role"]) => {
  const commands: Array<OrchestrationCommand> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getRunByThreadId: (threadId) => Effect.succeed(threadId === THREAD_ID ? Option.some(run(role)) : Option.none()),
      getCardShellById: () => Effect.succeed(Option.some(card)),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) => Effect.sync(() => (commands.push(command), { sequence: commands.length })),
      readEvents: () => Stream.empty,
    }),
    Layer.mock(HoldoutStore)({ list: () => Effect.succeed(scenarios) }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(3),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const call = (params: Parameters<Effect.Success<typeof VerifierToolkit>["handle"]>[1]) =>
    Effect.gen(function* () {
      const toolkit = yield* VerifierToolkit;
      return yield* toolkit.handle("record_verdict", params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof VerifierToolkit.tools)["record_verdict"]>),
      );
    }).pipe(
      Effect.provide(VerifierToolkitHandlersLive.pipe(Layer.provide(dependencies))),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(["verifier"] as const),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { commands, call };
};

const verdict = {
  criteria: [{ criterionId: "c1", pass: false, evidence: "ran node holdout-status.js", note: "GET /health returns the word ok as text" }],
  diffJudge: { matchesCriteria: true, concerns: [] },
  scenarios: [
    { scenarioId: "h1", satisfied: true },
    { scenarioId: "h2", satisfied: false },
  ],
};

describe("verifier toolkit handlers", () => {
  it.effect("records a verdict only from the card's verifier session, for the commit being verified, redacted", () =>
    Effect.gen(function* () {
      const owner = makeHarness("owner");
      expect(yield* owner.call(verdict).pipe(Effect.flip)).toMatchObject({ _tag: "VerifierSessionRequiredError" });
      expect(owner.commands).toEqual([]);

      const verifier = makeHarness("verifier");
      expect(
        yield* verifier.call({ ...verdict, scenarios: [{ scenarioId: "h1", satisfied: true }] }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "VerifierCommandRefusedError", detail: expect.stringContaining("missing h2") });

      yield* verifier.call(verdict);
      expect(verifier.commands).toMatchObject([
        {
          type: "card.verdict.record",
          cardId: CARD_ID,
          headSha: HEAD_SHA,
          criteria: [
            { criterionId: "c1", pass: false, evidence: "ran [hidden scenario h2]", note: "[hidden scenario h1] as text" },
          ],
          scenarios: verdict.scenarios,
        },
      ]);
    }),
  );
});
