import {
  AgentId,
  CardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@iskra/contracts";
import * as Net from "@iskra/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

const layer = CardWorkspace.layer.pipe(
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-attempts-test-" })),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provide(Net.layer),
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("card attempts", (it) => {
  it.effect("runs three attempts on separate branches and keeps only the promoted one's worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const workspace = yield* CardWorkspace.CardWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        yield* workspace.start();
        const teardownEvents = yield* engine.subscribeDomainEvents;

        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iskra-attempts-repo-" });
        const git = (...args: ReadonlyArray<string>) =>
          runner
            .run({ command: "git", args: ["-C", root, ...args] })
            .pipe(
              Effect.flatMap((output) =>
                output.code === 0
                  ? Effect.succeed(output.stdout.trim())
                  : Effect.die(new Error(output.stderr)),
              ),
            );
        yield* git("init", "--initial-branch=main");
        yield* git("config", "user.email", "test@example.com");
        yield* git("config", "user.name", "Test");
        yield* git("config", "commit.gpgsign", "false");
        yield* fileSystem.writeFileString(path.join(root, "README.md"), "hello\n");
        yield* git("add", ".");
        yield* git("commit", "-m", "initial");

        const projectId = ProjectId.make("project-attempts-git");
        const parentId = CardId.make("card-attempts-git");
        const agentIds = ["one", "two", "three"].map((name) => AgentId.make(`agent-attempts-${name}`));
        const attemptIds = ["one", "two", "three"].map((name) => CardId.make(`attempt-git-${name}`));
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-attempts-project"),
          projectId,
          title: "Attempts",
          workspaceRoot: root,
          createdAt: now,
        });
        for (const agentId of agentIds) {
          yield* engine.dispatch({
            type: "agent.create",
            commandId: CommandId.make(`cmd-attempts-${agentId}`),
            agentId,
            projectId,
            name: agentId.replace("agent-attempts-", ""),
            roleTags: [],
            rolePrompt: "",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-haiku-4-5",
            },
            capabilities: ["read", "write"],
            createdAt: now,
          });
        }
        yield* engine.dispatch({
          type: "card.create",
          commandId: CommandId.make("cmd-attempts-card"),
          cardId: parentId,
          projectId,
          title: "Rate limiting",
          spec: "Limit each key.",
          tags: [],
          createdAt: now,
        });
        for (const type of ["card.approve", "card.spec.skip"] as const) {
          yield* engine.dispatch({ type, commandId: CommandId.make(`cmd-attempts-${type}`), cardId: parentId });
        }

        yield* engine.dispatch({
          type: "card.attempts.start",
          commandId: CommandId.make("cmd-attempts-start"),
          cardId: parentId,
          attempts: attemptIds.map((cardId, index) => ({ cardId, agentId: agentIds[index]! })),
          createdAt: now,
        });
        // Each attempt works in its own worktree on its own branch.
        const infos = [];
        for (const [index, cardId] of attemptIds.entries()) {
          const info = yield* workspace.ensure(cardId);
          yield* fileSystem.writeFileString(
            path.join(info.worktreePath, `attempt-${index}.txt`),
            `attempt ${index}\n`,
          );
          infos.push(info);
        }
        expect(new Set(infos.map((info) => info.branch)).size).toBe(3);
        expect(new Set(infos.map((info) => info.worktreePath)).size).toBe(3);

        yield* engine.dispatch({
          type: "card.attempt.promote",
          commandId: CommandId.make("cmd-attempts-promote"),
          cardId: attemptIds[1]!,
        });
        const dropped = [attemptIds[0]!, attemptIds[2]!];
        yield* teardownEvents.pipe(
          Stream.filter(
            (event: OrchestrationEvent) =>
              event.type === "card.workspace-cleared" && dropped.includes(event.payload.cardId),
          ),
          Stream.take(dropped.length),
          Stream.runDrain,
        );

        expect(yield* fileSystem.exists(infos[0]!.worktreePath)).toBe(false);
        expect(yield* fileSystem.exists(infos[2]!.worktreePath)).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(infos[1]!.worktreePath, "attempt-1.txt")),
        ).toBe("attempt 1\n");
        const branches = (yield* git("branch", "--list", "iskra/*"))
          .split("\n")
          .map((line) => line.replace(/^[*+]?\s*/, "").trim())
          .filter((line) => line.length > 0);
        expect(branches).toEqual([infos[1]!.branch]);

        const cards = (yield* snapshotQuery.getCommandReadModel()).cards ?? [];
        expect(cards.find((card) => card.id === parentId)).toMatchObject({
          branch: infos[1]!.branch,
          worktreePath: infos[1]!.worktreePath,
          delegateAgentId: agentIds[1],
        });
      }),
    ),
  );
});
