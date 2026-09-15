// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  AgentId,
  CardId,
  ChannelId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  EnvironmentId,
  MessageId,
  PreviewAutomationNoAvailableHostError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AgentRole,
  type OrchestrationEvent,
  type ProjectScript,
  type ProviderRunRestrictions,
  type RunCapability,
  type ServerProvider,
} from "@iskra/contracts";
import * as Net from "@iskra/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { ServerConfig } from "../src/config.ts";
import { ServerEnvironment } from "../src/environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../src/mcp/PreviewAutomationBroker.ts";
import { BoardToolkitHandlersLive } from "../src/mcp/toolkits/board/handlers.ts";
import { BoardToolkit } from "../src/mcp/toolkits/board/tools.ts";
import { VerifierToolkitHandlersLive } from "../src/mcp/toolkits/verifier/handlers.ts";
import { VerifierToolkit } from "../src/mcp/toolkits/verifier/tools.ts";
import * as CardLandingReactor from "../src/orchestration/CardLandingReactor.ts";
import * as CardRefGuard from "../src/orchestration/CardRefGuard.ts";
import * as CardReviewReactor from "../src/orchestration/CardReviewReactor.ts";
import {
  OVERRIDE_REASON_REQUIRED,
  VERIFIER_NOT_PASSED_REASON,
} from "../src/orchestration/cardRules.ts";
import * as CardScheduler from "../src/orchestration/CardScheduler.ts";
import * as CardSessionReactor from "../src/orchestration/CardSessionReactor.ts";
import * as CardVerifierReactor from "../src/orchestration/CardVerifierReactor.ts";
import * as CardWatchdog from "../src/orchestration/CardWatchdog.ts";
import * as CardWorkspace from "../src/orchestration/CardWorkspace.ts";
import { HoldoutStore } from "../src/orchestration/HoldoutStore.ts";
import * as HostAdmission from "../src/orchestration/HostAdmission.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { makeGitRepo, now } from "../src/orchestration/reactor.testkit.ts";
import * as RunReactor from "../src/orchestration/RunReactor.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCardRepositoryLive } from "../src/persistence/Layers/ProjectionCards.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import { ProjectionCardRepository } from "../src/persistence/Services/ProjectionCards.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../src/provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { PullRequestService } from "../src/pullRequest/PullRequestService.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import { SourceControlProviderRegistry } from "../src/sourceControl/SourceControlProviderRegistry.ts";
import { AnalyticsService } from "../src/telemetry/AnalyticsService.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import { GitVcsDriver } from "../src/vcs/GitVcsDriver.ts";
import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";

/**
 * M2 acceptance: cards verified by a second agent on another provider, hidden scenarios that stay
 * hidden from the builder, fallbacks, override, agent instances waiting for a machine slot, the
 * provider refusal matrix, and the runtime's screenshot retry and service restart. The engine,
 * projections, workspaces (git and node processes in the OS temp dir), admission, reactors, holdout
 * store and MCP toolkits are real; provider sessions are reported the way a provider would, the
 * desktop preview host is a fake, and card terminals spawn plain child processes. Waits re-read state
 * after the next domain event, never on a timer; the clock is live because service readiness polls.
 */

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

const ENVIRONMENT_ID = EnvironmentId.make("environment-card-verify");
/** Everything a value says once serialized, for asserting what it never contains. */
const textOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const serverProvider = (instance: string, models: ReadonlyArray<string>, ready = true) =>
  ({
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make(instance),
    enabled: true,
    status: ready ? "ready" : "error",
    models: models.map((slug) => ({ slug, name: slug })),
  }) as unknown as ServerProvider;
const READY_PROVIDERS = [
  serverProvider("claudeAgent", ["claude-a", "claude-b"]),
  serverProvider("opencode", ["gpt-5"]),
];

/**
 * Card terminals as plain process groups: `write` runs the command, `close` kills what that
 * terminal started. Only processes this test spawned are ever killed.
 */
const makeTerminals = () => {
  const opened = new Map<string, { readonly cwd: string; readonly env: Record<string, string> }>();
  const children = new Map<string, NodeChildProcess.ChildProcess>();
  const keyOf = (threadId: string, terminalId: string) => `${threadId} ${terminalId}`;
  const stop = (key: string) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const child = children.get(key);
          children.delete(key);
          if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
            return resolve();
          }
          child.once("exit", () => resolve());
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            resolve();
          }
        }),
    );
  const stopAll = Effect.suspend(() =>
    Effect.forEach([...children.keys()], stop, { discard: true }),
  );
  const layer = Layer.mock(TerminalManager.TerminalManager)({
    open: (input: {
      threadId: string;
      terminalId?: string;
      cwd: string;
      env?: Record<string, string>;
    }) =>
      Effect.sync(() => {
        opened.set(keyOf(input.threadId, input.terminalId ?? "default"), {
          cwd: input.cwd,
          env: input.env ?? {},
        });
        return {} as never;
      }),
    write: (input: { threadId: string; terminalId?: string; data: string }) =>
      Effect.gen(function* () {
        const key = keyOf(input.threadId, input.terminalId ?? "default");
        yield* stop(key);
        const terminal = opened.get(key)!;
        const child = NodeChildProcess.spawn("sh", ["-c", input.data.replace(/\r$/, "")], {
          cwd: terminal.cwd,
          env: { ...process.env, ...terminal.env },
          stdio: "ignore",
          detached: true,
        });
        children.set(key, child);
      }),
    close: (input: { threadId: string; terminalId?: string }) =>
      Effect.forEach(
        [...children.keys()].filter((key) =>
          input.terminalId === undefined
            ? key.startsWith(`${input.threadId} `)
            : key === keyOf(input.threadId, input.terminalId),
        ),
        stop,
        { discard: true },
      ),
  } as never);
  return {
    layer,
    stop: (threadId: string, terminalId: string) => stop(keyOf(threadId, terminalId)),
    stopAll,
  };
};

/** Admits every heavy job, recording the kinds in order. */
const recordingAdmission = (admitted: Array<HostAdmission.HeavyJobKind>) =>
  Layer.effect(
    HostAdmission.HostAdmission,
    Effect.map(
      HostAdmission.make(Effect.succeed({ load1: 0, cores: 8, freeMemRatio: 1 })),
      (admission) =>
        HostAdmission.HostAdmission.of({
          ...admission,
          run: (job, effect) =>
            Effect.andThen(
              Effect.sync(() => void admitted.push(job.kind)),
              admission.run(job, effect),
            ),
        }),
    ),
  );

const makeLayer = (input: {
  readonly environmentSessionCap: number;
  readonly providers: { current: ReadonlyArray<ServerProvider> };
  readonly hosts: Queue.Queue<PreviewAutomationBroker.PreviewAutomationHostConnected>;
  readonly terminals: Layer.Layer<TerminalManager.TerminalManager>;
  readonly admitted: Array<HostAdmission.HeavyJobKind>;
}) => {
  // No desktop app answers: screenshots are recorded unavailable until a host connects.
  const preview = Layer.mergeAll(
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
        Effect.fail(
          new PreviewAutomationNoAvailableHostError({
            operation: request.operation,
            environmentId: request.scope.environmentId,
            threadId: request.scope.threadId,
            providerSessionId: request.scope.providerSessionId,
            providerInstanceId: request.scope.providerInstanceId,
          }),
        ) as Effect.Effect<A, PreviewAutomationNoAvailableHostError>,
      hostConnected: Stream.fromQueue(input.hosts),
    }),
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(ENVIRONMENT_ID) }),
  );
  // Local landing never reaches a pull request host.
  const noHost = Layer.mergeAll(
    Layer.mock(GitVcsDriver)({}),
    Layer.mock(SourceControlProviderRegistry)({}),
    Layer.mock(PullRequestService)({}),
  );
  return Layer.mergeAll(
    CardSessionReactor.layer,
    CardScheduler.layer,
    RunReactor.layer,
    CardReviewReactor.layer.pipe(Layer.provide(preview)),
    CardLandingReactor.layer.pipe(Layer.provide(noHost)),
    CardVerifierReactor.layer,
    CardWatchdog.layer,
  )
    .pipe(
      Layer.provideMerge(CardWorkspace.layer),
      Layer.provideMerge(CardRefGuard.layer),
      Layer.provideMerge(HoldoutStore.layer),
      Layer.provideMerge(recordingAdmission(input.admitted)),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => input.providers.current) }),
      ),
      Layer.provideMerge(
        OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
      ),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(ProjectionCardRepositoryLive),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
    )
    .pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-verify-" })),
      Layer.provideMerge(ProcessRunner.layer),
      Layer.provide(Net.layer),
      Layer.provide(input.terminals),
      Layer.provideMerge(
        ServerSettings.layerTest({
          cardRuntime: { environmentSessionCap: input.environmentSessionCap },
        }),
      ),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto, testCrypto)),
      Layer.provideMerge(NodeServices.layer),
    );
};

/** Runs a scenario against a fresh engine, with fakes it can reach and every spawned process stopped after. */
const scenario = <A, E, R>(
  options: { readonly environmentSessionCap?: number },
  body: (fakes: {
    readonly providers: { current: ReadonlyArray<ServerProvider> };
    readonly hosts: Queue.Queue<PreviewAutomationBroker.PreviewAutomationHostConnected>;
    readonly terminals: ReturnType<typeof makeTerminals>;
    readonly admitted: Array<HostAdmission.HeavyJobKind>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const providers = { current: READY_PROVIDERS };
    const hosts = yield* Queue.unbounded<PreviewAutomationBroker.PreviewAutomationHostConnected>();
    const terminals = makeTerminals();
    const admitted: Array<HostAdmission.HeavyJobKind> = [];
    yield* Effect.addFinalizer(() => terminals.stopAll);
    return yield* Effect.scoped(body({ providers, hosts, terminals, admitted })).pipe(
      Effect.provide(
        makeLayer({
          environmentSessionCap: options.environmentSessionCap ?? 100,
          providers,
          hosts,
          terminals: terminals.layer,
          admitted,
        }),
      ),
    );
  });

const script = (id: string, role: ProjectScript["role"], command: string): ProjectScript => ({
  id,
  name: id,
  command,
  icon: "play",
  runOnWorktreeCreate: false,
  role,
});

const RISKS = { sideEffect: "low", performance: "low", compatibility: "low", notes: "" } as const;

const PROJECT_FILE = {
  checks: [{ id: "unit", name: "Unit", command: "node test.js" }],
  ports: { web: 0 },
  services: [
    {
      name: "api",
      kind: "fake",
      port: "web",
      start: "node fake-api.js",
      ready: { kind: "http", path: "/health", timeoutSeconds: 30 },
    },
  ],
  journeys: [{ id: "health", name: "Health", command: "node journey.js" }],
};

// A twin of the app's API: answers /health from health.json, read on every request.
const FAKE_API = `const fs = require("node:fs");
require("node:http")
  .createServer((request, response) => {
    let health = null;
    try { health = JSON.parse(fs.readFileSync(__dirname + "/health.json", "utf8")); } catch {}
    if (request.url !== "/health" || health === null) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { "content-type": health.type });
    response.end(health.body);
  })
  .listen(Number(process.env.ISKRA_PORT_WEB), "127.0.0.1");
`;

const TEXT_HEALTH = textOf({ type: "text/plain", body: "ok" });
const JSON_HEALTH = textOf({ type: "application/json", body: textOf({ status: "ok" }) });

// Hidden scenario words; none may reach the builder or anything stored but the verifier's own turn.
const H1_TITLE = "Greeting stays polite";
const H1_BODY = "The health answer never mentions pineapple-okay";
const H2_TITLE = "Health speaks JSON";
const SECRETS = [H1_TITLE, H1_BODY, H2_TITLE, "holdout-status"];
// Owner-side words the verifier's brief must never carry.
const CRITIQUE = "Critique: rename the mango handler before review.";
const OWNER_NOTE = "Keep the papaya flag on while you work.";

/**
 * A repository whose cards work on `staging`, with a project file declaring a check, a fake API
 * service, a journey against it, two hidden scenarios (one a command kept outside the repository),
 * and a builder on Claude model A, a critic on model B and a verifier on OpenCode.
 */
const makeWorld = Effect.fn("makeWorld")(function* (
  name: string,
  options: { readonly verifier: "on" | "off"; readonly reviewFixRounds?: number },
) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const holdouts = yield* HoldoutStore;
  const verifierReactor = yield* CardVerifierReactor.CardVerifierReactor;
  const reviewReactor = yield* CardReviewReactor.CardReviewReactor;
  const tap = yield* engine.subscribeDomainEvents;
  yield* workspace.start();
  yield* (yield* CardRefGuard.CardRefGuard).start();
  yield* (yield* CardSessionReactor.CardSessionReactor).start();
  yield* (yield* CardScheduler.CardScheduler).start();
  yield* (yield* RunReactor.RunReactor).start();
  yield* reviewReactor.start();
  yield* (yield* CardLandingReactor.CardLandingReactor).start();
  yield* verifierReactor.start();
  yield* (yield* CardWatchdog.CardWatchdog).start();
  const board = yield* BoardToolkit.pipe(Effect.provide(BoardToolkitHandlersLive));
  const verifierTools = yield* VerifierToolkit.pipe(Effect.provide(VerifierToolkitHandlersLive));

  const repo = yield* makeGitRepo(`iskra-card-verify-${name}-`);
  const probes = yield* repo.fileSystem.makeTempDirectoryScoped({ prefix: "iskra-verify-probe-" });
  const journeyLog = repo.path.join(probes, "journeys.log");
  const files: Record<string, string> = {
    ".iskra/project.json": textOf(PROJECT_FILE),
    "fake-api.js": FAKE_API,
    "test.js": "process.exit(0);\n",
    "journey.js": `require("node:fs").appendFileSync(${textOf(journeyLog)}, process.cwd() + "\\n");
fetch("http://127.0.0.1:" + process.env.ISKRA_PORT_WEB + "/health").then(
  (response) => process.exit(response.status === 200 ? 0 : 1),
  () => process.exit(1),
);
`,
  };
  for (const [file, text] of Object.entries(files)) {
    yield* repo.fileSystem.makeDirectory(repo.path.dirname(repo.path.join(repo.root, file)), {
      recursive: true,
    });
    yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, file), text);
  }
  yield* repo.git("add", ".");
  yield* repo.git("commit", "-m", "project file, fake API and journey");
  yield* repo.git("branch", "staging");
  // The command scenario lives outside the repository, where no builder can read it.
  const probePath = repo.path.join(probes, "holdout-status.js");
  yield* repo.fileSystem.writeFileString(
    probePath,
    `const port = process.env.ISKRA_PORT_WEB;
fetch("http://127.0.0.1:" + port + "/health").then(
  (response) => {
    const type = response.headers.get("content-type") ?? "";
    console.log("port " + port + " answered " + response.status + " " + type);
    process.exit(type.includes("json") ? 0 : 1);
  },
  () => { console.log("port " + port + " unreachable"); process.exit(1); },
);
`,
  );

  let commands = 0;
  const commandId = () => CommandId.make(`cmd-verify-${name}-${(commands += 1)}`);
  const projectId = ProjectId.make(`project-verify-${name}`);
  const agentIdOf = (agentName: string) => AgentId.make(`agent-verify-${name}-${agentName}`);
  const builderId = agentIdOf("builder");
  const verifierId = agentIdOf("verifier-oc");

  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: name,
    workspaceRoot: repo.root,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.meta.update",
    commandId: commandId(),
    projectId,
    scripts: [script("setup", "setup", "true"), script("dev", "run", "true")],
  });
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: commandId(),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      baseBranch: "staging",
      landing: "local",
      reviewFixRounds: options.reviewFixRounds ?? DEFAULT_PROJECT_ORCHESTRATION.reviewFixRounds,
      verifier: { mode: options.verifier },
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: "PUBLISHING_ENABLED" },
    },
  });
  const agents: ReadonlyArray<
    readonly [string, string, string, ReadonlyArray<RunCapability>, ReadonlyArray<AgentRole>]
  > = [
    ["builder", "claudeAgent", "claude-a", ["read", "write"], ["builder"]],
    ["crit", "claudeAgent", "claude-b", ["read"], ["critic"]],
    ["verifier-oc", "opencode", "gpt-5", ["read"], ["verifier"]],
  ];
  for (const [agentName, instance, model, capabilities, roles] of agents) {
    yield* engine.dispatch({
      type: "agent.create",
      commandId: commandId(),
      agentId: agentIdOf(agentName),
      projectId,
      name: agentName,
      roleTags: [],
      rolePrompt: "",
      modelSelection: { instanceId: ProviderInstanceId.make(instance), model },
      capabilities,
      roles,
      createdAt: now,
    });
  }
  yield* holdouts.set(projectId, {
    scenarioId: "h1",
    title: H1_TITLE,
    kind: "text",
    body: H1_BODY,
    command: null,
    timeoutMinutes: 5,
  });
  yield* holdouts.set(projectId, {
    scenarioId: "h2",
    title: H2_TITLE,
    kind: "command",
    body: "",
    command: `node ${probePath}`,
    timeoutMinutes: 5,
  });

  /** Re-reads `read` after each domain event until `predicate` holds. */
  const until = <A, E>(read: Effect.Effect<A, E>, predicate: (value: A) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const value = yield* Effect.orDie(read);
        if (predicate(value)) return value;
        yield* Stream.runHead(tap);
      }
    });
  const eventsOf = <Type extends OrchestrationEvent["type"]>(
    type: Type,
    matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean = () => true,
  ) =>
    Stream.runCollect(engine.readEvents(0)).pipe(
      Effect.map((events) =>
        Array.from(events).filter(
          (event): event is Extract<OrchestrationEvent, { type: Type }> =>
            event.type === type && matches(event as Extract<OrchestrationEvent, { type: Type }>),
        ),
      ),
    );
  const nthEvent = <Type extends OrchestrationEvent["type"]>(
    type: Type,
    matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean,
    n = 1,
  ) =>
    until(eventsOf(type, matches), (found) => found.length >= n).pipe(
      Effect.map((found) => found[n - 1]!),
    );
  const card = (cardId: CardId) =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(
        Effect.map((model) => (model.cards ?? []).find((candidate) => candidate.id === cardId)!),
      );
  const activities = (cardId: CardId) =>
    snapshotQuery.getCardActivity(cardId, 500).pipe(Effect.map((stream) => stream.activities));
  const activityWith = (
    cardId: CardId,
    matches: (activity: Effect.Success<ReturnType<typeof activities>>[number]) => boolean,
    n = 1,
  ) =>
    until(activities(cardId), (found) => found.filter(matches).length >= n).pipe(
      Effect.map((found) => found.filter(matches)[n - 1]!),
    );

  let sessionSets = 0;
  const setSession = (
    threadId: ThreadId,
    status: "running" | "ready" | "stopped",
    turnId: string | null,
  ) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-verify-${name}-session-${(sessionSets += 1)}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: turnId === null ? null : TurnId.make(turnId),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

  /** The text a turn was started with. */
  const turnText = (turn: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>) =>
    nthEvent(
      "thread.message-sent",
      (event) => event.payload.messageId === turn.payload.messageId,
    ).pipe(Effect.map((message) => message.payload.text));

  /** The card's nth session in `role`, once its thread has its first turn. */
  const sessionOf = (cardId: CardId, role: "owner" | "critic" | "verifier", n = 1) =>
    Effect.gen(function* () {
      const started = yield* nthEvent(
        "card.session-started",
        (event) => event.payload.cardId === cardId && event.payload.role === role,
        n,
      );
      const turn = yield* nthEvent(
        "thread.turn-start-requested",
        (event) => event.payload.threadId === started.payload.threadId,
      );
      const thread = yield* nthEvent(
        "thread.created",
        (event) => event.payload.threadId === started.payload.threadId,
      );
      return { ...started.payload, turnText: yield* turnText(turn), thread: thread.payload };
    });

  const startedCard = (id: string, title: string) =>
    Effect.gen(function* () {
      const cardId = CardId.make(`card-verify-${name}-${id}`);
      yield* engine.dispatch({
        type: "card.create",
        commandId: commandId(),
        cardId,
        projectId,
        title,
        spec: `${title}.`,
        tags: [],
        criteria: [
          { id: "c1", text: "GET /health answers 200.", verification: "automated" },
          { id: "c2", text: "The health body is JSON.", verification: "automated" },
        ],
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "card.approve",
        commandId: commandId(),
        cardId,
        delegateAgentId: builderId,
      });
      return cardId;
    });

  const commit = (worktree: string, changes: Record<string, string>) =>
    Effect.gen(function* () {
      for (const [file, text] of Object.entries(changes)) {
        const target = repo.path.join(worktree, file);
        yield* repo.fileSystem.makeDirectory(repo.path.dirname(target), { recursive: true });
        yield* repo.fileSystem.writeFileString(target, text);
      }
      yield* repo.gitIn(worktree, "add", ".");
      yield* repo.gitIn(worktree, "commit", "-m", Object.keys(changes).join(", "));
      return yield* repo.gitIn(worktree, "rev-parse", "HEAD");
    });

  const callBoard = <Name extends keyof typeof BoardToolkit.tools>(
    threadId: ThreadId,
    tool: Name,
    params: Parameters<typeof board.handle<Name>>[1],
  ) =>
    board.handle(tool, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BoardToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: ENVIRONMENT_ID,
        threadId,
        providerSessionId: threadId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["board"]),
        issuedAt: 1,
      }),
    );

  /** The verifier's record_verdict, called with the credential of its own session. */
  const recordVerdict = (
    threadId: ThreadId,
    params: Parameters<typeof verifierTools.handle<"record_verdict">>[1],
  ) =>
    verifierTools.handle("record_verdict", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: ENVIRONMENT_ID,
        threadId,
        providerSessionId: threadId,
        providerInstanceId: ProviderInstanceId.make("opencode"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["verifier"]),
        issuedAt: 1,
      }),
    );

  /** A verdict on both criteria and both scenarios; `failC2` fails the JSON criterion and h2. */
  const verdict = (failC2: boolean) => ({
    criteria: [
      {
        criterionId: "c1",
        pass: true,
        evidence: "The Health journey passed.",
        note: "Answers 200.",
      },
      {
        criterionId: "c2",
        pass: !failC2,
        // A verifier quoting a scenario is redacted before anything is recorded.
        evidence: `Checked that ${H1_BODY}.`,
        note: failC2 ? "The body is plain text; send JSON." : "The body is JSON.",
      },
    ],
    diffJudge: { matchesCriteria: true, concerns: [] },
    scenarios: [
      { scenarioId: "h1", satisfied: true },
      { scenarioId: "h2", satisfied: !failC2 },
    ],
  });

  /** The owner asks for review, ends its turn, and gives its slot back once the card is in review. */
  const reviewAndRelease = (cardId: CardId, threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* callBoard(threadId, "request_review", {
        summary: "Done; each criterion is met.",
        risks: RISKS,
      });
      yield* setSession(threadId, "ready", null);
      yield* until(card(cardId), (current) => current.status === "inReview");
      yield* nthEvent(
        "thread.session-stop-requested",
        (event) => event.payload.threadId === threadId,
      );
      yield* setSession(threadId, "stopped", null);
    });

  /** Starts the card and has its owner commit `changes` and ask for review. */
  const cardInReview = (id: string, changes: Record<string, string>) =>
    Effect.gen(function* () {
      const cardId = yield* startedCard(id, `Health ${id}`);
      const owner = yield* sessionOf(cardId, "owner");
      yield* setSession(owner.threadId, "running", "turn-1");
      const worktree = (yield* until(card(cardId), (current) => current.worktreePath !== null))
        .worktreePath!;
      const head = yield* commit(worktree, changes);
      yield* reviewAndRelease(cardId, owner.threadId);
      return { cardId, owner, worktree, head };
    });

  const rerun = (cardId: CardId) =>
    engine.dispatch({ type: "card.verifier.rerun", commandId: commandId(), cardId });

  return {
    engine,
    snapshotQuery,
    workspace,
    verifierReactor,
    reviewReactor,
    repo,
    journeyLog,
    projectId,
    builderId,
    verifierId,
    commandId,
    until,
    eventsOf,
    nthEvent,
    card,
    activities,
    activityWith,
    setSession,
    turnText,
    sessionOf,
    startedCard,
    commit,
    callBoard,
    recordVerdict,
    verdict,
    reviewAndRelease,
    cardInReview,
    rerun,
  };
});

const expectNoSecrets = (value: unknown) => {
  const text = textOf(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

it.live(
  "A: a card is verified on another provider from a detached snapshot, sent back once with counts only, and lands after a pass",
  () =>
    scenario({}, ({ admitted }) =>
      Effect.gen(function* () {
        const world = yield* makeWorld("cross", { verifier: "on" });
        const cardId = yield* world.startedCard("route", "Health route");
        const owner = yield* world.sessionOf(cardId, "owner");
        yield* world.setSession(owner.threadId, "running", "turn-1");
        const started = yield* world.until(
          world.card(cardId),
          (current) => current.worktreePath !== null,
        );
        const worktree = started.worktreePath!;
        yield* world.commit(worktree, { "health.json": TEXT_HEALTH });
        yield* world.engine.dispatch({
          type: "card.message.post",
          commandId: world.commandId(),
          cardId,
          messageId: MessageId.make("message-verify-owner-note"),
          body: OWNER_NOTE,
          createdAt: now,
        });

        // The owner asks for a critique of its diff: a critic starts on Claude model B.
        expect(
          yield* world.callBoard(owner.threadId, "request_critique", {
            focus: "diff",
            agentName: "crit",
          }),
        ).toEqual({ requested: true });
        const critic = yield* world.sessionOf(cardId, "critic");
        expect(critic.thread.modelSelection).toEqual({
          instanceId: "claudeAgent",
          model: "claude-b",
        });
        yield* world.setSession(critic.threadId, "running", "turn-critic");
        const messageId = MessageId.make(`message-verify-critique-${critic.threadId}`);
        yield* world.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: world.commandId(),
          threadId: critic.threadId,
          messageId,
          delta: CRITIQUE,
          turnId: TurnId.make("turn-critic"),
          createdAt: now,
        });
        yield* world.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: world.commandId(),
          threadId: critic.threadId,
          messageId,
          turnId: TurnId.make("turn-critic"),
          createdAt: now,
        });
        yield* world.setSession(critic.threadId, "ready", null);
        const critique = yield* world.activityWith(
          cardId,
          (activity) => activity.kind === "critique",
        );
        expect(critique).toMatchObject({ deliverTo: "builder", body: CRITIQUE });

        // The critique reaches the owner as its next turn once its current one ends.
        yield* world.setSession(owner.threadId, "ready", null);
        const nextTurn = yield* world.nthEvent(
          "thread.turn-start-requested",
          (event) => event.payload.threadId === owner.threadId,
          2,
        );
        const delivered = yield* world.turnText(nextTurn);
        expect(delivered).toContain(CRITIQUE);
        expect(delivered).toContain(OWNER_NOTE);
        yield* world.setSession(owner.threadId, "running", "turn-2");

        // Review runs the check, then the journey against the card's running fake API.
        yield* world.reviewAndRelease(cardId, owner.threadId);
        const evidence = yield* world.nthEvent(
          "card.evidence-recorded",
          (event) => event.payload.cardId === cardId,
        );
        expect(evidence.payload.items).toMatchObject([
          { kind: "check", name: "Unit", exitCode: 0 },
          { kind: "journey", name: "Health", exitCode: 0 },
        ]);
        expect(admitted).toEqual(expect.arrayContaining(["setup", "checks", "journey"]));

        // Until the verifier passes the commit, nobody can merge it.
        const refused = yield* world.engine
          .dispatch({ type: "card.merge.approve", commandId: world.commandId(), cardId })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ detail: VERIFIER_NOT_PASSED_REASON });

        const selected = yield* world.nthEvent(
          "card.verifier-selected",
          (event) => event.payload.cardId === cardId,
        );
        expect(selected.payload).toMatchObject({
          headSha: evidence.payload.headSha,
          verifier: {
            agentId: world.verifierId,
            instanceId: "opencode",
            model: "gpt-5",
            reason: { code: "differentProvider" },
          },
        });
        const verifier = yield* world.sessionOf(cardId, "verifier");
        expect(verifier.capabilities).toEqual(["read"]);
        expect(verifier.thread.modelSelection).toEqual({ instanceId: "opencode", model: "gpt-5" });
        // A detached checkout of the commit under review, with its own services on its own ports.
        const snapshotPath = verifier.thread.worktreePath!;
        expect(snapshotPath).not.toBe(worktree);
        expect(yield* world.repo.gitIn(snapshotPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
          "HEAD",
        );
        expect(yield* world.repo.gitIn(snapshotPath, "rev-parse", "HEAD")).toBe(
          evidence.payload.headSha,
        );
        const cardPort = (yield* world.card(cardId)).portBase!;
        const probed = /port (\d+) answered 200 text\/plain/.exec(verifier.turnText);
        expect(probed).not.toBeNull();
        expect(Number(probed![1])).not.toBe(cardPort);

        // Its own turn carries the scenarios and the command's result; the stored context has placeholders.
        expect(verifier.turnText).toContain(H1_BODY);
        expect(verifier.turnText).toContain("exited 1");
        const stored = textOf(verifier.context) + textOf(verifier.rendered);
        expect(stored).toContain("[hidden scenario h1]");
        expect(stored).toContain("[hidden scenario h2]");
        expectNoSecrets(verifier.context);
        expectNoSecrets(verifier.rendered);
        for (const ownerSide of ["mango", "papaya"]) {
          expect(verifier.turnText).not.toContain(ownerSide);
          expect(stored).not.toContain(ownerSide);
        }

        // A failed verdict: the owner learns the note and how many hidden scenarios failed, nothing more.
        yield* world.recordVerdict(verifier.threadId, world.verdict(true));
        const returned = yield* world.until(
          world.card(cardId),
          (current) => current.status === "inProgress",
        );
        expect(returned.fixRounds).toEqual({ ci: 0, review: 1 });
        const feedback = yield* world.activityWith(
          cardId,
          // The verdict's own activity carries the same code; the builder's copy is a message.
          (activity) => activity.reason?.code === "verifierFailed" && activity.kind === "message",
        );
        expect(feedback.deliverTo).toBe("builder");
        expect(feedback.body).toContain("The body is plain text; send JSON.");
        expect(feedback.body).toContain("1 hidden scenario failed");
        expectNoSecrets(feedback);
        yield* world.verifierReactor.drain;
        expect(yield* world.repo.fileSystem.exists(snapshotPath)).toBe(false);
        yield* world.setSession(verifier.threadId, "stopped", null);

        // The next owner fixes the body and asks again; the verifier passes every criterion and scenario.
        const fixer = yield* world.sessionOf(cardId, "owner", 2);
        expect(fixer.rendered.firstMessage).toContain("1 hidden scenario failed");
        expectNoSecrets(fixer.rendered);
        yield* world.setSession(fixer.threadId, "running", "turn-1");
        const fixedHead = yield* world.commit(worktree, { "health.json": JSON_HEALTH });
        yield* world.reviewAndRelease(cardId, fixer.threadId);
        const second = yield* world.sessionOf(cardId, "verifier", 2);
        expect(second.turnText).toContain("exited 0");
        yield* world.recordVerdict(second.threadId, world.verdict(false));
        expect(
          yield* world.until(
            world.card(cardId),
            (current) => current.verification.state === "passed",
          ),
        ).toMatchObject({
          status: "inReview",
          verification: { headSha: fixedHead, satisfaction: { satisfied: 2, total: 2 } },
        });
        yield* world.setSession(second.threadId, "stopped", null);

        // The merge goes through: local landing reruns the journey after rebasing, then fast-forwards.
        yield* world.engine.dispatch({
          type: "card.merge.approve",
          commandId: world.commandId(),
          cardId,
        });
        yield* world.until(world.card(cardId), (current) => current.status === "landed");
        expect(yield* world.repo.git("rev-parse", "staging")).toBe(fixedHead);
        const journeyRuns = (yield* world.repo.fileSystem.readFileString(world.journeyLog))
          .trim()
          .split("\n");
        expect(journeyRuns).toHaveLength(3);

        // Nothing stored or streamed for the card carries a scenario's words, and verdicts keep ids only.
        const stream = yield* world.snapshotQuery.getCardActivity(cardId, 500);
        expectNoSecrets(stream);
        const latest = yield* (yield* ProjectionCardRepository).latestVerdict({ cardId });
        expect(Option.getOrThrow(latest).scenarios).toEqual([
          { scenarioId: "h1", satisfied: true },
          { scenarioId: "h2", satisfied: true },
        ]);
        expectNoSecrets(latest);
        // The documented limit: only the verifier's own hidden thread events carry them.
        const verifierThreads = new Set<string>([verifier.threadId, second.threadId]);
        for (const event of yield* world.eventsOf("card.session-started")) expectNoSecrets(event);
        const others = (yield* Stream.runCollect(world.engine.readEvents(0))).filter(
          (event) =>
            !(
              event.type.startsWith("thread.") &&
              verifierThreads.has(String((event.payload as { threadId?: unknown }).threadId))
            ),
        );
        for (const event of others) expectNoSecrets(event);
      }),
    ),
  120_000,
);

it.live(
  "B: without a ready OpenCode the builder's other Claude model verifies, without a second model its own, and a verifier with a shell is skipped",
  () =>
    scenario({}, ({ providers }) =>
      Effect.gen(function* () {
        const world = yield* makeWorld("fallback", { verifier: "on" });
        const { cardId } = yield* world.cardInReview("fallback", { "health.json": JSON_HEALTH });
        const choose = (n: number) =>
          Effect.gen(function* () {
            const selected = yield* world.nthEvent(
              "card.verifier-selected",
              (event) => event.payload.cardId === cardId,
              n,
            );
            const session = yield* world.sessionOf(cardId, "verifier", n);
            yield* world.recordVerdict(session.threadId, world.verdict(false));
            yield* world.until(
              world.card(cardId),
              (current) => current.verification.state === "passed",
            );
            yield* world.setSession(session.threadId, "stopped", null);
            return selected.payload.verifier;
          });

        expect(yield* choose(1)).toMatchObject({
          agentId: world.verifierId,
          reason: { code: "differentProvider" },
        });

        providers.current = [
          serverProvider("claudeAgent", ["claude-a", "claude-b"]),
          serverProvider("opencode", ["gpt-5"], false),
        ];
        yield* world.rerun(cardId);
        expect(yield* choose(2)).toMatchObject({
          agentId: world.builderId,
          instanceId: "claudeAgent",
          model: "claude-b",
          reason: { code: "sameProviderVerifier" },
        });

        providers.current = [
          serverProvider("claudeAgent", ["claude-a"]),
          serverProvider("opencode", ["gpt-5"], false),
        ];
        yield* world.rerun(cardId);
        expect(yield* choose(3)).toMatchObject({
          agentId: world.builderId,
          model: "claude-a",
          reason: { code: "sameModelVerifier" },
        });

        providers.current = READY_PROVIDERS;
        yield* world.engine.dispatch({
          type: "agent.update",
          commandId: world.commandId(),
          agentId: world.verifierId,
          capabilities: ["read", "shell"],
        });
        yield* world.rerun(cardId);
        expect(yield* choose(4)).toMatchObject({
          agentId: world.builderId,
          model: "claude-b",
          reason: { code: "sameProviderVerifier" },
        });
      }),
    ),
  120_000,
);

it.live(
  "C: a verifier that fails past the review rounds pauses the card, and a person's override with a reason lets it merge",
  () =>
    scenario({}, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld("override", { verifier: "on", reviewFixRounds: 1 });
        const { cardId, worktree } = yield* world.cardInReview("override", {
          "health.json": TEXT_HEALTH,
        });
        const first = yield* world.sessionOf(cardId, "verifier");
        yield* world.recordVerdict(first.threadId, world.verdict(true));
        yield* world.until(world.card(cardId), (current) => current.status === "inProgress");
        yield* world.setSession(first.threadId, "stopped", null);

        const fixer = yield* world.sessionOf(cardId, "owner", 2);
        yield* world.setSession(fixer.threadId, "running", "turn-1");
        yield* world.commit(worktree, { "notes.md": "Still text.\n" });
        yield* world.reviewAndRelease(cardId, fixer.threadId);
        const second = yield* world.sessionOf(cardId, "verifier", 2);
        yield* world.recordVerdict(second.threadId, world.verdict(true));
        const paused = yield* world.until(world.card(cardId), (current) => current.paused !== null);
        expect(paused).toMatchObject({
          status: "inReview",
          paused: { reason: { code: "fixRoundsExhausted" } },
          verification: { state: "failed" },
        });
        yield* world.setSession(second.threadId, "stopped", null);

        const unexplained = yield* world.engine
          .dispatch({
            type: "card.verifier.override",
            commandId: world.commandId(),
            cardId,
            reason: "",
          })
          .pipe(Effect.flip);
        expect(unexplained).toMatchObject({ detail: OVERRIDE_REASON_REQUIRED });
        yield* world.engine.dispatch({
          type: "card.verifier.override",
          commandId: world.commandId(),
          cardId,
          reason: "Manual check done.",
        });
        expect((yield* world.card(cardId)).verification).toMatchObject({
          state: "overridden",
          override: { reason: "Manual check done." },
        });
        yield* world.activityWith(
          cardId,
          (activity) => activity.reason?.code === "verifierOverridden",
        );

        yield* world.engine.dispatch({ type: "card.resume", commandId: world.commandId(), cardId });
        yield* world.engine.dispatch({
          type: "card.merge.approve",
          commandId: world.commandId(),
          cardId,
        });
        yield* world.until(world.card(cardId), (current) => current.status === "landed");
      }),
    ),
  120_000,
);

it.live(
  "D: one agent runs in two channels and a DM at once, and a fourth wake waits for a machine slot",
  () =>
    scenario({ environmentSessionCap: 3 }, () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const tap = yield* engine.subscribeDomainEvents;
        yield* (yield* RunReactor.RunReactor).start();
        const repo = yield* makeGitRepo("iskra-card-verify-instances-");
        const projectId = ProjectId.make("project-verify-instances");
        const builderId = AgentId.make("agent-verify-instances-builder");
        let commands = 0;
        const commandId = () => CommandId.make(`cmd-verify-instances-${(commands += 1)}`);
        yield* engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "instances",
          workspaceRoot: repo.root,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "agent.create",
          commandId: commandId(),
          agentId: builderId,
          projectId,
          name: "builder",
          roleTags: [],
          rolePrompt: "",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-a" },
          capabilities: ["read", "write"],
          createdAt: now,
        });
        const channels = ["a", "b", "dm", "c"].map((id) => ChannelId.make(`channel-verify-${id}`));
        for (const [index, channelId] of channels.entries()) {
          const dm = index === 2;
          yield* engine.dispatch({
            type: "channel.create",
            commandId: commandId(),
            channelId,
            projectId,
            kind: dm ? "dm" : "channel",
            name: dm ? "dm-builder" : `room-${index}`,
            memberAgentIds: [builderId],
            leadAgentId: null,
            createdAt: now,
          });
        }
        const post = (channelId: ChannelId, body: string) =>
          engine.dispatch({
            type: "channel.message.post",
            commandId: commandId(),
            channelId,
            messageId: MessageId.make(`message-verify-${channelId}`),
            body,
            createdAt: now,
          });
        const eventsOf = <Type extends OrchestrationEvent["type"]>(
          type: Type,
          matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean,
        ) =>
          Stream.runCollect(engine.readEvents(0)).pipe(
            Effect.map((events) =>
              Array.from(events).filter(
                (event): event is Extract<OrchestrationEvent, { type: Type }> =>
                  event.type === type &&
                  matches(event as Extract<OrchestrationEvent, { type: Type }>),
              ),
            ),
          );
        const atLeast = <Type extends OrchestrationEvent["type"]>(
          type: Type,
          matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean,
          n: number,
        ) =>
          Effect.gen(function* () {
            while (true) {
              const found = yield* eventsOf(type, matches);
              if (found.length >= n) return found;
              yield* Stream.runHead(tap);
            }
          });

        yield* post(channels[0]!, "@builder what does /health return?");
        yield* post(channels[1]!, "@builder is the API up?");
        yield* post(channels[2]!, "what's 2+2?");
        const runs = yield* atLeast(
          "channel.run-started",
          (event) => event.payload.agentId === builderId,
          3,
        );
        expect(new Set(runs.map((run) => run.payload.channelId))).toEqual(
          new Set(channels.slice(0, 3)),
        );

        // Every slot is taken: the fourth wake waits, saying so once, with its message still pending.
        yield* post(channels[3]!, "@builder and here?");
        const [note] = yield* atLeast(
          "channel.message-posted",
          (event) =>
            event.payload.channelId === channels[3] && textOf(event).includes("session slots"),
          1,
        );
        expect(textOf(note)).toContain(
          "@builder starts when one of this machine's 3 session slots frees.",
        );
        expect(
          yield* eventsOf(
            "channel.run-started",
            (event) => event.payload.channelId === channels[3],
          ),
        ).toEqual([]);

        // One run ends; the waiting wake starts in its slot.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: commandId(),
          threadId: runs[0]!.payload.threadId,
          session: {
            threadId: runs[0]!.payload.threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
        const [fourth] = yield* atLeast(
          "channel.run-started",
          (event) => event.payload.channelId === channels[3],
          1,
        );
        yield* atLeast(
          "channel.delivery-updated",
          (event) =>
            event.payload.status === "sent" &&
            event.payload.runThreadId === fourth!.payload.threadId,
          1,
        );
        expect(
          yield* eventsOf("channel.delivery-updated", (event) => event.payload.status === "queued"),
        ).toEqual([]);
      }),
    ),
  120_000,
);

it.effect(
  "E: ProviderService refuses runs a provider can't enforce, before any adapter starts",
  () =>
    Effect.gen(function* () {
      const claude = yield* makeTestProviderAdapterHarness({
        provider: ProviderDriverKind.make("claudeAgent"),
      });
      const opencode = yield* makeTestProviderAdapterHarness({
        provider: ProviderDriverKind.make("opencode"),
      });
      const codex = yield* makeTestProviderAdapterHarness({
        provider: ProviderDriverKind.make("codex"),
      });
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
        [ProviderDriverKind.make("opencode")]: opencode.adapter,
        [ProviderDriverKind.make("codex")]: codex.adapter,
      });
      const cwd = process.cwd();

      const start = (
        instance: "claudeAgent" | "opencode" | "codex",
        run: ProviderRunRestrictions,
        opencodeServerUrl?: string,
      ) =>
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const threadId = ThreadId.make(
            `thread-verify-refusal-${instance}-${run.capabilities.join("-")}`,
          );
          return yield* provider.startSession(threadId, {
            threadId,
            provider: ProviderDriverKind.make(instance),
            providerInstanceId: ProviderInstanceId.make(instance),
            cwd,
            runtimeMode: "approval-required",
            run,
          });
        }).pipe(
          Effect.provide(
            makeProviderServiceLive().pipe(
              Layer.provide(NodeServices.layer),
              Layer.provide(
                Layer.mergeAll(
                  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
                  Layer.succeed(ProviderAdapterRegistry, registry),
                  ServerConfig.layerTest(cwd, { prefix: "iskra-verify-refusal-" }).pipe(
                    Layer.provide(NodeServices.layer),
                  ),
                  ServerSettings.layerTest(
                    opencodeServerUrl === undefined
                      ? {}
                      : { providers: { opencode: { serverUrl: opencodeServerUrl } } },
                  ),
                  AnalyticsService.layerTest,
                  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
                ).pipe(Layer.provide(SqlitePersistenceMemory)),
              ),
            ),
          ),
        );
      const refusal = (...args: Parameters<typeof start>) =>
        start(...args).pipe(
          Effect.flip,
          Effect.map((error) => (error as { readonly issue?: string }).issue),
        );

      expect(
        yield* refusal("opencode", { systemPrompt: "", capabilities: ["read", "shell"] }),
      ).toBe("Agent runs on 'opencode' can't enforce shell; choose a provider that can.");
      expect(yield* refusal("codex", { systemPrompt: "", capabilities: ["read"] })).toBe(
        "Agent runs on 'codex' can't enforce its restrictions; choose a provider that can.",
      );
      expect(
        yield* refusal(
          "opencode",
          { systemPrompt: "", capabilities: ["read"] },
          "http://127.0.0.1:9",
        ),
      ).toBe(
        "Agent runs on 'opencode' can't use an external OpenCode server; choose a provider that can.",
      );
      expect(opencode.getStartCount() + codex.getStartCount()).toBe(0);

      const allowed = yield* start("claudeAgent", {
        systemPrompt: "",
        capabilities: ["read", "write", "shell", "network"],
        egress: { mode: "allowlist", allow: ["registry.npmjs.org"], deny: [] },
      });
      expect(allowed.provider).toBe("claudeAgent");
      expect(claude.getStartCount()).toBe(1);
    }),
);

it.live(
  "F: a desktop host connecting recaptures a card's missing screenshot once, and Restart brings a stopped service back",
  () =>
    scenario({}, ({ hosts, terminals }) =>
      Effect.gen(function* () {
        const world = yield* makeWorld("runtime", { verifier: "off" });
        const { cardId } = yield* world.cardInReview("banner", {
          "src/Banner.tsx": "export const Banner = () => null;\n",
          "health.json": JSON_HEALTH,
        });
        const evidence = yield* world.nthEvent(
          "card.evidence-recorded",
          (event) => event.payload.cardId === cardId,
        );
        expect(evidence.payload.items).toContainEqual(
          expect.objectContaining({
            kind: "screenshot",
            unavailable: expect.objectContaining({ code: "noPreviewHost" }),
          }),
        );

        // The same connection announced twice recaptures once; a new connection may try again.
        const host = (connectionId: string) => ({
          environmentId: ENVIRONMENT_ID,
          clientId: "desktop",
          connectionId,
        });
        yield* Queue.offer(hosts, host("connection-1"));
        yield* Queue.offer(hosts, host("connection-1"));
        yield* Queue.offer(hosts, host("connection-2"));
        yield* world.activityWith(
          cardId,
          (activity) => activity.reason?.code === "previewHostConnected",
          2,
        );
        yield* world.reviewReactor.drain;
        expect(
          (yield* world.activities(cardId)).filter(
            (activity) => activity.reason?.code === "previewHostConnected",
          ),
        ).toHaveLength(2);
        const recaptured = yield* world.snapshotQuery.getCardActivity(cardId, 500);
        expect(recaptured.evidence?.evidenceId).toBe(evidence.payload.evidenceId);
        // Re-recording replaces the evidence's items instead of stacking another screenshot row.
        expect(
          recaptured.evidence?.items.filter((item) => item.kind === "screenshot"),
        ).toHaveLength(evidence.payload.items.filter((item) => item.kind === "screenshot").length);

        // The card's fake API stops; a person's Restart brings it back and says so on the card.
        const apiUp = world.workspace
          .serviceHealth(cardId)
          .pipe(Effect.map((probes) => probes.find((probe) => probe.name === "api")?.up));
        expect(yield* apiUp).toBe(true);
        yield* terminals.stop(CardWorkspace.cardTerminalThreadId(cardId), "service-api");
        expect(yield* apiUp).toBe(false);
        yield* world.engine.dispatch({
          type: "card.services.restart",
          commandId: world.commandId(),
          cardId,
        });
        yield* world.activityWith(
          cardId,
          (activity) => activity.reason?.code === "serviceRestored",
        );
        expect(yield* apiUp).toBe(true);
      }),
    ),
  120_000,
);
