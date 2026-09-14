import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  EventId,
  MessageId,
  ProjectId,
  TurnId,
  ProviderInstanceId,
  ThreadId,
  type BackgroundPolicySnapshot,
  type CardPriority,
  type OrchestrationEvent,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import * as LinearClient from "../linear/LinearClient.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as LinearSyncReactor from "./LinearSyncReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";
const TEAM = "team-eng";
const APP_USER = "user-iskra";
const ANA = { id: "user-ana", name: "Ana" };

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

const STATES: ReadonlyArray<LinearClient.LinearWorkflowState> = [
  { id: "state-triage", type: "triage", position: 0 },
  { id: "state-backlog", type: "backlog", position: 1 },
  { id: "state-todo", type: "unstarted", position: 2 },
  { id: "state-doing", type: "started", position: 3 },
  { id: "state-done", type: "completed", position: 4 },
  { id: "state-canceled", type: "canceled", position: 5 },
];
const typeOf = (stateId: string) => STATES.find((state) => state.id === stateId)!.type;

/** A Linear workspace in memory: what people do in Linear, and what the app writes to it. */
let clock = 0;
const later = () => {
  clock += 1;
  const minutes = String(Math.floor(clock / 60)).padStart(2, "0");
  return `2026-02-01T00:${minutes}:${String(clock % 60).padStart(2, "0")}.000Z`;
};
const issues = new Map<string, LinearClient.LinearIssue>();
const issueLabels = new Map<string, ReadonlyArray<string>>();
const appComments: Array<{ readonly issueId: string; readonly body: string }> = [];
let commentWaiter: Deferred.Deferred<string> | null = null;
const agentActivities: Array<{
  readonly sessionId: string;
  readonly content: LinearClient.LinearAgentActivityContent;
}> = [];
const agentPrompts = new Map<string, ReadonlyArray<LinearClient.LinearAgentPrompt>>();
let activityWaiter: {
  readonly type: LinearClient.LinearAgentActivityContent["type"];
  readonly deferred: Deferred.Deferred<LinearClient.LinearAgentActivityContent>;
} | null = null;
/** Resolves with the next agent activity of `type`; arm it before the event that posts it. */
const awaitActivity = (type: LinearClient.LinearAgentActivityContent["type"]) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<LinearClient.LinearAgentActivityContent>();
    activityWaiter = { type, deferred };
    return deferred;
  });
let sweeps = 0;
let sweepWaiter: { readonly count: number; readonly deferred: Deferred.Deferred<void> } | null = null;

const inLinear = {
  put: (
    issue: Omit<LinearClient.LinearIssue, "updatedAt" | "stateType" | "comments" | "priority"> & {
      readonly priority?: CardPriority;
    },
  ) =>
    issues.set(issue.id, {
      priority: 0,
      ...issue,
      stateType: typeOf(issue.stateId),
      updatedAt: later(),
      comments: [],
    }),
  edit: (issueId: string, changes: LinearClient.LinearIssueChanges) => {
    const issue = issues.get(issueId)!;
    issues.set(issueId, {
      ...issue,
      ...changes,
      stateType: typeOf(changes.stateId ?? issue.stateId),
      updatedAt: later(),
    });
  },
  comment: (issueId: string, body: string, author: { readonly id: string; readonly name: string }) => {
    const issue = issues.get(issueId)!;
    issues.set(issueId, {
      ...issue,
      comments: [
        ...issue.comments,
        { id: `comment-${clock}`, body, createdAt: later(), authorId: author.id, authorName: author.name },
      ],
    });
  },
};

let createdIssues = 0;
const fakeLinear = Layer.succeed(LinearClient.LinearClient, {
  configured: Effect.succeed(true),
  viewerId: Effect.succeed(APP_USER),
  teamStates: () => Effect.succeed(STATES),
  delegatedIssues: Effect.suspend(() => {
    sweeps += 1;
    const delegated = Array.from(issues.values()).filter((issue) => issue.delegateId === APP_USER);
    const waiter = sweepWaiter;
    if (waiter === null || sweeps < waiter.count) return Effect.succeed(delegated);
    sweepWaiter = null;
    return Deferred.succeed(waiter.deferred, undefined).pipe(Effect.as(delegated));
  }),
  labeledIssues: (teamId, label) =>
    Effect.sync(() =>
      Array.from(issues.values()).filter(
        (issue) => issue.teamId === teamId && (issueLabels.get(issue.id) ?? []).includes(label),
      ),
    ),
  issuesByIds: (ids) => Effect.sync(() => ids.flatMap((id) => issues.get(id) ?? [])),
  createIssue: (input) =>
    Effect.sync(() => {
      createdIssues += 1;
      const id = `issue-created-${createdIssues}`;
      inLinear.put({
        id,
        identifier: `ENG-${createdIssues}`,
        url: `https://linear.app/acme/issue/ENG-${createdIssues}`,
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        stateId: input.stateId ?? "state-backlog",
        priority: input.priority ?? 0,
        delegateId: null,
      });
      return issues.get(id)!;
    }),
  updateIssue: (issueId, changes) => Effect.sync(() => inLinear.edit(issueId, changes)),
  createAgentSession: (issueId) => Effect.succeed(`session-${issueId}`),
  createAgentActivity: (sessionId, content) =>
    Effect.suspend(() => {
      agentActivities.push({ sessionId, content });
      const waiter = activityWaiter;
      if (waiter === null || waiter.type !== content.type) return Effect.void;
      activityWaiter = null;
      return Deferred.succeed(waiter.deferred, content).pipe(Effect.asVoid);
    }),
  agentPrompts: (sessionId) => Effect.sync(() => agentPrompts.get(sessionId) ?? []),
  createComment: (issueId, body) =>
    Effect.suspend(() => {
      appComments.push({ issueId, body });
      inLinear.comment(issueId, body, { id: APP_USER, name: "Iskra" });
      return commentWaiter === null ? Effect.void : Deferred.succeed(commentWaiter, body).pipe(Effect.asVoid);
    }),
});

const makeLayer = <A, E>(backgroundPolicy: Layer.Layer<A, E>) =>
  LinearSyncReactor.layer.pipe(
  Layer.provide(backgroundPolicy),
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
  Layer.provide(fakeLinear),
  Layer.provide(ServerSettings.layerTest({ linearTeamId: TEAM, linearLabel: "iskra" })),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-linear-sync-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layer = makeLayer(Layer.empty);

/** A client that is in the background, then comes to the foreground. */
const snapshotWith = (activeForegroundLeaseCount: number) =>
  ({ activeForegroundLeaseCount }) as unknown as BackgroundPolicySnapshot;
const focusLayer = makeLayer(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    streamChanges: Stream.make(snapshotWith(0), snapshotWith(1)),
  }),
);

/** A project on the Linear team, and an approved card on it that sync has linked to an issue. */
const makeWorld = Effect.fn("makeWorld")(function* (name: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* LinearSyncReactor.LinearSyncReactor;
  const projectId = ProjectId.make(`project-${name}`);
  const cardId = CardId.make(`card-${name}`);
  let commands = 0;
  const commandId = () => CommandId.make(`cmd-${name}-${(commands += 1)}`);

  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: name,
    workspaceRoot: `/tmp/${name}`,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: commandId(),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
  });
  yield* engine.dispatch({
    type: "card.create",
    commandId: commandId(),
    cardId,
    projectId,
    title: "Budget alerts",
    spec: "Email at 80%.",
    tags: [],
    criteria: [{ id: "alert", text: "An email goes out at 80% of budget.", verification: "automated" }],
    createdAt: now,
  });
  yield* engine.dispatch({ type: "card.approve", commandId: commandId(), cardId });
  yield* reactor.syncNow;

  const cardOf = (id: CardId) =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === id)));
  const card = yield* cardOf(cardId);
  const issueId = card!.linearIssue!.id;
  const events = yield* engine.subscribeDomainEvents;
  const nextEvent = <Type extends OrchestrationEvent["type"]>(
    type: Type,
    matches: (event: Extract<OrchestrationEvent, { type: Type }>) => boolean,
  ) =>
    events.pipe(
      Stream.filter(
        (event) => event.type === type && matches(event as Extract<OrchestrationEvent, { type: Type }>),
      ),
      Stream.runHead,
      Effect.map((event) => Option.getOrThrow(event) as Extract<OrchestrationEvent, { type: Type }>),
    );
  return { engine, reactor, projectId, cardId, issueId, commandId, cardOf, nextEvent };
});

describe("Linear acceptance criteria", () => {
  it.each([
    [
      "a heading and a checklist under it",
      "Rate limit the API.\n\n## Acceptance criteria\n- [ ] A key over 100/min gets a 429\n- [x] Limits show in the dashboard\n\n## Notes\n- not this",
      ["A key over 100/min gets a 429", "Limits show in the dashboard"],
    ],
    [
      "a bold label and a numbered list",
      "**Definition of done:**\n1. Emails go out at 80%\n2) Slack too",
      ["Emails go out at 80%", "Slack too"],
    ],
    ["checklist items anywhere", "Do it.\n- [ ] First\n- plain bullet\n- [ ] Second", ["First", "Second"]],
    ["plain bullets without a heading", "Do it.\n- one\n- two", []],
    [
      "Iskra's own block",
      "Spec.\n\n## Acceptance criteria (from Iskra)\n\n- [ ] Mine\n\n_Managed by Iskra: edit them on the card._",
      [],
    ],
  ] as const)("reads criteria from %s", (_name, description, expected) => {
    expect(
      LinearSyncReactor.criteriaFromDescription(description).map((criterion) => criterion.text),
    ).toEqual(expected);
  });

  it("keeps its criteria block out of the spec, and out of an issue that lists the same criteria", () => {
    const criteria = [
      { id: "c1", text: "Emails at 80%", verification: "automated" as const },
      { id: "c2", text: "Slack too", verification: "manual" as const },
    ];
    const shown = LinearSyncReactor.withCriteriaBlock("Budget alerts.", criteria);
    expect(LinearSyncReactor.withoutCriteriaBlock(shown)).toBe("Budget alerts.");
    expect(LinearSyncReactor.withCriteriaBlock("", criteria)).toBe(
      "## Acceptance criteria (from Iskra)\n\n- Emails at 80%\n- Slack too\n\n_Managed by Iskra: edit them on the card._",
    );
    const listed = "## Acceptance criteria\n- Emails at 80%\n- Slack too";
    expect(LinearSyncReactor.withCriteriaBlock(listed, criteria)).toBe(listed);
    expect(LinearSyncReactor.withCriteriaBlock("Spec.", [])).toBe("Spec.");
  });
});

it.layer(layer)("LinearSyncReactor", (it) => {
  it.effect("takes a delegated issue's criteria from its description, or asks the requester for them", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("criteria");
      yield* world.reactor.start();
      inLinear.put({
        id: "issue-with-criteria",
        identifier: "ENG-300",
        url: "https://linear.app/acme/issue/ENG-300",
        teamId: TEAM,
        title: "Export CSV",
        description: "Export the table.\n\n### Acceptance criteria\n- [ ] A CSV downloads\n- [ ] It has headers",
        stateId: "state-triage",
        delegateId: APP_USER,
      });
      yield* world.reactor.syncNow;
      expect(
        (yield* world.cardOf(CardId.make("card-linear-issue-with-criteria")))?.acceptance,
      ).toEqual({
        criteria: [
          { id: "c1", text: "A CSV downloads", verification: "automated" },
          { id: "c2", text: "It has headers", verification: "automated" },
        ],
        state: "confirmed",
      });

      const asked = yield* awaitActivity("elicitation");
      inLinear.put({
        id: "issue-without-criteria",
        identifier: "ENG-301",
        url: "https://linear.app/acme/issue/ENG-301",
        teamId: TEAM,
        title: "Make it faster",
        description: "It's slow.",
        stateId: "state-triage",
        delegateId: APP_USER,
      });
      yield* world.reactor.syncNow;
      expect(yield* Deferred.await(asked)).toEqual({
        type: "elicitation",
        body: LinearSyncReactor.CRITERIA_QUESTION,
      });
      const cardId = CardId.make("card-linear-issue-without-criteria");
      expect((yield* world.cardOf(cardId))?.acceptance.criteria).toEqual([]);

      // The requester adds them in Linear: the card takes them on the next sync.
      inLinear.edit("issue-without-criteria", {
        description: "It's slow.\n\nAcceptance criteria:\n- The board loads in under a second",
      });
      yield* world.reactor.syncNow;
      expect((yield* world.cardOf(cardId))?.acceptance).toMatchObject({
        criteria: [{ text: "The board loads in under a second" }],
        state: "confirmed",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("brings an issue delegated to Iskra in as a ready card", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("intake");
      inLinear.put({
        id: "issue-delegated",
        identifier: "ENG-100",
        url: "https://linear.app/acme/issue/ENG-100",
        teamId: TEAM,
        title: "Rate limit the API",
        description: "Per key.",
        stateId: "state-triage",
        delegateId: APP_USER,
      });
      yield* world.reactor.syncNow;

      expect(yield* world.cardOf(CardId.make("card-linear-issue-delegated"))).toMatchObject({
        status: "ready",
        title: "Rate limit the API",
        spec: "Per key.",
        createdBy: { kind: "linear", id: "ENG-100" },
        linearIssue: { id: "issue-delegated", identifier: "ENG-100" },
      });
      // The issue then follows its card into the team's to-do state.
      yield* world.reactor.syncNow;
      expect(issues.get("issue-delegated")?.stateId).toBe("state-todo");
    }).pipe(Effect.scoped),
  );

  it.effect("opens an issue for an approved card and syncs title, spec and comments both ways", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("roundtrip");
      // The issue carries the card's criteria in a block Iskra manages; the spec syncs without it.
      expect(issues.get(world.issueId)).toMatchObject({
        teamId: TEAM,
        title: "Budget alerts",
        description:
          "Email at 80%.\n\n## Acceptance criteria (from Iskra)\n\n- An email goes out at 80% of budget.\n\n_Managed by Iskra: edit them on the card._",
        stateId: "state-todo",
      });

      inLinear.edit(world.issueId, {
        title: "Budget alerts by email",
        description: "Email at 80% and 100%.",
      });
      yield* world.reactor.syncNow;
      expect(yield* world.cardOf(world.cardId)).toMatchObject({
        title: "Budget alerts by email",
        spec: "Email at 80% and 100%.",
      });

      yield* world.engine.dispatch({
        type: "card.update",
        commandId: world.commandId(),
        cardId: world.cardId,
        title: "Budget alerts by email and Slack",
      });
      yield* world.reactor.syncNow;
      expect(issues.get(world.issueId)?.title).toBe("Budget alerts by email and Slack");

      const fromLinear = world.nextEvent(
        "card.activity-recorded",
        (event) => event.payload.cardId === world.cardId && event.payload.author.kind === "linear",
      );
      inLinear.comment(world.issueId, "Slack too, please.", ANA);
      yield* world.reactor.syncNow;
      expect((yield* fromLinear).payload).toMatchObject({
        kind: "message",
        author: { kind: "linear", id: "Ana" },
        body: "Slack too, please.",
        deliverTo: "builder",
        delivery: "pending",
      });

      yield* world.reactor.start();
      commentWaiter = yield* Deferred.make<string>();
      yield* world.engine.dispatch({
        type: "card.message.post",
        commandId: world.commandId(),
        cardId: world.cardId,
        messageId: MessageId.make("message-roundtrip"),
        body: "Slack is next.",
        createdAt: now,
      });
      expect(yield* Deferred.await(commentWaiter)).toBe("**From Iskra:** Slack is next.");
      commentWaiter = null;
      // The app's own comment does not come back as someone else's.
      const commentsBefore = appComments.length;
      yield* world.reactor.syncNow;
      expect(appComments.length).toBe(commentsBefore);
    }).pipe(Effect.scoped),
  );

  it.effect("moves back a Linear status change that is not a decision, and explains why", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("status");
      inLinear.edit(world.issueId, { stateId: "state-doing" });
      yield* world.reactor.syncNow;

      expect(issues.get(world.issueId)?.stateId).toBe("state-todo");
      expect(appComments.findLast((comment) => comment.issueId === world.issueId)?.body).toContain(
        "so it was moved back",
      );
      expect((yield* world.cardOf(world.cardId))?.status).toBe("ready");

      // Canceling is a decision: it abandons the card.
      inLinear.edit(world.issueId, { stateId: "state-canceled" });
      yield* world.reactor.syncNow;
      expect((yield* world.cardOf(world.cardId))?.status).toBe("abandoned");
      expect(issues.get(world.issueId)?.stateId).toBe("state-canceled");
    }).pipe(Effect.scoped),
  );

  it.effect("mirrors the delegate's session as Linear agent activity and answers its questions from Linear", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("question");
      const agentId = AgentId.make("agent-question");
      const threadId = ThreadId.make("card-session-question");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      };
      /** The delegate asks a question on the card, the way ask_owner records it. */
      const askQuestion = (requestId: string, question: string) =>
        world.engine.dispatch({
          type: "card.activity.record",
          commandId: world.commandId(),
          activityId: requestId,
          cardId: world.cardId,
          kind: "elicitation",
          author: { kind: "agent", id: agentId },
          body: question,
          runThreadId: threadId,
          deliverTo: null,
          elicitation: null,
          answers: null,
          status: null,
          evidenceId: null,
          reason: null,
          createdAt: now,
        });
      yield* world.engine.dispatch({
        type: "agent.create",
        commandId: world.commandId(),
        agentId,
        projectId: world.projectId,
        name: "backend",
        roleTags: [],
        rolePrompt: "",
        modelSelection,
        capabilities: ["read", "write"],
        createdAt: now,
      });
      yield* world.engine.dispatch({ type: "card.spec.skip", commandId: world.commandId(), cardId: world.cardId });
      yield* world.engine.dispatch({
        type: "card.assign",
        commandId: world.commandId(),
        cardId: world.cardId,
        agentId,
      });
      yield* world.engine.dispatch({
        type: "card.workspace.set",
        commandId: world.commandId(),
        cardId: world.cardId,
        branch: "iskra/question",
        worktreePath: "/tmp/worktrees/question",
        portBase: 42000,
      });
      yield* world.engine.dispatch({
        type: "card.session.record",
        commandId: world.commandId(),
        threadId,
        cardId: world.cardId,
        agentId,
        role: "owner",
        capabilities: ["read", "write"],
        context: {
          agent: { id: agentId, name: "backend", rolePrompt: "" },
          role: "owner",
          card: { id: world.cardId, title: "Budget alerts", spec: "", branch: null, baseBranch: "main" },
          decisions: [],
          diff: "",
          diffTruncated: false,
          question: null,
        },
        rendered: { systemPrompt: "system", firstMessage: "brief" },
        startedAt: now,
      });
      yield* world.engine.dispatch({
        type: "thread.create",
        commandId: world.commandId(),
        threadId,
        projectId: world.projectId,
        title: "Budget alerts",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      yield* world.reactor.start();
      const elicitation = yield* awaitActivity("elicitation");
      yield* askQuestion("ask-owner:question", "Per key or per account?");
      expect(yield* Deferred.await(elicitation)).toEqual({
        type: "elicitation",
        body: "Per key or per account?",
      });

      const answered = world.nextEvent(
        "card.activity-recorded",
        (event) => event.payload.answers?.questionId === "ask-owner:question",
      );
      inLinear.comment(world.issueId, "Per key.", ANA);
      yield* world.reactor.syncNow;
      expect((yield* answered).payload).toMatchObject({
        kind: "response",
        body: "Per key.",
        deliverTo: "builder",
      });

      // The delegate's work shows as activity: a tool call as an action, its reply as a response.
      const action = yield* awaitActivity("action");
      yield* world.engine.dispatch({
        type: "thread.activity.append",
        commandId: world.commandId(),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("activity-tool-edit"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Edited src/limits.ts",
          payload: { itemType: "file_change", detail: "src/limits.ts" },
          turnId: null,
          createdAt: now,
        },
      });
      expect(yield* Deferred.await(action)).toEqual({
        type: "action",
        action: "Edited src/limits.ts",
        parameter: "src/limits.ts",
      });
      const response = yield* awaitActivity("response");
      const replyId = MessageId.make("assistant-question-reply");
      yield* world.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: world.commandId(),
        threadId,
        messageId: replyId,
        delta: "Limits are per key now.",
        turnId: TurnId.make("turn-question"),
        createdAt: now,
      });
      yield* world.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: world.commandId(),
        threadId,
        messageId: replyId,
        turnId: TurnId.make("turn-question"),
        createdAt: now,
      });
      expect(yield* Deferred.await(response)).toEqual({
        type: "response",
        body: "Limits are per key now.",
      });

      // A second question is answered by a prompt in the agent session.
      const second = yield* awaitActivity("elicitation");
      yield* askQuestion("ask-owner:second", "Include webhooks?");
      expect(yield* Deferred.await(second)).toMatchObject({ body: "Include webhooks?" });
      const secondAnswered = world.nextEvent(
        "card.activity-recorded",
        (event) => event.payload.answers?.questionId === "ask-owner:second",
      );
      agentPrompts.set(`session-${world.issueId}`, [
        {
          id: "prompt-webhooks",
          body: "Yes, webhooks too.",
          createdAt: later(),
          authorName: "Ana",
          sourceCommentId: null,
        },
      ]);
      yield* world.reactor.syncNow;
      expect((yield* secondAnswered).payload).toMatchObject({
        kind: "response",
        body: "Yes, webhooks too.",
      });
    }).pipe(Effect.scoped),
  );
  it.effect("brings in a labeled issue as a triage card, and syncs priority both ways", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("priority");
      inLinear.put({
        id: "issue-labeled",
        identifier: "ENG-200",
        url: "https://linear.app/acme/issue/ENG-200",
        teamId: TEAM,
        title: "Dark mode",
        description: "People keep asking for it.",
        stateId: "state-backlog",
        delegateId: null,
        priority: 3,
      });
      issueLabels.set("issue-labeled", ["iskra"]);
      yield* world.reactor.syncNow;
      expect(yield* world.cardOf(CardId.make("card-linear-issue-labeled"))).toMatchObject({
        status: "triage",
        priority: 3,
        createdBy: { kind: "linear", id: "ENG-200" },
      });

      inLinear.edit(world.issueId, { priority: 1 });
      yield* world.reactor.syncNow;
      expect((yield* world.cardOf(world.cardId))?.priority).toBe(1);

      yield* world.engine.dispatch({
        type: "card.update",
        commandId: world.commandId(),
        cardId: world.cardId,
        priority: 4,
      });
      yield* world.reactor.syncNow;
      expect(issues.get(world.issueId)?.priority).toBe(4);
    }).pipe(Effect.scoped),
  );
});

it.layer(focusLayer)("LinearSyncReactor on client focus", (it) => {
  it.effect("syncs as soon as a client comes to the foreground", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const reactor = yield* LinearSyncReactor.LinearSyncReactor;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-focus"),
        projectId: ProjectId.make("project-focus"),
        title: "focus",
        workspaceRoot: "/tmp/focus",
        createdAt: now,
      });
      // The first sweep runs on start; the clock never moves, so the second is the focus.
      const swept = yield* Deferred.make<void>();
      sweepWaiter = { count: sweeps + 2, deferred: swept };
      yield* reactor.start();
      yield* Deferred.await(swept);
    }).pipe(Effect.scoped),
  );
});
