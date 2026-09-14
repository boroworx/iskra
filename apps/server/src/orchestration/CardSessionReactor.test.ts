import {
  AgentId,
  CardId,
  CommandId,
  MessageId,
  ORPHANED_PROVIDER_SESSION_ERROR,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  runSessionState,
  type OrchestrationEvent,
  type RunCapability,
} from "@iskra/contracts";
import * as Net from "@iskra/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CardSessionReactor from "./CardSessionReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";

// Different bytes on every call, so each generated id is new.
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

const layer = CardSessionReactor.layer.pipe(
  Layer.provideMerge(CardWorkspace.layer),
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
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-session-test-" }),
  ),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provide(Net.layer),
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({
      close: () => Effect.void,
    }),
  ),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A committed git repository as a project with an approved card, three agents
 * and the reactors running. `nextEvent` consumes one tap on domain events, so
 * await events in the order they happen.
 */
const makeWorld = Effect.fn("makeWorld")(function* (name: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  yield* (yield* CardWorkspace.CardWorkspace).start();
  const reactor = yield* CardSessionReactor.CardSessionReactor;
  yield* reactor.start();
  const events = yield* engine.subscribeDomainEvents;

  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `iskra-session-repo-${name}-` });
  const git = (...args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", root, ...args] })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0 ? Effect.void : Effect.die(new Error(output.stderr)),
        ),
      );
  yield* git("init", "--initial-branch=main");
  yield* git("config", "user.email", "test@example.com");
  yield* git("config", "user.name", "Test");
  yield* git("config", "commit.gpgsign", "false");
  yield* fileSystem.writeFileString(path.join(root, "README.md"), "hello\n");
  yield* git("add", ".");
  yield* git("commit", "-m", "initial");

  const projectId = ProjectId.make(`project-${name}`);
  const cardId = CardId.make(`card-${name}`);
  const agent = (id: string) => AgentId.make(`agent-${name}-${id}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: name,
    workspaceRoot: root,
    createdAt: now,
  });
  const createAgent = (id: string, capabilities: ReadonlyArray<RunCapability>) =>
    engine.dispatch({
      type: "agent.create",
      commandId: CommandId.make(`cmd-agent-${name}-${id}`),
      agentId: agent(id),
      projectId,
      name: id,
      roleTags: [],
      rolePrompt: "",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      },
      capabilities,
      createdAt: now,
    });
  yield* createAgent("backend", ["read", "write"]);
  yield* createAgent("frontend", ["read", "write"]);
  yield* createAgent("reviewer", ["read"]);
  yield* engine.dispatch({
    type: "card.create",
    commandId: CommandId.make(`cmd-card-${name}`),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "Limit each key to 100 requests a minute.",
    tags: [],
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "card.approve",
    commandId: CommandId.make(`cmd-approve-${name}`),
    cardId,
  });
  yield* engine.dispatch({
    type: "card.decision.record",
    commandId: CommandId.make(`cmd-decision-${name}`),
    cardId,
    decisionId: `decision-${name}`,
    text: "Use a token bucket.",
    createdAt: now,
  });

  const nextEvent = <Type extends OrchestrationEvent["type"]>(
    type: Type,
    matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean = () => true,
  ) =>
    events.pipe(
      Stream.filter(
        (event) =>
          event.type === type && matches(event as Extract<OrchestrationEvent, { type: Type }>),
      ),
      Stream.runHead,
      Effect.map(
        (event) => Option.getOrThrow(event) as Extract<OrchestrationEvent, { type: Type }>,
      ),
    );

  const setSession = (
    threadId: ThreadId,
    status: "running" | "ready" | "stopped" | "error",
    turnId: string | null,
    lastError: string | null = null,
  ) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-session-${threadId}-${status}-${turnId ?? "idle"}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: turnId === null ? null : TurnId.make(turnId),
        lastError,
        updatedAt: now,
      },
      createdAt: now,
    });

  const answer = Effect.fn("answer")(function* (threadId: ThreadId, turnId: string, text: string) {
    const messageId = MessageId.make(`assistant-${threadId}-${turnId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make(`cmd-delta-${messageId}`),
      threadId,
      messageId,
      delta: text,
      turnId: TurnId.make(turnId),
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`cmd-complete-${messageId}`),
      threadId,
      messageId,
      turnId: TurnId.make(turnId),
      createdAt: now,
    });
  });

  /** A session is recorded before its thread exists; this waits for its first message. */
  const nextSession = Effect.fn("nextSession")(function* () {
    const started = yield* nextEvent("card.session-started");
    yield* nextEvent("thread.message-sent", (event) => event.payload.threadId === started.payload.threadId);
    return started;
  });

  const userMessages = (threadId: ThreadId) =>
    snapshotQuery.getThreadDetailById(threadId, { activityKinds: [] }).pipe(
      Effect.map((thread) =>
        Option.isNone(thread)
          ? []
          : thread.value.messages.filter((message) => message.role === "user"),
      ),
    );

  const card = snapshotQuery
    .getCommandReadModel()
    .pipe(Effect.map((model) => (model.cards ?? []).find((candidate) => candidate.id === cardId)));

  return {
    engine,
    snapshotQuery,
    fileSystem,
    path,
    reactor,
    cardId,
    agent,
    nextEvent,
    nextSession,
    setSession,
    answer,
    userMessages,
    card,
    assign: (id: string) =>
      engine.dispatch({
        type: "card.assign",
        commandId: CommandId.make(`cmd-assign-${name}-${id}`),
        cardId,
        agentId: agent(id),
      }),
  };
});

it.layer(layer)("CardSessionReactor", (it) => {
  it.effect("starts the owner's session in the card worktree from the brief, and hands off on reassignment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("handoff");
        yield* world.assign("backend");

        const first = yield* world.nextSession();
        yield* world.nextEvent("card.status-changed", (event) => event.payload.to === "inProgress");
        const card = yield* world.card;
        expect(first.payload).toMatchObject({
          agentId: world.agent("backend"),
          role: "owner",
          capabilities: ["read", "write"],
        });
        expect(card?.worktreePath).not.toBeNull();
        expect(first.payload.rendered.firstMessage).toContain("Use a token bucket.");
        expect(first.payload.rendered.firstMessage).toContain("## Changes so far\n\nNo changes yet.");
        // Exactly what the inspector shows is what the session was sent.
        expect((yield* world.userMessages(first.payload.threadId)).map((message) => message.text)).toEqual([
          first.payload.rendered.firstMessage,
        ]);
        const thread = yield* world.snapshotQuery.getThreadShellById(first.payload.threadId);
        expect(Option.getOrThrow(thread).worktreePath).toBe(card?.worktreePath);

        // The agent edits the card's worktree, then finishes its turn.
        yield* world.fileSystem.writeFileString(
          world.path.join(card?.worktreePath ?? "", "README.md"),
          "hello\nrate limits\n",
        );
        yield* world.setSession(first.payload.threadId, "ready", null);

        yield* world.assign("frontend");
        yield* world.nextEvent(
          "thread.session-stop-requested",
          (event) => event.payload.threadId === first.payload.threadId,
        );
        yield* world.setSession(first.payload.threadId, "stopped", null);

        const second = yield* world.nextSession();
        expect(second.payload.agentId).toBe(world.agent("frontend"));
        expect(second.payload.rendered.firstMessage).toContain("+rate limits");
        expect((yield* world.userMessages(second.payload.threadId)).map((message) => message.text)).toEqual([
          second.payload.rendered.firstMessage,
        ]);
      }),
    ),
  );

  it.effect("runs a helper read-only and delivers its answer as the owner's next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("helper");
        yield* world.assign("backend");
        const owner = yield* world.nextSession();
        yield* world.setSession(owner.payload.threadId, "ready", null);

        yield* world.engine.dispatch({
          type: "card.helper.request",
          commandId: CommandId.make("cmd-helper-question"),
          cardId: world.cardId,
          agentId: world.agent("reviewer"),
          messageId: MessageId.make("message-helper-question"),
          question: "Is the limit per key or per user?",
          createdAt: now,
        });
        const helper = yield* world.nextSession();
        expect(helper.payload).toMatchObject({ role: "helper", capabilities: ["read"] });
        expect(helper.payload.rendered.firstMessage).toContain(
          "## Question\n\nIs the limit per key or per user?",
        );

        yield* world.setSession(helper.payload.threadId, "running", "turn-helper");
        yield* world.answer(helper.payload.threadId, "turn-helper", "Per key.");
        yield* world.setSession(helper.payload.threadId, "ready", null);
        yield* world.nextEvent(
          "thread.session-stop-requested",
          (event) => event.payload.threadId === helper.payload.threadId,
        );
        yield* world.nextEvent("card.delivery-updated", (event) => event.payload.status === "sent");
        const ownerMessages = yield* world.userMessages(owner.payload.threadId);
        expect(ownerMessages.map((message) => message.text)).toContainEqual(
          expect.stringMatching(/^New message for you:\n\[[^\]]+\] @reviewer: Per key\.$/),
        );

        yield* world.setSession(owner.payload.threadId, "running", "turn-owner-2");
        const delivered = yield* world.nextEvent(
          "card.delivery-updated",
          (event) => event.payload.status === "delivered",
        );
        expect(delivered.payload.threadId).toBe(owner.payload.threadId);
      }),
    ),
  );

  it.effect("shows a session lost across a restart as stale", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("stale");
        yield* world.assign("backend");
        const owner = yield* world.nextSession();
        yield* world.setSession(owner.payload.threadId, "running", "turn-1");
        yield* world.setSession(owner.payload.threadId, "error", null, ORPHANED_PROVIDER_SESSION_ERROR);

        const [run] = yield* world.snapshotQuery.listRunsByAgent(world.agent("backend"), 5);
        const thread = Option.getOrThrow(
          yield* world.snapshotQuery.getThreadShellById(owner.payload.threadId),
        );
        expect(run).toMatchObject({ cardTitle: "Rate limiting", role: "owner" });
        expect(
          runSessionState({
            endedAt: run?.endedAt ?? null,
            session: thread.session,
            awaitingInput: thread.hasPendingApprovals || thread.hasPendingUserInput,
          }),
        ).toBe("stale");

        // A lost session no longer holds the card: a fresh one can start.
        yield* world.engine.dispatch({
          type: "card.session.start",
          commandId: CommandId.make("cmd-fresh-session"),
          cardId: world.cardId,
          createdAt: now,
        });
        const fresh = yield* world.nextSession();
        expect(fresh.payload.threadId).not.toBe(owner.payload.threadId);
      }),
    ),
  );
});
