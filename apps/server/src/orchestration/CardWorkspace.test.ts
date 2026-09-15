// @effect-diagnostics nodeBuiltinImport:off - holds real ports and runs real service processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
  type ProjectScript,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
  const { fileSystem, path, root, git, gitIn } = yield* makeGitRepo(`iskra-card-repo-${name}-`);

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
    projectId,
    /** Commits `.iskra/project.json` (and any other files) onto `main`. */
    commitProjectFile: (file: unknown, extra: Record<string, string> = {}) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.join(root, ".iskra"), { recursive: true });
        // @effect-diagnostics-next-line preferSchemaOverJson:off - writes an arbitrary fixture file.
        yield* fileSystem.writeFileString(path.join(root, ".iskra", "project.json"), JSON.stringify(file));
        for (const [name, content] of Object.entries(extra)) {
          yield* fileSystem.writeFileString(path.join(root, name), content);
        }
        yield* git("add", ".");
        yield* git("commit", "-m", "project file");
      }),
    engine,
    fileSystem,
    path,
    root,
    git,
    gitIn,
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

  it.effect("starts from origin's copy of the policy base branch and diffs untracked files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const engine = yield* OrchestrationEngineService;
        const upstream = yield* makeGitRepo("iskra-card-upstream-");
        const cloneParent = yield* upstream.fileSystem.makeTempDirectoryScoped({
          prefix: "iskra-card-clone-",
        });
        const clone = upstream.path.join(cloneParent, "repo");
        yield* upstream.git("clone", "--quiet", upstream.root, clone);
        // Staging moves on origin after the clone, so only a fetch can see this commit.
        yield* upstream.git("checkout", "--quiet", "-b", "staging");
        yield* upstream.fileSystem.writeFileString(upstream.path.join(upstream.root, "staging.txt"), "s\n");
        yield* upstream.git("add", ".");
        yield* upstream.git("commit", "-m", "staging work");

        const projectId = ProjectId.make("project-base-branch");
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-base-branch"),
          projectId,
          title: "Base branch",
          workspaceRoot: clone,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "project.orchestration.set",
          commandId: CommandId.make("cmd-policy-base-branch"),
          projectId,
          orchestration: { ...DEFAULT_PROJECT_ORCHESTRATION, baseBranch: "staging" },
        });
        const cardId = CardId.make("card-base-branch");
        yield* engine.dispatch({
          type: "card.create",
          commandId: CommandId.make("cmd-card-base-branch"),
          cardId,
          projectId,
          title: "On staging",
          spec: "",
          tags: [],
          createdAt: now,
        });

        const info = yield* workspace.ensure(cardId);
        expect(yield* upstream.gitIn(info.worktreePath, "log", "-1", "--format=%s")).toBe("staging work");
        expect((yield* workspace.projectFile(cardId)).baseRef).toBe("origin/staging");

        yield* upstream.fileSystem.writeFileString(upstream.path.join(info.worktreePath, "added.txt"), "new\n");
        const { baseBranch, diff } = yield* workspace.diff(cardId);
        expect(baseBranch).toBe("staging");
        expect(diff).toContain("+++ b/added.txt");
        expect(diff).not.toContain("staging.txt");
        // The temp index leaves the worktree's own index alone.
        expect(yield* upstream.gitIn(info.worktreePath, "status", "--porcelain")).toBe("?? added.txt");
        expect(yield* workspace.changedFiles(cardId)).toEqual(["added.txt"]);
      }),
    ),
  );

  it.effect("runs checks in order with the card env, stopping at the first failure or timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const world = yield* makeProject("checks", []);
        yield* world.commitProjectFile({
          checks: [
            {
              id: "env",
              name: "Env",
              command: 'printf "workers=%s slug=%s" "$VITEST_MAX_WORKERS" "$ISKRA_CARD_SLUG"',
              targetedCommand: "printf 'filter=%s' {filter}",
            },
            { id: "boom", name: "Boom", command: "echo boom; exit 3" },
            { id: "never", name: "Never", command: "touch never.txt" },
            { id: "ci", name: "CI only", command: "exit 1", source: "ci" },
          ],
        });
        const cardId = CardId.make("card-checks");
        yield* world.createCard(cardId, "Checks");
        const info = yield* workspace.ensure(cardId);

        const full = yield* workspace.runChecks({ cardId, scope: "full" });
        expect(full.passed).toBe(false);
        expect(full.results.map((result) => [result.id, result.exitCode, result.timedOut])).toEqual([
          ["env", 0, false],
          ["boom", 3, false],
        ]);
        expect(full.results[0]!.logTail).toMatch(/^workers=\d+ slug=cchecks$/);
        expect(full.results[1]!.logTail).toBe("boom");
        expect(yield* world.fileSystem.readFileString(full.results[1]!.logArtifactPath!)).toBe("boom\n");
        expect(yield* world.fileSystem.exists(world.path.join(info.worktreePath, "never.txt"))).toBe(false);

        const targeted = yield* workspace.runChecks({ cardId, scope: "targeted", filter: "a b'c" });
        expect(targeted.results[0]!.logTail).toBe("filter=a b'c");
      }),
    ),
  );

  it.effect("renders env files with ports, slug and workspace secrets, and refuses setup-only ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const settings = yield* ServerSettingsService;
        const secretStore = yield* ServerSecretStore;
        const setup = script("setup", 'printf "%s" "$DB_PASSWORD" > "$ISKRA_PROJECT_ROOT/setup-saw.txt"', {
          role: "setup",
        });
        const env = yield* makeProject("env", [setup]);
        const leak = yield* makeProject("leak", [setup]);
        const secrets = [
          { name: "TOKEN", exposure: "workspace" as const },
          { name: "DB_PASSWORD", exposure: "setup" as const },
        ];
        const runtime = (yield* settings.getSettings).cardRuntime;
        yield* settings.updateSettings({
          cardRuntime: { ...runtime, secrets: { [env.projectId]: secrets, [leak.projectId]: secrets } },
        });
        for (const projectId of [env.projectId, leak.projectId]) {
          yield* secretStore.set(
            CardWorkspace.cardSecretStoreName(projectId, "TOKEN"),
            new TextEncoder().encode("tok-123"),
          );
          yield* secretStore.set(
            CardWorkspace.cardSecretStoreName(projectId, "DB_PASSWORD"),
            new TextEncoder().encode("pw-456"),
          );
        }
        const envFiles = [{ template: ".env.iskra", target: ".env.local" }];
        yield* env.commitProjectFile(
          { ports: { web: 0, api: 3 }, envFiles },
          {
            ".env.iskra": "WEB=${port:web}\nAPI=${port:api}\nDB=hc_${card:slug}\nTOKEN=${secret:TOKEN}\n",
            ".gitignore": ".env.local\n",
          },
        );
        yield* leak.commitProjectFile(
          { envFiles },
          { ".env.iskra": "DB=${secret:DB_PASSWORD}\n", ".gitignore": ".env.local\n" },
        );

        yield* env.createCard("card-env", "Env");
        const info = yield* workspace.ensure(CardId.make("card-env"));
        expect(
          yield* env.fileSystem.readFileString(env.path.join(info.worktreePath, ".env.local")),
        ).toBe(`WEB=${info.portBase}\nAPI=${info.portBase + 3}\nDB=hc_cardenv\nTOKEN=tok-123\n`);
        expect(yield* env.fileSystem.readFileString(env.path.join(env.root, "setup-saw.txt"))).toBe("pw-456");

        yield* leak.createCard("card-leak", "Leak");
        const error = yield* Effect.flip(workspace.ensure(CardId.make("card-leak")));
        expect(error.message).toBe("Secret DB_PASSWORD is setup-only and can't be written into the worktree.");
        expect((yield* leak.card("card-leak"))?.worktreePath).toBeNull();
        expect(yield* leak.cardBranches).toEqual([]);
      }),
    ),
  );

  it.effect("skips a port block when any of its ports is taken, not only the first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const world = yield* makeProject("port-probe", []);
        const listenOn = (port: number) =>
          Effect.acquireRelease(
            Effect.callback<NodeNet.Server | null>((resume) => {
              const server = NodeNet.createServer();
              server.once("error", () => resume(Effect.succeed(null)));
              server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
            }),
            (server) => Effect.sync(() => server?.close()),
          );
        const taken = new Set(
          ((yield* snapshotQuery.getCommandReadModel()).cards ?? []).flatMap((card) =>
            card.portBase === null ? [] : [card.portBase],
          ),
        );
        // The first block nobody holds whose seventh port we can take for ourselves.
        let candidate = 42_000;
        while (taken.has(candidate) || (yield* listenOn(candidate + 7)) === null) {
          candidate += 10;
        }

        yield* world.createCard("card-probe", "Probe");
        const info = yield* workspace.ensure(CardId.make("card-probe"));
        expect(info.portBase).toBeGreaterThan(candidate);
      }),
    ),
  );

  it.effect("prepares two cards at once: locks are per card, not global", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* CardWorkspace.CardWorkspace;
        const settings = yield* ServerSettingsService;
        const runtime = (yield* settings.getSettings).cardRuntime;
        yield* settings.updateSettings({ cardRuntime: { ...runtime, heavyJobConcurrency: 2 } });
        // Each setup waits until both have started; a global lock would time this out.
        const world = yield* makeProject("parallel", [
          script(
            "setup",
            'touch "$ISKRA_PROJECT_ROOT/started-$ISKRA_CARD_ID"; for i in $(seq 200); do [ "$(ls "$ISKRA_PROJECT_ROOT" | grep -c "^started-")" -ge 2 ] && exit 0; sleep 0.05; done; exit 1',
            { role: "setup" },
          ),
        ]);
        yield* world.createCard("card-left", "Left");
        yield* world.createCard("card-right", "Right");

        const [left, right] = yield* Effect.all(
          [workspace.ensure(CardId.make("card-left")), workspace.ensure(CardId.make("card-right"))],
          { concurrency: 2 },
        );
        expect(left.portBase).not.toBe(right.portBase);
        expect(left.worktreePath).not.toBe(right.worktreePath);
      }),
    ),
  );
});

it("finds the exclusive paths a card's changes touch and tells other cards what to do", () => {
  const policy = {
    exclusivePaths: [
      { glob: "packages/core/db/migrations/**", afterRebase: "pnpm db:generate" },
      { glob: "pnpm-lock.yaml", afterRebase: null },
    ],
  };
  expect(
    CardWorkspace.exclusivePathConflicts(
      ["apps/web/page.tsx", "packages/core/db/migrations/0042_add.sql"],
      policy,
    ),
  ).toEqual([policy.exclusivePaths[0]]);
  expect(CardWorkspace.exclusivePathConflicts(["packages/core/db/schema.ts"], policy)).toEqual([]);
  expect(
    CardWorkspace.exclusivePathReturnMessage({ ...policy.exclusivePaths[0]!, baseRef: "origin/staging" }),
  ).toBe(
    "Another card changed packages/core/db/migrations/**. Rebase onto origin/staging, then run `pnpm db:generate` before asking for review.",
  );
});

// Live clock, so the check's timeout really elapses.
it.live("kills a check at its timeout and keeps the output it wrote", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("slow-check", []);
      yield* world.commitProjectFile({
        checks: [{ id: "slow", name: "Slow", command: "echo started; sleep 30", timeoutMinutes: 0.02 }],
      });
      const cardId = CardId.make("card-slow-check");
      yield* world.createCard(cardId, "Slow");
      yield* workspace.ensure(cardId);

      const slow = yield* workspace.runChecks({ cardId, scope: "full" });
      expect(slow.passed).toBe(false);
      expect(slow.results).toMatchObject([
        { id: "slow", exitCode: null, timedOut: true, logTail: "started" },
      ]);
      expect(slow.results[0]!.durationMs).toBeLessThan(20_000);
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-slow-check-", fakeTerminals))),
);

/**
 * Terminals that really run what is written to them, so services listen: each written command is
 * spawned in its own process group, and closing a terminal (or the test's scope) kills that group.
 */
const makeSpawningTerminals = () => {
  const opened = new Map<string, { readonly cwd: string; readonly env: Record<string, string> }>();
  const running = new Map<string, NodeChildProcess.ChildProcess>();
  const opens: Array<string> = [];
  const key = (threadId: string, terminalId: string) => `${threadId}|${terminalId}`;
  const killWhere = (matches: (entry: string) => boolean) => {
    for (const [entry, child] of running) {
      if (!matches(entry)) continue;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      running.delete(entry);
    }
  };
  const layer = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.sync(() => {
        opens.push(key(input.threadId, input.terminalId));
        opened.set(key(input.threadId, input.terminalId), { cwd: input.cwd, env: { ...input.env } });
        return {} as never;
      }),
    write: (input) =>
      Effect.sync(() => {
        const entry = key(input.threadId, input.terminalId);
        const terminal = opened.get(entry)!;
        running.set(
          entry,
          NodeChildProcess.spawn("sh", ["-c", input.data.replace(/\r$/, "")], {
            cwd: terminal.cwd,
            env: { ...process.env, ...terminal.env },
            detached: true,
            stdio: "ignore",
          }),
        );
      }),
    close: (input) =>
      Effect.sync(() =>
        killWhere((entry) =>
          input.terminalId === undefined
            ? entry.startsWith(`${input.threadId}|`)
            : entry === key(input.threadId, input.terminalId),
        ),
      ),
  });
  return {
    layer,
    opens,
    /** Kills every process a terminal thread runs, as a server restart would. */
    killThread: (threadId: string) => killWhere((entry) => entry.startsWith(`${threadId}|`)),
    killAll: Effect.sync(() => killWhere(() => true)),
  };
};

const listening = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
  });

const httpService = {
  name: "api",
  kind: "fake",
  port: "web",
  start: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(+process.env.ISKRA_PORT_WEB,'127.0.0.1')"`,
  ready: { kind: "http", path: "/", timeoutSeconds: 20 },
};

// Live clock: services really start and their ready probes really wait.
it.live("snapshots a commit detached on its own ports with services up, and removes it on release", () => {
  const terminals = makeSpawningTerminals();
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => terminals.killAll);
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("snapshot", []);
      yield* world.commitProjectFile({ ports: { web: 0 }, services: [httpService] });
      const cardId = CardId.make("card-snapshot");
      yield* world.createCard(cardId, "Snapshot");
      const info = yield* workspace.ensure(cardId);
      expect(yield* listening(info.portBase)).toBe(true);

      yield* world.fileSystem.writeFileString(world.path.join(info.worktreePath, "done.txt"), "v1\n");
      yield* world.gitIn(info.worktreePath, "add", ".");
      yield* world.gitIn(info.worktreePath, "commit", "-m", "v1");
      const headSha = yield* world.gitIn(info.worktreePath, "rev-parse", "HEAD");
      // Work after the commit stays out of the snapshot.
      yield* world.fileSystem.writeFileString(world.path.join(info.worktreePath, "done.txt"), "v2\n");

      const snapshot = yield* workspace.snapshot(cardId, headSha);
      expect(snapshot.portBase).not.toBe(info.portBase);
      expect(snapshot.ports).toEqual({ web: snapshot.portBase });
      expect(yield* world.gitIn(snapshot.path, "rev-parse", "HEAD")).toBe(headSha);
      expect(yield* world.gitIn(snapshot.path, "status", "--porcelain", "--branch")).toBe(
        "## HEAD (no branch)",
      );
      expect(yield* world.fileSystem.readFileString(world.path.join(snapshot.path, "done.txt"))).toBe(
        "v1\n",
      );
      expect(yield* listening(snapshot.portBase)).toBe(true);
      expect(yield* world.cardBranches).toEqual([info.branch]);

      yield* snapshot.release;
      yield* snapshot.release;
      expect(yield* world.fileSystem.exists(snapshot.path)).toBe(false);
      expect(yield* world.git("worktree", "list", "--porcelain")).not.toContain(snapshot.path);
      expect(yield* listening(snapshot.portBase)).toBe(false);
      // The card's own services and worktree are untouched.
      expect(yield* listening(info.portBase)).toBe(true);
      expect(yield* world.fileSystem.exists(info.worktreePath)).toBe(true);
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-snapshot-", terminals.layer)));
});

it.live("restarts services a restart lost and leaves running ones alone", () => {
  const terminals = makeSpawningTerminals();
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => terminals.killAll);
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("services", []);
      yield* world.commitProjectFile({ ports: { web: 0 }, services: [httpService] });
      const cardId = CardId.make("card-services");
      yield* world.createCard(cardId, "Services");
      const info = yield* workspace.ensure(cardId);
      expect(terminals.opens).toHaveLength(1);

      // Already up: nothing starts again.
      yield* workspace.ensureServices(cardId);
      expect(terminals.opens).toHaveLength(1);

      terminals.killThread(CardWorkspace.cardTerminalThreadId(cardId));
      // The killed service frees its port once the kernel reaps it.
      yield* listening(info.portBase).pipe(
        Effect.repeat({ until: (up) => !up, schedule: Schedule.spaced("20 millis") }),
      );
      // Two callers at once start it once.
      yield* Effect.all([workspace.ensureServices(cardId), workspace.ensureServices(cardId)], {
        concurrency: 2,
      });
      expect(terminals.opens).toHaveLength(2);
      expect(yield* listening(info.portBase)).toBe(true);
      expect(yield* workspace.serviceHealth(cardId)).toEqual([
        { kind: "service", name: "api", port: info.portBase, up: true },
      ]);
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-services-", terminals.layer)));
});

it.live("restarts a service started on an older commit, and not one at the worktree's HEAD", () => {
  const terminals = makeSpawningTerminals();
  // Serves body.txt as it was when the service started.
  const bodyService = {
    ...httpService,
    start: `node -e "const fs=require('fs');const b=fs.existsSync('body.txt')?fs.readFileSync('body.txt','utf8'):'v0';require('http').createServer((q,s)=>s.end(b)).listen(+process.env.ISKRA_PORT_WEB,'127.0.0.1')"`,
  };
  const body = (port: number) =>
    Effect.promise(() =>
      // @effect-diagnostics-next-line globalFetchInEffect:off - a loopback probe in a test.
      fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()),
    );
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => terminals.killAll);
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("service-head", []);
      yield* world.commitProjectFile({ ports: { web: 0 }, services: [bodyService] });
      const cardId = CardId.make("card-service-head");
      yield* world.createCard(cardId, "Service head");
      const info = yield* workspace.ensure(cardId);
      expect(yield* body(info.portBase)).toBe("v0");

      yield* world.fileSystem.writeFileString(world.path.join(info.worktreePath, "body.txt"), "v1");
      yield* world.gitIn(info.worktreePath, "add", ".");
      yield* world.gitIn(info.worktreePath, "commit", "-m", "v1");
      yield* workspace.ensureServices(cardId);
      expect(yield* body(info.portBase)).toBe("v1");
      expect(terminals.opens).toHaveLength(2);

      // At the same HEAD the running service is kept.
      yield* workspace.ensureServices(cardId);
      expect(terminals.opens).toHaveLength(2);
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-service-head-", terminals.layer)));
});

const journeyHitsWeb = `node -e "require('http').get('http://127.0.0.1:'+process.env.ISKRA_PORT_WEB+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(2))"`;

it.live("runs journeys in order against running services, stopping at the first failure or timeout", () => {
  const terminals = makeSpawningTerminals();
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => terminals.killAll);
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("journeys", []);
      yield* world.commitProjectFile({
        ports: { web: 0 },
        services: [httpService],
        journeys: [
          { id: "health", name: "Health", command: journeyHitsWeb },
          { id: "slow", name: "Slow", command: "echo waiting; sleep 30", timeoutMinutes: 0.02 },
          { id: "never", name: "Never", command: "touch never.txt" },
        ],
      });
      const cardId = CardId.make("card-journeys");
      yield* world.createCard(cardId, "Journeys");
      const info = yield* workspace.ensure(cardId);
      // A restart lost the service: the journeys bring it back before they run.
      terminals.killThread(CardWorkspace.cardTerminalThreadId(cardId));
      yield* listening(info.portBase).pipe(
        Effect.repeat({ until: (up) => !up, schedule: Schedule.spaced("20 millis") }),
      );

      const run = yield* workspace.runJourneys({ cardId });
      expect(run.passed).toBe(false);
      expect(run.results.map((result) => [result.id, result.exitCode, result.timedOut])).toEqual([
        ["health", 0, false],
        ["slow", null, true],
      ]);
      expect(run.results[1]!.logTail).toBe("waiting");
      expect(run.summary).toContain("Slow timed out.");
      expect(yield* world.fileSystem.exists(world.path.join(info.worktreePath, "never.txt"))).toBe(false);

      const bare = yield* makeProject("no-journeys", []);
      yield* bare.createCard("card-no-journeys", "None");
      yield* workspace.ensure(CardId.make("card-no-journeys"));
      expect(yield* workspace.runJourneys({ cardId: CardId.make("card-no-journeys") })).toEqual({
        passed: true,
        summary: "The project declares no journeys.",
        results: [],
      });
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-journeys-", terminals.layer)));
});

it.live("runs journeys again after the landing rebase and doesn't land when they fail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* CardWorkspace.CardWorkspace;
      const world = yield* makeProject("land-journeys", []);
      yield* world.commitProjectFile({
        checks: [{ id: "unit", name: "Unit", command: "true" }],
        journeys: [{ id: "clean", name: "Clean", command: "test ! -f broken.txt" }],
      });
      const good = CardId.make("card-land-good");
      const bad = CardId.make("card-land-bad");
      yield* world.createCard(good, "Good");
      yield* world.createCard(bad, "Bad");
      const goodInfo = yield* workspace.ensure(good);
      const badInfo = yield* workspace.ensure(bad);
      yield* world.fileSystem.writeFileString(world.path.join(goodInfo.worktreePath, "good.txt"), "ok\n");
      yield* world.fileSystem.writeFileString(world.path.join(badInfo.worktreePath, "bad.txt"), "ok\n");
      // Journeys pass in the card's worktree before landing.
      expect((yield* workspace.runJourneys({ cardId: bad })).passed).toBe(true);

      expect((yield* workspace.land(good)).kind).toBe("landed");
      // The base moves on to something the journey rejects; only the rebase brings it in.
      yield* world.fileSystem.writeFileString(world.path.join(world.root, "broken.txt"), "x\n");
      yield* world.git("add", ".");
      yield* world.git("commit", "-m", "break");

      const landed = yield* workspace.land(bad);
      expect(landed).toMatchObject({ kind: "checksFailed", results: [{ id: "clean", exitCode: 1 }] });
      expect(yield* world.git("log", "-1", "--format=%s")).toBe("break");
    }),
  ).pipe(Effect.provide(cardWorkspaceTestLayer("iskra-card-land-journeys-", fakeTerminals))),
);
