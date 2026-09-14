import { CardId, CommandId, ProjectId, type ProjectScript } from "@iskra/contracts";
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

interface TerminalCall {
  readonly kind: "open" | "write" | "close";
  readonly input: unknown;
}
const terminalCalls: Array<TerminalCall> = [];
const fakeTerminals = Layer.mock(TerminalManager.TerminalManager)({
  open: (input) =>
    Effect.sync(() => {
      terminalCalls.push({ kind: "open", input });
      return {} as never;
    }),
  write: (input) =>
    Effect.sync(() => {
      terminalCalls.push({ kind: "write", input });
    }),
  close: (input) =>
    Effect.sync(() => {
      terminalCalls.push({ kind: "close", input });
    }),
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
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-workspace-test-" }),
  ),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provide(Net.layer),
  Layer.provide(fakeTerminals),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

const script = (id: string, command: string, extra: Partial<ProjectScript> = {}): ProjectScript => ({
  id,
  name: id,
  command,
  icon: "play",
  runOnWorktreeCreate: false,
  ...extra,
});

/** A committed git repository registered as a project with the given scripts. */
const makeProject = Effect.fn("makeProject")(function* (
  name: string,
  scripts: ReadonlyArray<ProjectScript>,
) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `iskra-card-repo-${name}-` });
  const git = (...args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", root, ...args] })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0 ? Effect.succeed(output.stdout) : Effect.die(new Error(output.stderr)),
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
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: name,
    workspaceRoot: root,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.meta.update",
    commandId: CommandId.make(`cmd-scripts-${name}`),
    projectId,
    scripts: [...scripts],
  });

  return {
    engine,
    fileSystem,
    path,
    root,
    git,
    createCard: (id: string, title: string) =>
      engine.dispatch({
        type: "card.create",
        commandId: CommandId.make(`cmd-card-${id}`),
        cardId: CardId.make(id),
        projectId,
        title,
        spec: "",
        tags: [],
        createdAt: now,
      }),
    card: (id: string) =>
      snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === id))),
    cardBranches: git("branch", "--list", "iskra/*").pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.replace(/^[*+]?\s*/, "").trim())
          .filter((line) => line.length > 0),
      ),
    ),
  };
});

it.layer(layer)("CardWorkspace", (it) => {
  it.effect("gives each card its own worktree, branch and ports, and runs setup inside it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const world = yield* makeProject("ports", [
          script("setup", 'printf "%s" "$ISKRA_PORT" > port.txt', { role: "setup" }),
        ]);
        yield* world.createCard("card-api", "Rate limiting");
        yield* world.createCard("card-web", "Dark mode");

        const api = yield* workspace.ensure(CardId.make("card-api"));
        const web = yield* workspace.ensure(CardId.make("card-web"));

        expect(api.portBase).not.toBe(web.portBase);
        expect(api.branch.startsWith("iskra/rate-limiting-")).toBe(true);
        expect(web.branch.startsWith("iskra/dark-mode-")).toBe(true);
        expect(api.worktreePath).not.toBe(web.worktreePath);
        expect(
          yield* world.fileSystem.readFileString(world.path.join(api.worktreePath, "port.txt")),
        ).toBe(String(api.portBase));
        expect(
          yield* world.fileSystem.readFileString(world.path.join(web.worktreePath, "port.txt")),
        ).toBe(String(web.portBase));
        expect((yield* world.cardBranches).toSorted()).toEqual([api.branch, web.branch].toSorted());
        expect(yield* world.card("card-api")).toMatchObject({
          branch: api.branch,
          worktreePath: api.worktreePath,
          portBase: api.portBase,
        });
        expect(yield* workspace.ensure(CardId.make("card-api"))).toEqual(api);
      }),
    ),
  );

  it.effect("runs a script in a card's terminal with its ports, stopping an exclusive one elsewhere", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const world = yield* makeProject("run", [
          script("dev", "pnpm dev", { role: "run", exclusive: true }),
        ]);
        yield* world.createCard("card-one", "One");
        yield* world.createCard("card-two", "Two");
        const one = yield* workspace.ensure(CardId.make("card-one"));
        const two = yield* workspace.ensure(CardId.make("card-two"));
        terminalCalls.length = 0;

        yield* workspace.runScript({ cardId: CardId.make("card-one"), scriptId: "dev" });
        yield* workspace.runScript({ cardId: CardId.make("card-two"), scriptId: "dev" });

        const opened = terminalCalls
          .filter((call) => call.kind === "open")
          .map((call) => call.input as { threadId: string; cwd: string; env: Record<string, string> });
        expect(opened.map((input) => [input.threadId, input.cwd, input.env.ISKRA_PORT])).toEqual([
          ["card:card-one", one.worktreePath, String(one.portBase)],
          ["card:card-two", two.worktreePath, String(two.portBase)],
        ]);
        expect(terminalCalls).toContainEqual({
          kind: "close",
          input: { threadId: "card:card-one", terminalId: "script-dev" },
        });
      }),
    ),
  );

  it.effect("leaves no worktree or branch behind when setup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const world = yield* makeProject("broken", [script("setup", "exit 3", { role: "setup" })]);
        yield* world.createCard("card-broken", "Broken");

        const error = yield* Effect.flip(workspace.ensure(CardId.make("card-broken")));

        expect(error.message).toContain("The setup script failed");
        expect((yield* world.card("card-broken"))?.worktreePath).toBeNull();
        expect(yield* world.cardBranches).toEqual([]);
        const worktrees = yield* world.git("worktree", "list", "--porcelain");
        expect(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
      }),
    ),
  );

  it.effect("runs archive and removes the worktree and branch when a card is abandoned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        yield* workspace.start();
        const world = yield* makeProject("abandon", [
          script("archive", 'printf done > "$ISKRA_PROJECT_ROOT/archived.txt"', {
            role: "archive",
          }),
        ]);
        yield* world.createCard("card-dropped", "Dropped");
        const info = yield* workspace.ensure(CardId.make("card-dropped"));
        const events = yield* world.engine.subscribeDomainEvents;

        yield* world.engine.dispatch({
          type: "card.abandon",
          commandId: CommandId.make("cmd-abandon-dropped"),
          cardId: CardId.make("card-dropped"),
        });
        yield* events.pipe(
          Stream.filter((event) => event.type === "card.workspace-cleared"),
          Stream.runHead,
        );

        expect(
          yield* world.fileSystem.readFileString(world.path.join(world.root, "archived.txt")),
        ).toBe("done");
        expect(yield* world.fileSystem.exists(info.worktreePath)).toBe(false);
        expect(yield* world.cardBranches).toEqual([]);
        expect((yield* world.card("card-dropped"))?.worktreePath).toBeNull();
      }),
    ),
  );
});
