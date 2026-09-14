import {
  CommandId,
  MessageId,
  TurnId,
  type OrchestrationEvent,
  type ThreadId,
} from "@iskra/contracts";
import * as Net from "@iskra/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

// Fixtures shared by the card and run reactor suites.

export const now = "2026-01-01T00:00:00.000Z";

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

/** The engine and projections over an in-memory database, with card workspaces on real git. */
export const cardWorkspaceTestLayer = (
  prefix: string,
  terminals = Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
) =>
  CardWorkspace.layer.pipe(
    Layer.provideMerge(
      HostAdmission.layerWithSample(Effect.succeed({ load1: 0, cores: 8, freeMemRatio: 1 })),
    ),
    Layer.provideMerge(
      OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
    ),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provide(Net.layer),
    Layer.provide(terminals),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, testCrypto)),
    Layer.provideMerge(NodeServices.layer),
  );

/** A git repository with one commit on `main`, removed with the scope. */
export const makeGitRepo = Effect.fn("makeGitRepo")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  const gitIn = (cwd: string, ...args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", cwd, ...args] })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.succeed(output.stdout.trim())
            : Effect.die(new Error(output.stderr)),
        ),
      );
  const git = (...args: ReadonlyArray<string>) => gitIn(root, ...args);
  yield* git("init", "--initial-branch=main");
  yield* git("config", "user.email", "test@example.com");
  yield* git("config", "user.name", "Test");
  yield* git("config", "commit.gpgsign", "false");
  yield* fileSystem.writeFileString(path.join(root, "README.md"), "hello\n");
  yield* git("add", ".");
  yield* git("commit", "-m", "initial");
  return { fileSystem, path, root, git, gitIn };
});

/**
 * Awaits the next event of `type` that `matches` on one domain event tap. The tap is consumed as
 * it is read, so await events in the order they happen.
 */
export const nextEventOn =
  <E, R>(events: Stream.Stream<OrchestrationEvent, E, R>) =>
  <Type extends OrchestrationEvent["type"]>(
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

/** Reports a thread's provider session and assistant replies the way a provider would. */
export const providerSession = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

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

  return { setSession, answer };
});
