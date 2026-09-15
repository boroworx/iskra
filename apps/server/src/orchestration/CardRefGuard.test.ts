import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as CardRefGuard from "./CardRefGuard.ts";
import * as CardScheduler from "./CardScheduler.ts";
import * as CardSessionReactor from "./CardSessionReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as HostAdmission from "./HostAdmission.ts";
import {
  cardWorkspaceTestLayer,
  makeGitRepo,
  nextEventOn,
  now,
  providerSession,
} from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

it("finds the refs created, deleted or moved outside the exclusions", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly before: Record<string, string>;
    readonly after: Record<string, string>;
    readonly exclusions?: ReadonlyArray<string>;
    readonly expected: ReadonlyArray<CardRefGuard.RefChange>;
  }> = [
    { name: "nothing changed", before: { "refs/heads/main": "a" }, after: { "refs/heads/main": "a" }, expected: [] },
    {
      name: "a branch moved",
      before: { "refs/heads/main": "a" },
      after: { "refs/heads/main": "b" },
      expected: [{ ref: "refs/heads/main", kind: "moved", before: "a", after: "b" }],
    },
    {
      name: "a tag created",
      before: {},
      after: { "refs/tags/v1": "c" },
      expected: [{ ref: "refs/tags/v1", kind: "created", before: null, after: "c" }],
    },
    {
      name: "a branch deleted",
      before: { "refs/heads/side": "d" },
      after: {},
      expected: [{ ref: "refs/heads/side", kind: "deleted", before: "d", after: null }],
    },
    {
      name: "the card's own branch is excluded, the rest sorted",
      before: { "refs/heads/main": "a", "refs/heads/iskra/card": "e" },
      after: { "refs/heads/zeta": "f", "refs/heads/main": "b", "refs/heads/iskra/card": "g" },
      exclusions: ["refs/heads/iskra/card"],
      expected: [
        { ref: "refs/heads/main", kind: "moved", before: "a", after: "b" },
        { ref: "refs/heads/zeta", kind: "created", before: null, after: "f" },
      ],
    },
  ];
  for (const testCase of cases) {
    expect(
      CardRefGuard.refChanges(
        new Map(Object.entries(testCase.before)),
        new Map(Object.entries(testCase.after)),
        new Set(testCase.exclusions ?? []),
      ),
      testCase.name,
    ).toEqual(testCase.expected);
  }
});

const layer = Layer.mergeAll(CardSessionReactor.layer, CardScheduler.layer).pipe(
  Layer.provideMerge(
    HostAdmission.layerWithSample(Effect.succeed({ load1: 0, cores: 8, freeMemRatio: 1 })),
  ),
  Layer.provide(ServerSettings.layerTest({ cardRuntime: { environmentSessionCap: 100 } })),
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-card-ref-guard-test-")),
);

/** A real repository as a project whose card's owner is mid-turn in its linked worktree, under guard. */
const makeWorld = Effect.fn("makeWorld")(function* (name: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const guard = yield* CardRefGuard.CardRefGuard;
  yield* (yield* CardSessionReactor.CardSessionReactor).start();
  yield* (yield* CardScheduler.CardScheduler).start();
  yield* guard.start();
  const events = yield* engine.subscribeDomainEvents;
  const nextEvent = nextEventOn(events);
  const { setSession } = yield* providerSession;
  const { fileSystem, path, root, git, gitIn } = yield* makeGitRepo(`iskra-ref-guard-repo-${name}-`);

  const projectId = ProjectId.make(`project-${name}`);
  const cardId = CardId.make(`card-${name}`);
  const agentId = AgentId.make(`agent-${name}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: name,
    workspaceRoot: root,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: CommandId.make(`cmd-policy-${name}`),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      checksWaived: true,
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: CommandId.make(`cmd-agent-${name}`),
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
    commandId: CommandId.make(`cmd-card-${name}`),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "Limit each key to 100 requests a minute.",
    tags: [],
    criteria: [{ id: "limit", text: "Each key gets 100 requests a minute.", verification: "automated" }],
    createdAt: now,
  });
  yield* engine.dispatch({ type: "card.approve", commandId: CommandId.make(`cmd-approve-${name}`), cardId });
  yield* engine.dispatch({ type: "card.spec.skip", commandId: CommandId.make(`cmd-skip-${name}`), cardId });
  yield* engine.dispatch({ type: "card.assign", commandId: CommandId.make(`cmd-assign-${name}`), cardId, agentId });

  const started = yield* nextEvent("card.session-started");
  yield* nextEvent("thread.message-sent", (event) => event.payload.threadId === started.payload.threadId);
  // The owner's first turn has been requested and its refs snapshotted.
  yield* guard.drain;
  const readCard = snapshotQuery
    .getCommandReadModel()
    .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === cardId)));
  const worktree = (yield* readCard)?.worktreePath ?? "";
  expect(worktree).not.toBe("");

  /** The agent commits a file on the card's own branch and returns the new head. */
  const commitInWorktree = Effect.fn("commitInWorktree")(function* (file: string) {
    yield* fileSystem.writeFileString(path.join(worktree, file), `${file}\n`);
    yield* gitIn(worktree, "add", ".");
    yield* gitIn(worktree, "commit", "-m", file);
    return yield* gitIn(worktree, "rev-parse", "HEAD");
  });

  /** The report's activity, once the turn settled and the guard recorded it and paused the card. */
  const settleAndReport = Effect.gen(function* () {
    yield* setSession(started.payload.threadId, "ready", null);
    const flagged = yield* nextEvent(
      "card.activity-recorded",
      (event) => event.payload.reason?.code === CardRefGuard.REF_MOVED_OUTSIDE_CARD,
    );
    const paused = yield* nextEvent("card.paused", (event) => event.payload.cardId === cardId);
    return { flagged, paused };
  });

  /** A person restores the report's refs; returns the guard's account of what it did. */
  const restore = (activityId: string, refs?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.refs.restore",
        commandId: CommandId.make(`cmd-restore-${activityId}`),
        cardId,
        activityId,
        ...(refs === undefined ? {} : { refs }),
      });
      return yield* nextEvent(
        "card.activity-recorded",
        (event) => event.payload.activityId === `${activityId}:restored`,
      );
    });

  return {
    cardId,
    threadId: started.payload.threadId,
    worktree,
    git,
    gitIn,
    guard,
    readCard,
    commitInWorktree,
    settle: setSession(started.payload.threadId, "ready", null),
    settleAndReport,
    restore,
    workspace: yield* CardWorkspace.CardWorkspace,
  };
});

it.layer(layer)("CardRefGuard", (it) => {
  it.effect("reports refs the agent changed and pauses the card without changing them; a person's restore puts them back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("rogue");
        const main = yield* world.git("rev-parse", "refs/heads/main");

        // The agent commits on its own branch, then moves the person's checked-out branch and adds one.
        const head = yield* world.commitInWorktree("limits.txt");
        yield* world.gitIn(world.worktree, "update-ref", "refs/heads/main", head);
        yield* world.gitIn(world.worktree, "update-ref", "refs/heads/rogue", head);
        const { flagged, paused } = yield* world.settleAndReport;

        // Nothing moves until a person decides.
        expect(yield* world.git("rev-parse", "refs/heads/main")).toBe(head);
        expect(yield* world.git("rev-parse", "refs/heads/rogue")).toBe(head);
        expect(flagged.payload).toMatchObject({
          cardId: world.cardId,
          kind: "error",
          author: { kind: "system" },
          runThreadId: world.threadId,
          elicitation: { kind: "refsChanged", options: [{ id: "restore" }, { id: "keep" }] },
          refChanges: [
            { ref: "refs/heads/main", kind: "moved", before: main, after: head },
            { ref: "refs/heads/rogue", kind: "created", before: null, after: head },
          ],
        });
        expect(flagged.payload.body).toBe(
          `Refs outside this card changed during @builder's turn: refs/heads/main moved ${main.slice(0, 7)} → ${head.slice(0, 7)}, refs/heads/rogue created at ${head.slice(0, 7)}. If the agent did this, restore them; if you did, keep them.`,
        );
        expect(paused.payload).toMatchObject({ by: "system", reason: flagged.payload.reason });
        expect((yield* world.readCard)?.openElicitations.map((open) => open.kind)).toEqual(["refsChanged"]);

        const restored = yield* world.restore(flagged.payload.activityId);
        expect(restored.payload.body).toBe(`Restored refs/heads/main to ${main.slice(0, 7)}.\nDeleted refs/heads/rogue.`);
        expect(yield* world.git("rev-parse", "refs/heads/main")).toBe(main);
        expect(yield* world.git("for-each-ref", "refs/heads/rogue")).toBe("");
        // The card's own commit stays, the question is closed and resuming is left to the person.
        expect(yield* world.gitIn(world.worktree, "rev-parse", "HEAD")).toBe(head);
        expect(yield* world.readCard).toMatchObject({ openElicitations: [], paused: { by: "system" } });
      }),
    ),
  );

  it.effect("skips a reported ref that changed again before the restore", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("again");
        const head = yield* world.commitInWorktree("limits.txt");
        yield* world.gitIn(world.worktree, "update-ref", "refs/heads/main", head);
        yield* world.gitIn(world.worktree, "tag", "rogue-tag");
        const { flagged } = yield* world.settleAndReport;

        // The person commits on main after the report.
        const later = yield* world.commitInWorktree("later.txt");
        yield* world.git("update-ref", "refs/heads/main", later);

        const restored = yield* world.restore(flagged.payload.activityId);
        expect(restored.payload.body).toBe(
          `Skipped refs/heads/main: it changed again after the report (now ${later.slice(0, 7)}), so it was left as it is.\nDeleted refs/tags/rogue-tag.`,
        );
        expect(yield* world.git("rev-parse", "refs/heads/main")).toBe(later);
        expect(yield* world.git("for-each-ref", "refs/tags")).toBe("");
      }),
    ),
  );

  it.effect("reports nothing for the card's own commits and Iskra's landing of the base", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("landing");
        yield* world.commitInWorktree("limits.txt");

        // Iskra fast-forwards main to the card's branch during the turn.
        const landed = yield* world.workspace.land(world.cardId);
        expect(landed.kind).toBe("landed");
        const head = yield* world.gitIn(world.worktree, "rev-parse", "HEAD");
        expect(yield* world.git("rev-parse", "refs/heads/main")).toBe(head);

        yield* world.settle;
        yield* world.guard.drain;
        expect(yield* world.readCard).toMatchObject({ paused: null, openElicitations: [] });
        expect(yield* world.git("rev-parse", "refs/heads/main")).toBe(head);
      }),
    ),
  );
});
