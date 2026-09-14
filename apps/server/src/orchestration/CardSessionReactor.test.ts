import {
  AgentId,
  CardId,
  ChannelId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  EventId,
  MessageId,
  ORPHANED_PROVIDER_SESSION_ERROR,
  ProjectId,
  ProviderInstanceId,
  TurnId,
  runSessionState,
  type RunCapability,
  type ThreadId,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
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

const layer = Layer.mergeAll(CardSessionReactor.layer, CardScheduler.layer).pipe(
  Layer.provideMerge(
    HostAdmission.layerWithSample(Effect.succeed({ load1: 0, cores: 8, freeMemRatio: 1 })),
  ),
  // Sessions from earlier tests stay live in the shared layer; the machine's cap would hold later cards.
  Layer.provide(ServerSettings.layerTest({ cardRuntime: { environmentSessionCap: 100 } })),
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-card-session-test-")),
);

/**
 * A committed git repository as a project with an approved card, three agents
 * and the reactors running. `nextEvent` consumes one tap on domain events, so
 * await events in the order they happen.
 */
const makeWorld = Effect.fn("makeWorld")(function* (
  name: string,
  spec: "skipped" | "draft" = "skipped",
) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  yield* (yield* CardWorkspace.CardWorkspace).start();
  const reactor = yield* CardSessionReactor.CardSessionReactor;
  yield* reactor.start();
  yield* (yield* CardScheduler.CardScheduler).start();
  const events = yield* engine.subscribeDomainEvents;
  const { fileSystem, path, root } = yield* makeGitRepo(`iskra-session-repo-${name}-`);

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
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: CommandId.make(`cmd-guard-${name}`),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
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
    criteria: [{ id: "limit", text: "Each key gets 100 requests a minute.", verification: "automated" }],
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
  if (spec === "skipped") {
    yield* engine.dispatch({
      type: "card.spec.skip",
      commandId: CommandId.make(`cmd-skip-${name}`),
      cardId,
    });
  }

  const nextEvent = nextEventOn(events);
  const { setSession, answer } = yield* providerSession;

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
        // The skip is recorded with who skipped, and every later brief says so.
        expect(first.payload.rendered.firstMessage).toContain("user: Skipped the plan gate.");
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
        // The settled turn measures the card's diff for its face on the board.
        const measured = yield* world.nextEvent("card.diff-measured");
        expect(measured.payload.diffStat).toEqual({ files: 1, additions: 1, deletions: 0 });

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

  it.effect("holds the owner behind the plan gate and posts a critic's findings to the card", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("gate", "draft");
        yield* world.assign("backend");
        yield* world.engine.dispatch({
          type: "card.spec.submit",
          commandId: CommandId.make("cmd-gate-submit"),
          cardId: world.cardId,
          agentId: world.agent("reviewer"),
        });

        // The draft spec starts the critic, not the assigned owner.
        const critic = yield* world.nextSession();
        expect(critic.payload).toMatchObject({
          role: "critic",
          agentId: world.agent("reviewer"),
          capabilities: ["read"],
        });
        yield* world.setSession(critic.payload.threadId, "running", "turn-critic");
        yield* world.answer(critic.payload.threadId, "turn-critic", "Say what happens past the limit.");
        yield* world.setSession(critic.payload.threadId, "ready", null);
        const findings = yield* world.nextEvent(
          "card.message-posted",
          (event) => event.payload.runThreadId === critic.payload.threadId,
        );
        expect(findings.payload).toMatchObject({
          authorKind: "agent",
          forOwner: false,
          body: "Say what happens past the limit.",
        });

        yield* world.engine.dispatch({
          type: "card.spec.approve",
          commandId: CommandId.make("cmd-gate-approve"),
          cardId: world.cardId,
        });
        const owner = yield* world.nextSession();
        expect(owner.payload).toMatchObject({ role: "owner", agentId: world.agent("backend") });
        expect(owner.payload.rendered.firstMessage).toContain("user: Approved the spec.");
      }),
    ),
  );

  it.effect("starts the owner as soon as a person approves and starts a proposal with a draft spec", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("go", "draft");
        const proposalId = CardId.make("card-go-proposal");
        yield* world.engine.dispatch({
          type: "card.create",
          commandId: CommandId.make("cmd-go-proposal"),
          cardId: proposalId,
          projectId: ProjectId.make("project-go"),
          title: "Landing page",
          spec: "A landing page for Iskra in apps/web.",
          tags: [],
          criteria: [{ id: "page", text: "The page renders.", verification: "automated" }],
          createdAt: now,
        });
        yield* world.engine.dispatch({
          type: "card.approve",
          commandId: CommandId.make("cmd-go-start"),
          cardId: proposalId,
          delegateAgentId: world.agent("frontend"),
        });

        const owner = yield* world.nextSession();
        expect(owner.payload).toMatchObject({
          cardId: proposalId,
          role: "owner",
          agentId: world.agent("frontend"),
        });
        expect(owner.payload.rendered.firstMessage).toContain("user: Approved the spec.");
        yield* world.nextEvent(
          "card.status-changed",
          (event) => event.payload.cardId === proposalId && event.payload.to === "inProgress",
        );
      }),
    ),
  );

  it.effect("reports a channel's card back to it as it starts, asks, goes to review and is dropped, waking no one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("progress");
        const channelId = ChannelId.make("channel-progress");
        const cardId = CardId.make("card-progress-page");
        yield* world.engine.dispatch({
          type: "channel.create",
          commandId: CommandId.make("cmd-progress-channel"),
          channelId,
          projectId: ProjectId.make("project-progress"),
          kind: "channel",
          name: "api-design",
          memberAgentIds: [world.agent("frontend"), world.agent("reviewer")],
          leadAgentId: world.agent("reviewer"),
          createdAt: now,
        });
        yield* world.engine.dispatch({
          type: "card.create",
          commandId: CommandId.make("cmd-progress-card"),
          cardId,
          projectId: ProjectId.make("project-progress"),
          channelId,
          title: "Landing page",
          spec: "A landing page.",
          tags: [],
          criteria: [{ id: "page", text: "The page renders.", verification: "automated" }],
          createdAt: now,
        });
        yield* world.engine.dispatch({
          type: "card.approve",
          commandId: CommandId.make("cmd-progress-start"),
          cardId,
          delegateAgentId: world.agent("frontend"),
        });
        const owner = yield* world.nextSession();
        yield* world.nextEvent(
          "channel.message-posted",
          (event) => event.payload.body === "@frontend started work on Landing page",
        );

        yield* world.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-progress-ask"),
          threadId: owner.payload.threadId,
          createdAt: now,
          activity: {
            id: EventId.make("activity-progress-ask"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "ask-owner:progress",
              responseMode: "message",
              questions: [
                {
                  id: "answer",
                  header: "Question",
                  question: "Which color scheme?",
                  options: [],
                  allowCustomAnswer: true,
                  multiSelect: false,
                },
              ],
            },
            turnId: null,
            createdAt: now,
          },
        });
        yield* world.nextEvent(
          "channel.message-posted",
          (event) => event.payload.body === "@frontend asks: Which color scheme?",
        );

        yield* world.engine.dispatch({
          type: "card.review.request",
          commandId: CommandId.make("cmd-progress-review"),
          cardId,
        });
        yield* world.engine.dispatch({
          type: "card.abandon",
          commandId: CommandId.make("cmd-progress-drop"),
          cardId,
        });
        yield* world.nextEvent(
          "channel.message-posted",
          (event) => event.payload.body === "Landing page was dropped",
        );
        yield* world.reactor.drain;

        const events = yield* Stream.runCollect(world.engine.readEvents(0));
        const notes = events.filter((event) => event.type === "channel.message-posted");
        expect(notes.map((event) => [event.payload.authorKind, event.payload.body])).toEqual([
          ["system", "@frontend started work on Landing page"],
          ["system", "@frontend asks: Which color scheme?"],
          ["system", "Landing page is ready for review"],
          ["system", "Landing page was dropped"],
        ]);
        expect(notes.map((event) => event.payload.messageId)).toEqual([
          expect.stringMatching(/:card-progress:card-progress-page$/),
          expect.stringMatching(/:card-question:card-progress-page$/),
          expect.stringMatching(/:card-progress:card-progress-page$/),
          expect.stringMatching(/:card-progress:card-progress-page$/),
        ]);
        // The notes wake no one, not even the channel's lead.
        expect(events.some((event) => event.type === "channel.agent-wake-requested")).toBe(false);
      }),
    ),
  );

  it.effect("holds a card's messages at its budget cap and delivers them once a person raises it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("budget");
        yield* world.assign("backend");
        const owner = yield* world.nextSession();
        yield* world.setSession(owner.payload.threadId, "ready", null);
        yield* world.engine.dispatch({
          type: "card.spend.record",
          commandId: CommandId.make("cmd-budget-spend"),
          cardId: world.cardId,
          threadId: owner.payload.threadId,
          agentId: world.agent("backend"),
          turnId: TurnId.make("turn-expensive"),
          costUsd: 10,
          costSource: "providerReported",
          recordedAt: now,
        });
        yield* world.engine.dispatch({
          type: "card.message.post",
          commandId: CommandId.make("cmd-budget-message"),
          cardId: world.cardId,
          messageId: MessageId.make("message-budget"),
          body: "Also handle bursts.",
          createdAt: now,
        });
        yield* world.nextEvent("card.message-posted", (event) => event.payload.forOwner);
        yield* world.reactor.drain;
        // At the cap the owner's next turn is refused, so the message waits.
        expect(
          (yield* world.userMessages(owner.payload.threadId)).map((message) => message.text),
        ).toEqual([owner.payload.rendered.firstMessage]);

        yield* world.engine.dispatch({
          type: "card.budget.set",
          commandId: CommandId.make("cmd-budget-raise"),
          cardId: world.cardId,
          capUsd: 20,
        });
        yield* world.nextEvent("card.delivery-updated", (event) => event.payload.status === "sent");
        expect(
          (yield* world.userMessages(owner.payload.threadId)).map((message) => message.text),
        ).toContainEqual(expect.stringContaining("Also handle bursts."));
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
        // The board reads the same state from the card's shell.
        const cardShell = Option.getOrThrow(yield* world.snapshotQuery.getCardShellById(world.cardId));
        expect(cardShell.ownerSession).toMatchObject({
          threadId: owner.payload.threadId,
          state: "stale",
        });

        // A lost session no longer holds the card: the scheduler starts a fresh one.
        const fresh = yield* world.nextSession();
        expect(fresh.payload.threadId).not.toBe(owner.payload.threadId);
      }),
    ),
  );

  it.effect("restarts a lost owner from its brief with its unread messages, and pauses the card after four losses in an hour", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("restart");
        yield* world.assign("backend");
        const first = yield* world.nextSession();
        yield* world.setSession(first.payload.threadId, "ready", null);

        // A message goes in as the idle owner's next turn, which is lost before it runs.
        yield* world.engine.dispatch({
          type: "card.message.post",
          commandId: CommandId.make("cmd-restart-message"),
          cardId: world.cardId,
          messageId: MessageId.make("message-restart"),
          body: "Also handle bursts.",
          createdAt: now,
        });
        yield* world.nextEvent("card.delivery-updated", (event) => event.payload.status === "sent");
        yield* world.setSession(first.payload.threadId, "error", null, "The provider crashed.");
        const returned = yield* world.nextEvent("card.delivery-updated");
        expect(returned.payload).toMatchObject({ status: "pending", messageIds: ["message-restart"] });

        // The scheduler restarts the owner, counting the restart, and the message goes in once it settles.
        const second = yield* world.nextSession();
        expect(second.payload).toMatchObject({ role: "owner", restarts: 1 });
        yield* world.setSession(second.payload.threadId, "ready", null);
        const redelivered = yield* world.nextEvent(
          "card.delivery-updated",
          (event) => event.payload.status === "sent",
        );
        expect(redelivered.payload.threadId).toBe(second.payload.threadId);

        // Three more losses within the hour: the fourth pauses the card instead of restarting it.
        yield* world.setSession(second.payload.threadId, "error", null, "The provider crashed.");
        const third = yield* world.nextSession();
        expect(third.payload.restarts).toBe(2);
        yield* world.setSession(third.payload.threadId, "error", null, "The provider crashed.");
        const fourth = yield* world.nextSession();
        expect(fourth.payload.restarts).toBe(3);
        yield* world.setSession(fourth.payload.threadId, "error", null, "The provider crashed.");
        const paused = yield* world.nextEvent("card.paused");
        expect(paused.payload).toMatchObject({ by: "system", reason: { code: "sessionFailed" } });
        yield* world.reactor.drain;
        expect((yield* world.card)?.paused?.reason.code).toBe("sessionFailed");
      }),
    ),
  );
});
