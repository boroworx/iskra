import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProjectId,
  ProviderInstanceId,
  type ProjectScript,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as CardReviewReactor from "./CardReviewReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import type { ProjectCheck } from "./ProjectFile.ts";
import { makeGitRepo, nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

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

const check = (id: string): ProjectCheck => ({
  id,
  name: id,
  command: `pnpm ${id}`,
  timeoutMinutes: 10,
  source: "local",
  ciName: null,
  targetedCommand: null,
  heavy: true,
});

const runScript: ProjectScript = {
  id: "dev",
  name: "dev",
  command: "pnpm dev",
  icon: "play",
  runOnWorktreeCreate: false,
  role: "run",
};

/** What the fakes answer, set by each test before it asks for review. */
const fakes = {
  checks: [check("test")] as ReadonlyArray<ProjectCheck>,
  passes: true,
  webPort: null as number | null,
  previewHost: true,
  admitted: [] as Array<HostAdmission.HeavyJobKind>,
};

const workspace = Layer.mock(CardWorkspace.CardWorkspace)({
  start: () => Effect.void,
  projectFile: () =>
    Effect.sync(() => ({
      baseBranch: "base",
      baseRef: "base",
      file:
        fakes.webPort === null
          ? null
          : ({ ports: { web: fakes.webPort } } as unknown as CardWorkspace.CardProjectFile["file"]),
      checks: fakes.checks,
    })),
  runChecks: (input) =>
    Effect.sync(() => ({
      passed: fakes.passes,
      summary: fakes.passes ? "test passed." : "test failed.",
      results: (input.checks ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        exitCode: fakes.passes ? 0 : 1,
        timedOut: false,
        durationMs: 5,
        logTail: fakes.passes ? "ok" : "FAIL limits.test.ts",
        logArtifactPath: null,
      })),
    })),
  runScript: () => Effect.succeed({ terminalId: "terminal-dev" }),
});

const admission = Layer.succeed(
  HostAdmission.HostAdmission,
  HostAdmission.HostAdmission.of({
    run: (job, effect) => Effect.andThen(Effect.sync(() => fakes.admitted.push(job.kind)), effect),
    snapshot: Effect.succeed({ running: [], waiting: [], memoryPressureSince: null }),
    cancelLowestPriority: Effect.succeed(null),
  }),
);

const broker = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
  invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
    fakes.previewHost
      ? Effect.succeed(
          (request.operation === "snapshot"
            ? {
                screenshot: {
                  mimeType: "image/png",
                  data: Buffer.from("png").toString("base64"),
                  width: 1,
                  height: 1,
                },
              }
            : {}) as A,
        )
      : Effect.fail(
          new PreviewAutomationNoAvailableHostError({
            operation: request.operation,
            environmentId: request.scope.environmentId,
            threadId: request.scope.threadId,
            providerSessionId: request.scope.providerSessionId,
            providerInstanceId: request.scope.providerInstanceId,
          }),
        ),
});

const environment = Layer.mock(ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-review")),
});

const layer = CardReviewReactor.layer.pipe(
  Layer.provide(Layer.mergeAll(workspace, admission, broker, environment)),
  Layer.provideMerge(OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive))),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-review-test-" })),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A card at work whose worktree is a real repository on `main`, based on a `base` branch, with the
 * review reactor running. `requestReview` records the intent exactly as the board tool does.
 */
const makeWorld = Effect.fn("makeWorld")(function* (
  name: string,
  options: { readonly ciFixRounds?: number; readonly checksWaived?: boolean } = {},
) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* CardReviewReactor.CardReviewReactor;
  yield* reactor.start();
  const events = yield* engine.subscribeDomainEvents;
  const nextEvent = nextEventOn(events);
  const repo = yield* makeGitRepo(`iskra-review-${name}-`);
  yield* repo.git("branch", "base");

  const projectId = ProjectId.make(`project-${name}`);
  const agentId = AgentId.make(`agent-${name}`);
  const cardId = CardId.make(`card-${name}`);
  let commands = 0;
  const commandId = () => CommandId.make(`cmd-${name}-${(commands += 1)}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: name,
    workspaceRoot: repo.root,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: commandId(),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      ciFixRounds: options.ciFixRounds ?? 2,
      checksWaived: options.checksWaived ?? false,
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
  });
  yield* engine.dispatch({
    type: "project.meta.update",
    commandId: commandId(),
    projectId,
    scripts: [runScript],
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: commandId(),
    agentId,
    projectId,
    name,
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
    title: `Card ${name}`,
    spec: "",
    tags: [],
    criteria: [{ id: "works", text: "It works.", verification: "automated" }],
    createdAt: now,
  });
  yield* engine.dispatch({ type: "card.approve", commandId: commandId(), cardId });
  yield* engine.dispatch({ type: "card.spec.skip", commandId: commandId(), cardId });
  yield* engine.dispatch({ type: "card.assign", commandId: commandId(), cardId, agentId });
  yield* engine.dispatch({
    type: "card.workspace.set",
    commandId: commandId(),
    cardId,
    branch: "main",
    worktreePath: repo.root,
    portBase: 42000,
  });
  yield* engine.dispatch({ type: "card.work.start", commandId: commandId(), cardId });

  const write = (file: string, text: string) =>
    repo.fileSystem.writeFileString(repo.path.join(repo.root, file), text);
  const requestReview = () =>
    engine.dispatch({
      type: "card.activity.record",
      commandId: commandId(),
      activityId: `review-request-${commands}`,
      cardId,
      kind: "message",
      author: { kind: "agent", id: agentId },
      body: "Done.\n\nRisks (claimed): side effects low, performance low, compatibility low.",
      runThreadId: null,
      deliverTo: null,
      elicitation: null,
      answers: null,
      status: null,
      evidenceId: null,
      reason: { code: "reviewRequested", text: "Asked for review." },
      createdAt: now,
    });
  const cardOf = () =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === cardId)!));
  const evidenceRecorded = () =>
    nextEvent("card.evidence-recorded", (event) => event.payload.cardId === cardId);
  const enteredReview = () =>
    nextEvent(
      "card.status-changed",
      (event) => event.payload.cardId === cardId && event.payload.to === "inReview",
    );
  const feedback = () =>
    nextEvent(
      "card.activity-recorded",
      (event) => event.payload.cardId === cardId && event.payload.deliverTo === "builder",
    );
  return {
    engine,
    reactor,
    repo,
    cardId,
    commandId,
    write,
    requestReview,
    cardOf,
    evidenceRecorded,
    enteredReview,
    feedback,
    nextEvent,
  };
});

const setFakes = (next: Partial<typeof fakes>) => Effect.sync(() => Object.assign(fakes, next));

it.layer(layer)("CardReviewReactor", (it) => {
  it.effect("commits leftovers, records passing evidence with the owner's claims, and enters review", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [check("test")], passes: true, webPort: null, admitted: [] });
      const world = yield* makeWorld("pass");
      yield* world.write("limits.ts", "export const LIMIT = 100;\n");
      yield* world.requestReview();

      const evidence = yield* world.evidenceRecorded();
      expect(evidence.payload).toMatchObject({
        purpose: "review",
        passed: true,
        flags: [],
        risks: { sideEffect: "low", performance: "low", compatibility: "low", notes: "" },
        items: [{ kind: "check", name: "test", exitCode: 0 }],
      });
      expect((yield* world.enteredReview()).payload.from).toBe("inProgress");
      // The leftover was committed, and the evidence names that commit.
      expect(yield* world.repo.git("status", "--porcelain")).toBe("");
      expect(evidence.payload.headSha).toBe(yield* world.repo.git("rev-parse", "HEAD"));
      expect(fakes.admitted).toContain("checks");
    }),
  );

  it.effect("sends failing checks back as a fix round, then pauses once the rounds are used", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [check("test")], passes: false, webPort: null });
      const world = yield* makeWorld("rounds", { ciFixRounds: 1 });
      yield* world.write("a.ts", "export const a = 1;\n");

      yield* world.requestReview();
      const note = yield* world.feedback();
      expect(note.payload.body).toContain("(fix round 1 of 1)");
      expect(note.payload.body).toContain("FAIL limits.test.ts");
      expect(note.payload.reason).toMatchObject({ code: "checksFailed" });
      yield* world.reactor.drain;
      expect(yield* world.cardOf()).toMatchObject({ status: "inProgress", fixRounds: { ci: 1 } });

      yield* world.requestReview();
      const paused = yield* world.nextEvent(
        "card.paused",
        (event) => event.payload.cardId === world.cardId,
      );
      expect(paused.payload.reason.code).toBe("fixRoundsExhausted");
      expect((yield* world.cardOf()).status).toBe("inProgress");
    }),
  );

  it.effect("enters review with a skipped test flagged, so the merge waits for a person", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [check("test")], passes: true, webPort: null });
      const world = yield* makeWorld("flags");
      yield* world.write("limits.test.ts", 'it.skip("limits", () => {});\n');
      yield* world.requestReview();

      const evidence = yield* world.evidenceRecorded();
      expect(evidence.payload.flags).toMatchObject([
        { kind: "skippedTest", path: "limits.test.ts", hard: true },
      ]);
      yield* world.enteredReview();
      const refused = yield* world.engine
        .dispatch({ type: "card.merge.approve", commandId: world.commandId(), cardId: world.cardId })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        detail: expect.stringContaining("Acknowledge the flagged changes"),
      });
    }),
  );

  it.effect("screenshots changed UI through a desktop host, and records it unavailable without one", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [check("test")], passes: true, webPort: 3, previewHost: true });
      const world = yield* makeWorld("preview");
      yield* world.write("Page.tsx", "export const Page = () => null;\n");
      yield* world.requestReview();
      const captured = yield* world.evidenceRecorded();
      expect(captured.payload.items[1]).toMatchObject({
        kind: "screenshot",
        source: "preview",
        unavailable: null,
        artifactPath: expect.stringContaining("card-evidence-card-preview"),
      });

      yield* setFakes({ previewHost: false });
      const other = yield* makeWorld("nohost");
      yield* other.write("Page.tsx", "export const Page = () => 1;\n");
      yield* other.requestReview();
      const missing = yield* other.evidenceRecorded();
      expect(missing.payload.items[1]).toMatchObject({
        kind: "screenshot",
        unavailable: { code: "noPreviewHost" },
      });
      // Missing UI evidence flags the card; it doesn't keep it out of review.
      yield* other.enteredReview();
      yield* setFakes({ previewHost: true });
    }),
  );

  it.effect("keeps a card without checks out of review and asks a person, unless checks are waived", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [], passes: true, webPort: null });
      const world = yield* makeWorld("nochecks");
      yield* world.write("a.ts", "export const a = 2;\n");
      yield* world.requestReview();
      const note = yield* world.feedback();
      expect(note.payload.body).toContain("This project has no checks.");
      const needsYou = yield* world.nextEvent(
        "card.activity-recorded",
        (event) => event.payload.cardId === world.cardId && event.payload.kind === "error",
      );
      expect(needsYou.payload.reason).toMatchObject({ code: "checksMissing" });
      expect((yield* world.cardOf()).status).toBe("inProgress");

      const waived = yield* makeWorld("waived", { checksWaived: true });
      yield* waived.write("a.ts", "export const a = 3;\n");
      yield* waived.requestReview();
      yield* waived.enteredReview();
    }),
  );

  it.effect("records a checkpoint's evidence without moving the card", () =>
    Effect.gen(function* () {
      yield* setFakes({ checks: [check("test")], passes: true, webPort: null });
      const world = yield* makeWorld("checkpoint");
      yield* world.write("a.ts", "export const a = 4;\n");
      yield* world.engine.dispatch({
        type: "card.checkpoint.request",
        commandId: world.commandId(),
        cardId: world.cardId,
        checkpoint: {
          checkpointId: "checkpoint-1",
          whatToTry: "Open the page.",
          question: null,
          evidenceId: null,
          requestedAt: now,
        },
      });
      const evidence = yield* world.evidenceRecorded();
      expect(evidence.payload).toMatchObject({ purpose: "checkpoint", passed: true });
      yield* world.reactor.drain;
      expect(yield* world.cardOf()).toMatchObject({
        status: "inProgress",
        checkpoint: { checkpointId: "checkpoint-1" },
      });
    }),
  );
});
