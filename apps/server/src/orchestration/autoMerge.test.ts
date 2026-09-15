import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCard,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as CardLandingReactor from "./CardLandingReactor.ts";
import {
  AUTO_MERGE_NEEDS_VERIFIED_REASON,
  AUTO_MERGE_OFF_REASON,
  autoMergeSatisfactionReason,
  landingBeginRefusal,
  REVIEW_EVIDENCE_REASON,
  TRIGGER_WORK_WAITS_REASON,
} from "./cardRules.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

type AutoMergeCard = Parameters<typeof landingBeginRefusal>[0]["card"];

const eligible: AutoMergeCard = {
  evidence: {
    evidenceId: "evidence-1",
    headSha: "abc1234",
    purpose: "review",
    passed: true,
    checkCount: 1,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: now,
  },
  baseBranch: null,
  verification: {
    state: "passed",
    headSha: "abc1234",
    verdictId: "verdict-1",
    verifier: null,
    satisfaction: { satisfied: 9, total: 10 },
    override: null,
  },
  unattended: false,
  origin: { kind: "human", id: null },
  createdBy: { kind: "human", id: "human" },
  attemptGroupId: null,
};
const policy = { checksWaived: false, autoMerge: { enabled: true, minSatisfaction: 0.9 } };
const verification = (fields: Partial<OrchestrationCard["verification"]>) => ({
  verification: { ...eligible.verification, ...fields },
});

describe("auto-merge refusals", () => {
  it.each([
    ["an eligible card", {}, policy, null],
    ["auto-merge off", {}, { ...policy, autoMerge: { enabled: false, minSatisfaction: 0.9 } }, AUTO_MERGE_OFF_REASON],
    ["trigger work", { origin: { kind: "trigger", id: "nightly" } }, policy, TRIGGER_WORK_WAITS_REASON],
    ["unattended work", { unattended: true }, policy, TRIGGER_WORK_WAITS_REASON],
    ["failing evidence", { evidence: { ...eligible.evidence!, passed: false } }, policy, REVIEW_EVIDENCE_REASON],
    ["a verifier still running", verification({ state: "running" }), policy, AUTO_MERGE_NEEDS_VERIFIED_REASON],
    ["an override", verification({ state: "overridden", override: { reason: "Looks fine.", at: now } }), policy, AUTO_MERGE_NEEDS_VERIFIED_REASON],
    ["a pass on an older commit", verification({ headSha: "old0000" }), policy, AUTO_MERGE_NEEDS_VERIFIED_REASON],
    ["no hidden scenario ran", verification({ satisfaction: null }), policy, AUTO_MERGE_NEEDS_VERIFIED_REASON],
    ["zero hidden scenarios", verification({ satisfaction: { satisfied: 0, total: 0 } }), policy, AUTO_MERGE_NEEDS_VERIFIED_REASON],
    ["too few scenarios satisfied", verification({ satisfaction: { satisfied: 8, total: 10 } }), policy, autoMergeSatisfactionReason(8, 10, 90)],
  ] as const)("%s", (_name, fields, projectPolicy, expected) => {
    expect(
      landingBeginRefusal({
        card: { ...eligible, ...fields } as AutoMergeCard,
        parent: undefined,
        policy: projectPolicy,
        reason: "autoMergePolicy",
        verificationRequired: true,
      }),
    ).toBe(expected);
  });
});

// Different bytes on every call, so each generated event id is new.
let randomCalls = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    randomCalls += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, randomCalls);
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

const layer = CardLandingReactor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(CardWorkspace.CardWorkspace)({
        projectFile: () => Effect.succeed({ baseBranch: "main", baseRef: "main", file: null, checks: [] }),
        land: () =>
          Effect.succeed({ kind: "landed", baseBranch: "main", files: [], landedSha: "abc1234" } as CardWorkspace.CardLandResult),
        changedFiles: () => Effect.succeed([]),
        openCardChangedFiles: () => Effect.succeed([]),
      }),
      Layer.mock(GitVcsDriver)({}),
      Layer.mock(SourceControlProviderRegistry)({}),
      Layer.mock(PullRequestService)({}),
      Layer.mock(ProcessRunner)({}),
    ),
  ),
  Layer.provideMerge(OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive))),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-auto-merge-test-" })),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("auto-merge landing", (it) => {
  it.effect("waits for a verified pass with a hidden scenario, then lands with no person's command", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reactor = yield* CardLandingReactor.CardLandingReactor;
      yield* reactor.start();
      const nextEvent = nextEventOn(yield* engine.subscribeDomainEvents);
      const projectId = ProjectId.make("project-auto-merge");
      const agentId = AgentId.make("agent-auto-merge");
      const cardId = CardId.make("card-auto-merge");
      let commands = 0;
      const commandId = () => CommandId.make(`cmd-auto-merge-${(commands += 1)}`);
      const statusOf = snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.map((model) => model.cards?.find((card) => card.id === cardId)?.status));

      yield* engine.dispatch({ type: "project.create", commandId: commandId(), projectId, title: "auto", workspaceRoot: "/tmp/auto-merge", createdAt: now });
      yield* engine.dispatch({
        type: "project.orchestration.set",
        commandId: commandId(),
        projectId,
        orchestration: {
          ...DEFAULT_PROJECT_ORCHESTRATION,
          landing: "local",
          autoMerge: { enabled: true, minSatisfaction: 0.5 },
          verifier: { mode: "on" },
          sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
        },
      });
      yield* engine.dispatch({
        type: "agent.create",
        commandId: commandId(),
        agentId,
        projectId,
        name: "builder",
        roleTags: [],
        rolePrompt: "",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
        capabilities: ["read", "write"],
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "card.create",
        commandId: commandId(),
        cardId,
        projectId,
        title: "Auto",
        spec: "Do it.",
        tags: [],
        criteria: [{ id: "c1", text: "It works.", verification: "automated" }],
        createdAt: now,
      });
      yield* engine.dispatch({ type: "card.approve", commandId: commandId(), cardId });
      yield* engine.dispatch({ type: "card.spec.skip", commandId: commandId(), cardId });
      yield* engine.dispatch({ type: "card.assign", commandId: commandId(), cardId, agentId });
      yield* engine.dispatch({ type: "card.workspace.set", commandId: commandId(), cardId, branch: "iskra/auto", worktreePath: "/tmp/worktrees/auto", portBase: 42000 });
      yield* engine.dispatch({ type: "card.work.start", commandId: commandId(), cardId });
      yield* engine.dispatch({
        type: "card.evidence.record",
        commandId: commandId(),
        cardId,
        evidenceId: "evidence-auto",
        headSha: "abc1234",
        purpose: "review",
        items: [
          { itemId: "check:test", kind: "check", source: "local", name: "test", criterionId: null, exitCode: 0, timedOut: false, durationMs: 1, logTail: "ok", artifactPath: null, unavailable: null },
        ],
        flags: [],
        risks: null,
        recordedAt: now,
      });
      yield* engine.dispatch({ type: "card.review.enter", commandId: commandId(), cardId, headSha: "abc1234" });
      yield* nextEvent("card.landing-linked", (event) => event.payload.cardId === cardId);
      yield* reactor.drain;
      // Evidence alone isn't enough: without a verified pass the card waits in review.
      expect(yield* statusOf).toBe("inReview");

      yield* engine.dispatch({
        type: "card.verifier.select",
        commandId: commandId(),
        cardId,
        headSha: "abc1234",
        verifier: {
          agentId,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
          reason: { code: "sameModelVerifier", text: "Only the builder's model can check it." },
        },
      });
      yield* engine.dispatch({
        type: "card.verdict.record",
        commandId: commandId(),
        verdictId: "verdict-auto",
        cardId,
        headSha: "abc1234",
        criteria: [{ criterionId: "c1", pass: true, evidence: "test", note: "" }],
        diffJudge: { matchesCriteria: true, concerns: [] },
        scenarios: [{ scenarioId: "holdout-1", satisfied: true }],
        recordedAt: now,
      });
      const landing = yield* nextEvent(
        "card.status-changed",
        (event) => event.payload.cardId === cardId && event.payload.to === "landing",
      );
      expect(landing.payload).toMatchObject({ move: "beginLanding" });
      yield* nextEvent("card.status-changed", (event) => event.payload.cardId === cardId && event.payload.to === "landed");
      expect(yield* statusOf).toBe("landed");
    }),
  );
});
