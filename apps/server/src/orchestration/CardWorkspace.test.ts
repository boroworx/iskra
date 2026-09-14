import {
  AgentId,
  CardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
  type ProjectScript,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as TerminalManager from "../terminal/Manager.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { cardWorkspaceTestLayer, makeGitRepo, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

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

const layer = cardWorkspaceTestLayer("iskra-card-workspace-test-", fakeTerminals);

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
  const { fileSystem, path, root, git } = yield* makeGitRepo(`iskra-card-repo-${name}-`);

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

  it.effect("runs three attempts on separate branches and keeps only the promoted one's worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const workspace = yield* CardWorkspace.CardWorkspace;
        yield* workspace.start();
        const teardownEvents = yield* engine.subscribeDomainEvents;
        const { fileSystem, path, root, git } = yield* makeGitRepo("iskra-attempts-repo-");

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
