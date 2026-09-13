import { AgentId, CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { parseAgentFile, type AgentDefinition } from "@t3tools/shared/agentDefinitions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as AgentDefinitionSync from "./AgentDefinitionSync.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";
const claude = ProviderInstanceId.make("claudeAgent");
const haiku = { instanceId: claude, model: "claude-haiku-4-5" };

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

const layer = AgentDefinitionSync.layer.pipe(
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-files-test-" })),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

/** A project rooted in a fresh temporary folder, with helpers for its agent files. */
const makeProject = Effect.fn("makeProject")(function* (name: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sync = yield* AgentDefinitionSync.AgentDefinitionSync;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `iskra-agents-${name}-` });
  const projectId = ProjectId.make(`project-${name}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: name,
    workspaceRoot: root,
    createdAt: now,
  });

  const writeFile = (relativePath: string, contents: string) => {
    const file = path.join(root, relativePath);
    return fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, contents)));
  };
  const agentFile = (fileName: string) => path.join(root, ".iskra", "agents", fileName);
  return {
    engine,
    fileSystem,
    projectId,
    sync,
    agentFile,
    writeFile,
    writeAgentFile: (fileName: string, contents: string) =>
      writeFile(`.iskra/agents/${fileName}`, contents),
    agents: snapshotQuery
      .getCommandReadModel()
      .pipe(
        Effect.map((model) => (model.agents ?? []).filter((agent) => agent.projectId === projectId)),
      ),
    reconcile: sync.reconcile(projectId),
  };
});

it.layer(layer)("AgentDefinitionSync", (it) => {
  it.effect("creates an agent from a new file and writes its id into the file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("create");
        yield* world.writeAgentFile(
          "backend.md",
          "---\nmodel: claude-haiku-4-5\n---\nOwns the server.\n",
        );

        yield* world.reconcile;

        const agents = yield* world.agents;
        expect(agents).toMatchObject([
          {
            name: "backend",
            rolePrompt: "Owns the server.",
            capabilities: ["read"],
            modelSelection: haiku,
            archivedAt: null,
          },
        ]);
        expect(yield* world.fileSystem.readFileString(world.agentFile("backend.md"))).toBe(
          `---\nid: ${agents[0]?.id}\nmodel: claude-haiku-4-5\n---\nOwns the server.\n`,
        );
      }),
    ),
  );

  it.effect("follows a renamed file by id, archives a deleted one and restores it when re-added", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("rename");
        yield* world.writeAgentFile("backend.md", "---\n---\nOwns the server.\n");
        yield* world.reconcile;
        const agentId = (yield* world.agents)[0]?.id;
        expect(agentId).toBeDefined();

        yield* world.fileSystem.remove(world.agentFile("backend.md"));
        yield* world.writeAgentFile("api.md", `---\nid: ${agentId}\nname: api\n---\nOwns the API.\n`);
        yield* world.reconcile;
        expect(yield* world.agents).toMatchObject([
          { id: agentId, name: "api", rolePrompt: "Owns the API.", archivedAt: null },
        ]);

        yield* world.fileSystem.remove(world.agentFile("api.md"));
        yield* world.reconcile;
        expect((yield* world.agents)[0]?.archivedAt).not.toBeNull();

        yield* world.writeAgentFile("api.md", "---\n---\nBack again.\n");
        yield* world.reconcile;
        expect(yield* world.agents).toMatchObject([
          { id: agentId, name: "api", rolePrompt: "Back again.", archivedAt: null },
        ]);
      }),
    ),
  );

  it.effect("writes out a project's agents when it has no agent files, then leaves them alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("migrate");
        const agentId = AgentId.make("agent-migrate");
        yield* world.engine.dispatch({
          type: "agent.create",
          commandId: CommandId.make("cmd-agent-migrate"),
          agentId,
          projectId: world.projectId,
          name: "reviewer",
          roleTags: ["review"],
          rolePrompt: "Reviews changes.",
          modelSelection: haiku,
          capabilities: ["read"],
          createdAt: now,
        });

        yield* world.reconcile;

        const contents = yield* world.fileSystem.readFileString(world.agentFile("reviewer.md"));
        expect(parseAgentFile(contents, "reviewer.md")).toEqual({
          ok: true,
          definition: {
            id: agentId,
            name: "reviewer",
            avatar: null,
            tags: ["review"],
            modelSelection: haiku,
            capabilities: ["read"],
            rolePrompt: "Reviews changes.",
          },
        });
        const migrated = yield* world.agents;
        yield* world.reconcile;
        yield* world.reconcile;
        expect(yield* world.agents).toEqual(migrated);
      }),
    ),
  );

  it.effect("archives nothing while an agent file is broken", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("broken");
        yield* world.writeAgentFile("backend.md", "---\n---\nOwns the server.\n");
        yield* world.writeAgentFile("frontend.md", "---\n---\nOwns the web app.\n");
        yield* world.reconcile;

        yield* world.writeAgentFile("frontend.md", "---\ncapabilities: [deploy]\n---\n");
        yield* world.fileSystem.remove(world.agentFile("backend.md"));
        yield* world.reconcile;

        expect((yield* world.agents).map((agent) => agent.archivedAt)).toEqual([null, null]);
      }),
    ),
  );

  it.effect("saves a definition to its file and moves the file when the agent is renamed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("save");
        const definition: AgentDefinition = {
          id: null,
          name: "frontend" as AgentDefinition["name"],
          avatar: null,
          tags: [],
          modelSelection: haiku,
          capabilities: ["read"],
          rolePrompt: "Owns the web app.",
        };

        const { agentId } = yield* world.sync.save({ projectId: world.projectId, definition });
        expect(yield* world.agents).toMatchObject([{ id: agentId, name: "frontend" }]);
        expect(yield* world.fileSystem.exists(world.agentFile("frontend.md"))).toBe(true);

        yield* world.sync.save({
          projectId: world.projectId,
          definition: { ...definition, id: agentId, name: "web" as AgentDefinition["name"] },
        });
        expect(yield* world.fileSystem.exists(world.agentFile("frontend.md"))).toBe(false);
        expect(yield* world.agents).toMatchObject([{ id: agentId, name: "web", archivedAt: null }]);
      }),
    ),
  );

  it.effect("imports Claude Code and Copilot agent definitions once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeProject("import");
        yield* world.writeFile(
          ".claude/agents/code-reviewer.md",
          "---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.\n",
        );
        yield* world.writeFile(
          ".github/agents/tester.agent.md",
          "---\ndescription: Writes tests\ntools: [read, edit]\n---\nYou write tests.\n",
        );
        yield* world.writeFile(".github/agents/README.md", "Custom agents for this repo.\n");

        const result = yield* world.sync.importDefinitions(world.projectId);

        expect(result.imported.map((agent) => agent.name)).toEqual(["code-reviewer", "tester"]);
        expect(result.skipped.map((entry) => entry.file)).toEqual([".github/agents/README.md"]);
        expect(yield* world.agents).toMatchObject([
          {
            name: "code-reviewer",
            rolePrompt: "You review code.",
            capabilities: ["read"],
            modelSelection: { instanceId: claude, model: expect.stringMatching(/^claude-sonnet-/) },
          },
          { name: "tester", rolePrompt: "You write tests.", capabilities: ["read", "write"] },
        ]);
        expect((yield* world.sync.importDefinitions(world.projectId)).imported).toEqual([]);
      }),
    ),
  );
});
