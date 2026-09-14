import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
  type ProjectScript,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CardReviewReactor from "./CardReviewReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { cardWorkspaceTestLayer, makeGitRepo, nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const layer = CardReviewReactor.layer.pipe(
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-card-review-test-")),
);

/**
 * A committed repository as a project with the given check scripts, the review
 * reactor and workspace teardown running, and cards taken to work in their own
 * worktrees. `nextEvent` consumes one tap, so await events in the order they happen.
 */
const makeWorld = Effect.fn("makeWorld")(function* (
  name: string,
  checks: ReadonlyArray<ProjectScript>,
) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  yield* workspace.start();
  const reactor = yield* CardReviewReactor.CardReviewReactor;
  yield* reactor.start();
  const events = yield* engine.subscribeDomainEvents;
  // A second tap, so waiting for teardown cannot consume events the test awaits.
  const teardownEvents = yield* engine.subscribeDomainEvents;
  const { fileSystem, path, root, gitIn } = yield* makeGitRepo(`iskra-review-repo-${name}-`);

  const projectId = ProjectId.make(`project-${name}`);
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
    commandId: CommandId.make(`cmd-guard-${name}`),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
  });
  yield* engine.dispatch({
    type: "project.meta.update",
    commandId: CommandId.make(`cmd-scripts-${name}`),
    projectId,
    scripts: [...checks],
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: CommandId.make(`cmd-agent-${name}`),
    agentId,
    projectId,
    name,
    roleTags: [],
    rolePrompt: "",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-4-5",
    },
    capabilities: ["read", "write"],
    createdAt: now,
  });

  /** A card at work in its own worktree, as if its agent had started. */
  const cardAtWork = Effect.fn("cardAtWork")(function* (id: string) {
    const cardId = CardId.make(`card-${name}-${id}`);
    const on = (type: "card.approve" | "card.spec.skip" | "card.work.start") =>
      engine.dispatch({ type, commandId: CommandId.make(`cmd-${type}-${cardId}`), cardId });
    yield* engine.dispatch({
      type: "card.create",
      commandId: CommandId.make(`cmd-card-${cardId}`),
      cardId,
      projectId,
      title: `Card ${id}`,
      spec: "",
      tags: [],
      criteria: [{ id: "works", text: "It works.", verification: "automated" }],
      createdAt: now,
    });
    yield* on("card.approve");
    yield* on("card.spec.skip");
    yield* engine.dispatch({
      type: "card.assign",
      commandId: CommandId.make(`cmd-assign-${cardId}`),
      cardId,
      agentId,
    });
    yield* on("card.work.start");
    const info = yield* workspace.ensure(cardId);
    let reviews = 0;
    return {
      cardId,
      write: (file: string, text: string) =>
        fileSystem.writeFileString(path.join(info.worktreePath, file), text),
      requestReview: () => {
        reviews += 1;
        return engine.dispatch({
          type: "card.review.request",
          commandId: CommandId.make(`cmd-review-${cardId}-${reviews}`),
          cardId,
        });
      },
      approveMerge: () =>
        engine.dispatch({
          type: "card.merge.approve",
          commandId: CommandId.make(`cmd-merge-${cardId}`),
          cardId,
        }),
    };
  });

  const nextEvent = nextEventOn(events);

  /** Waits until landed cards' worktrees are removed, so the repository can be cleaned up. */
  const workspacesCleared = (cardIds: ReadonlyArray<CardId>) =>
    teardownEvents.pipe(
      Stream.filter(
        (event) => event.type === "card.workspace-cleared" && cardIds.includes(event.payload.cardId),
      ),
      Stream.take(cardIds.length),
      Stream.runDrain,
    );

  const cardOf = (cardId: CardId) =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === cardId)));

  const returnedToWork = (cardId: CardId) =>
    nextEvent(
      "card.status-changed",
      (event) => event.payload.cardId === cardId && event.payload.move === "returnToWork",
    );

  return { root, gitIn, reactor, cardAtWork, nextEvent, workspacesCleared, cardOf, returnedToWork };
});

const checkScript = (command: string): ProjectScript => ({
  id: "test",
  name: "test",
  command,
  icon: "test",
  runOnWorktreeCreate: false,
  role: "check",
});

it.layer(layer)("CardReviewReactor", (it) => {
  it.effect("sends failing checks back to the agent until they pass, with no person involved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("autofix", [checkScript("test -f fixed.txt")]);
        const card = yield* world.cardAtWork("limits");

        yield* card.requestReview();
        const note = yield* world.nextEvent(
          "card.message-posted",
          (event) => event.payload.cardId === card.cardId && event.payload.forOwner,
        );
        expect(note.payload.body).toContain("The project's checks failed (attempt 1 of 3)");
        const returned = yield* world.returnedToWork(card.cardId);
        expect(returned.payload.reason).toBe("The project's checks failed.");

        // The agent fixes it and asks again.
        yield* card.write("fixed.txt", "done\n");
        yield* card.requestReview();
        const passed = yield* world.nextEvent(
          "card.checks-updated",
          (event) =>
            event.payload.cardId === card.cardId && event.payload.checks.state === "passed",
        );
        expect(passed.payload.checks).toMatchObject({ failedRuns: 0, summary: "test passed." });
        expect((yield* world.cardOf(card.cardId))?.status).toBe("inReview");
      }),
    ),
  );

  it.effect("stops sending checks back after the third failure in a row and waits for a person", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("exhausted", [checkScript("exit 1")]);
        const card = yield* world.cardAtWork("flaky");

        for (const attempt of [1, 2]) {
          yield* card.requestReview();
          yield* world.returnedToWork(card.cardId);
          expect((yield* world.cardOf(card.cardId))?.checks?.failedRuns).toBe(attempt);
        }
        yield* card.requestReview();
        yield* world.nextEvent(
          "card.checks-updated",
          (event) => event.payload.cardId === card.cardId && event.payload.checks.failedRuns === 3,
        );
        yield* world.reactor.drain;

        const exhausted = yield* world.cardOf(card.cardId);
        expect(exhausted?.status).toBe("inReview");
        expect(exhausted?.checks).toMatchObject({ state: "failed", failedRuns: 3 });
      }),
    ),
  );

  it.effect("lands two approved cards one after the other", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("queue", []);
        const api = yield* world.cardAtWork("api");
        const web = yield* world.cardAtWork("web");
        yield* api.write("api.txt", "api\n");
        yield* web.write("web.txt", "web\n");
        yield* api.requestReview();
        yield* web.requestReview();
        yield* world.nextEvent(
          "card.checks-updated",
          (event) => event.payload.cardId === web.cardId && event.payload.checks.state === "passed",
        );

        yield* api.approveMerge();
        yield* web.approveMerge();
        const first = yield* world.nextEvent(
          "card.status-changed",
          (event) => event.payload.to === "landed",
        );
        const second = yield* world.nextEvent(
          "card.status-changed",
          (event) => event.payload.to === "landed",
        );

        expect([first.payload.cardId, second.payload.cardId]).toEqual([api.cardId, web.cardId]);
        expect(yield* world.gitIn(world.root, "show", "main:api.txt")).toBe("api");
        expect(yield* world.gitIn(world.root, "show", "main:web.txt")).toBe("web");
        // The checkout on main moved with it.
        expect(yield* world.gitIn(world.root, "status", "--porcelain")).toBe("");
        yield* world.workspacesCleared([api.cardId, web.cardId]);
      }),
    ),
  );

  it.effect("returns a conflicting card to work with the conflict, and flags an overlap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("conflict", []);
        const first = yield* world.cardAtWork("first");
        const second = yield* world.cardAtWork("second");
        const third = yield* world.cardAtWork("third");
        yield* first.write("README.md", "hello from first\n");
        yield* second.write("README.md", "hello from second\n");
        yield* third.write("README.md", "hello from third\n");
        yield* first.requestReview();
        yield* second.requestReview();
        yield* world.nextEvent(
          "card.checks-updated",
          (event) =>
            event.payload.cardId === second.cardId && event.payload.checks.state === "passed",
        );

        yield* first.approveMerge();
        yield* world.nextEvent(
          "card.status-changed",
          (event) => event.payload.cardId === first.cardId && event.payload.to === "landed",
        );
        // Still at work on the same file: flagged, and told to rebase.
        const overlap = yield* world.nextEvent(
          "card.relation-added",
          (event) => event.payload.cardId === third.cardId && event.payload.kind === "overlaps",
        );
        expect(overlap.payload.otherCardId).toBe(first.cardId);
        const rebaseNote = yield* world.nextEvent(
          "card.message-posted",
          (event) => event.payload.cardId === third.cardId,
        );
        expect(rebaseNote.payload.body).toContain("README.md");

        yield* second.approveMerge();
        const conflictNote = yield* world.nextEvent(
          "card.message-posted",
          (event) => event.payload.cardId === second.cardId && event.payload.forOwner,
        );
        expect(conflictNote.payload.body).toContain("conflicts in README.md");
        const returned = yield* world.returnedToWork(second.cardId);
        expect(returned.payload.reason).toBe("Rebasing onto main conflicts.");
        expect(yield* world.gitIn(world.root, "show", "main:README.md")).toBe("hello from first");
        yield* world.workspacesCleared([first.cardId]);
      }),
    ),
  );
});
