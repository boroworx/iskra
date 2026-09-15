import {
  AgentId,
  CardId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProjectionRunLivenessRepository } from "../persistence/Services/ProjectionRunLiveness.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ATTENTION_ACTIONS } from "./cardRules.ts";
import * as CardReversibilityReactor from "./CardReversibilityReactor.ts";
import { CardWorkspace } from "./CardWorkspace.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { cardWorkspaceTestLayer, makeGitRepo, nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const layer = CardReversibilityReactor.layer.pipe(
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-card-revert-test-")),
);

/**
 * A project on a real repository whose only check fails while `feature.txt` exists, and a card that
 * landed as the commit adding it. `landed` is that commit; `revert` asks for its revert.
 */
const makeWorld = Effect.fn("makeWorld")(function* (name: string, options: { readonly editAfter?: boolean } = {}) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* CardReversibilityReactor.CardReversibilityReactor;
  yield* reactor.start();
  const nextEvent = nextEventOn(yield* engine.subscribeDomainEvents);
  const repo = yield* makeGitRepo(`iskra-revert-${name}-`);
  const projectId = ProjectId.make(`project-${name}`);
  const agentId = AgentId.make(`agent-${name}`);
  const cardId = CardId.make(`card-${name}`);
  let commands = 0;
  const commandId = () => CommandId.make(`cmd-${name}-${(commands += 1)}`);

  yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "feature.txt"), "one\n");
  yield* repo.git("add", ".");
  yield* repo.git("commit", "-m", "Add the feature");
  const landed = yield* repo.git("rev-parse", "HEAD");
  if (options.editAfter === true) {
    yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "feature.txt"), "two\n");
    yield* repo.git("commit", "-am", "Change the feature");
  }

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
    scripts: [
      { id: "check", name: "Check", command: "test ! -f feature.txt", icon: "test", runOnWorktreeCreate: false, role: "check" },
    ],
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: commandId(),
    agentId,
    projectId,
    name,
    roleTags: [],
    rolePrompt: "",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
    capabilities: ["read", "write"],
    createdAt: now,
  });
  const steps: ReadonlyArray<OrchestrationCommand> = [
    {
      type: "card.create",
      commandId: commandId(),
      cardId,
      projectId,
      title: `Feature ${name}`,
      spec: "Add the feature.",
      tags: [],
      criteria: [{ id: "c1", text: "The feature exists.", verification: "automated" }],
      createdAt: now,
    },
    { type: "card.approve", commandId: commandId(), cardId },
    { type: "card.spec.skip", commandId: commandId(), cardId },
    { type: "card.assign", commandId: commandId(), cardId, agentId },
    { type: "card.work.start", commandId: commandId(), cardId },
    {
      type: "card.evidence.record",
      commandId: commandId(),
      cardId,
      evidenceId: `evidence-${name}`,
      headSha: landed,
      purpose: "review",
      items: [
        {
          itemId: "check:check",
          kind: "check",
          source: "local",
          name: "Check",
          criterionId: null,
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          logTail: "",
          artifactPath: null,
          unavailable: null,
        },
      ],
      flags: [],
      risks: null,
      recordedAt: now,
    },
    { type: "card.review.enter", commandId: commandId(), cardId, headSha: landed },
    {
      type: "card.landing.link",
      commandId: commandId(),
      cardId,
      landing: { mode: "local", url: null, number: null, headSha: null, draft: false, linkedAt: now },
    },
    { type: "card.merge.approve", commandId: commandId(), cardId },
    { type: "card.land", commandId: commandId(), cardId, landedSha: landed },
  ];
  for (const step of steps) yield* engine.dispatch(step);

  const revertCardId = CardId.make(`card-${name}-revert`);
  const cardOf = (id: CardId) =>
    snapshotQuery.getCommandReadModel().pipe(Effect.map((model) => model.cards?.find((card) => card.id === id)));
  const revert = engine.dispatch({
    type: "card.revert",
    commandId: commandId(),
    cardId,
    revertCardId,
    createdAt: now,
  });
  return { repo, landed, revertCardId, revert, cardOf, nextEvent, reactor };
});

it.layer(layer)("CardReversibilityReactor", (it) => {
  it.effect("reverts a landed card's commit in a new worktree and sends it to review with evidence, no agent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("clean");
      const inReview = world.nextEvent(
        "card.status-changed",
        (event) => event.payload.cardId === world.revertCardId && event.payload.to === "inReview",
      );
      yield* world.revert;
      yield* inReview;

      const card = yield* world.cardOf(world.revertCardId);
      expect(card).toMatchObject({
        status: "inReview",
        delegateAgentId: null,
        origin: { kind: "revert" },
        evidence: { purpose: "review", passed: true },
      });
      const message = yield* world.repo.gitIn(card!.worktreePath!, "log", "-1", "--format=%B");
      expect(message).toContain(`This reverts commit ${world.landed}`);
    }),
  );

  it.effect("aborts a conflicting revert, leaves the worktree clean and asks a person to assign an agent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("conflict", { editAfter: true });
      const conflict = world.nextEvent(
        "card.activity-recorded",
        (event) => event.payload.cardId === world.revertCardId && event.payload.reason?.code === "revertConflict",
      );
      yield* world.revert;
      const recorded = yield* conflict;
      expect(recorded.payload.body).toBe(
        `Reverting ${world.landed.slice(0, 7)} conflicts in feature.txt. Assign an agent to finish the revert.`,
      );

      const card = yield* world.cardOf(world.revertCardId);
      expect(card).toMatchObject({ status: "inProgress", evidence: null });
      expect(card?.attention).toMatchObject([
        { code: "revertConflict", actions: ATTENTION_ACTIONS.revertConflict },
      ]);
      expect(yield* world.repo.gitIn(card!.worktreePath!, "status", "--porcelain")).toBe("");
    }),
  );
});

it.effect("restores a card's worktree through its owner thread's checkpoints and tells the builder", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const cardId = CardId.make("card-restore");
    const threadId = ThreadId.make("thread-owner-restore");
    const requested = {
      type: "card.checkpoint-restore-requested",
      eventId: EventId.make("event-restore"),
      payload: { cardId, turnCount: 2, requestedAt: now },
    } as unknown as OrchestrationEvent;
    const fakes = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
        subscribeDomainEvents: Effect.succeed(Stream.make(requested)),
      }),
      Layer.mock(ProjectionRunLivenessRepository)({
        listCardOwnerRuns: () =>
          Effect.succeed([
            { threadId, restarts: 0, startedAt: now, endedAt: now, sessionStatus: "stopped", lastError: null },
          ]),
      }),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(CardWorkspace)({}),
      Layer.mock(HostAdmission)({}),
      Layer.mock(ProcessRunner)({}),
    );
    yield* Effect.gen(function* () {
      const reactor = yield* CardReversibilityReactor.CardReversibilityReactor;
      yield* reactor.start();
      const commands = yield* Ref.get(dispatched).pipe(Effect.repeat({ until: (all) => all.length >= 2 }));
      expect(commands).toMatchObject([
        { type: "thread.checkpoint.revert", threadId, turnCount: 2 },
        {
          type: "card.activity.record",
          cardId,
          deliverTo: "builder",
          body: "A person restored the worktree to turn 2.",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.effect(CardReversibilityReactor.CardReversibilityReactor, CardReversibilityReactor.make).pipe(
          Layer.provide(fakes),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
