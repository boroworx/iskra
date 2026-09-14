import {
  AgentId,
  CardId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
const appComments: Array<{ readonly issueId: string; readonly body: string }> = [];
let commentWaiter: Deferred.Deferred<string> | null = null;

const inLinear = {
  put: (issue: Omit<LinearClient.LinearIssue, "updatedAt" | "stateType" | "comments">) =>
    issues.set(issue.id, { ...issue, stateType: typeOf(issue.stateId), updatedAt: later(), comments: [] }),
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
  configured: true,
  viewerId: Effect.succeed(APP_USER),
  teamStates: () => Effect.succeed(STATES),
  delegatedIssues: Effect.sync(() =>
    Array.from(issues.values()).filter((issue) => issue.delegateId === APP_USER),
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
        delegateId: null,
      });
      return issues.get(id)!;
    }),
  updateIssue: (issueId, changes) => Effect.sync(() => inLinear.edit(issueId, changes)),
  createComment: (issueId, body) =>
    Effect.suspend(() => {
      appComments.push({ issueId, body });
      inLinear.comment(issueId, body, { id: APP_USER, name: "Iskra" });
      return commentWaiter === null ? Effect.void : Deferred.succeed(commentWaiter, body).pipe(Effect.asVoid);
    }),
});

const layer = LinearSyncReactor.layer.pipe(
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
  Layer.provide(ServerSettings.layerTest({ linearTeamId: TEAM })),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-linear-sync-test-" })),
  Layer.provideMerge(NodeServices.layer),
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
    type: "card.create",
    commandId: commandId(),
    cardId,
    projectId,
    title: "Budget alerts",
    spec: "Email at 80%.",
    tags: [],
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

it.layer(layer)("LinearSyncReactor", (it) => {
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
      expect(issues.get(world.issueId)).toMatchObject({
        teamId: TEAM,
        title: "Budget alerts",
        description: "Email at 80%.",
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
        "card.message-posted",
        (event) => event.payload.cardId === world.cardId,
      );
      inLinear.comment(world.issueId, "Slack too, please.", ANA);
      yield* world.reactor.syncNow;
      expect((yield* fromLinear).payload).toMatchObject({
        authorKind: "linear",
        authorId: "Ana",
        body: "Slack too, please.",
        forOwner: true,
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

  it.effect("sends the delegate's question to Linear and answers it from a Linear comment", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("question");
      const agentId = AgentId.make("agent-question");
      const threadId = ThreadId.make("card-session-question");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      };
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
      commentWaiter = yield* Deferred.make<string>();
      yield* world.engine.dispatch({
        type: "thread.activity.append",
        commandId: world.commandId(),
        threadId,
        createdAt: now,
        activity: {
          id: EventId.make("activity-ask-question"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "ask-owner:question",
            responseMode: "message",
            questions: [
              {
                id: "answer",
                header: "Question",
                question: "Per key or per account?",
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
      expect(yield* Deferred.await(commentWaiter)).toBe(
        "**@backend asks:** Per key or per account?\n\nReply here to answer.",
      );
      commentWaiter = null;

      const answered = world.nextEvent(
        "thread.activity-appended",
        (event) => event.payload.activity.kind === "user-input.resolved",
      );
      inLinear.comment(world.issueId, "Per key.", ANA);
      yield* world.reactor.syncNow;
      expect((yield* answered).payload.activity.payload).toMatchObject({
        requestId: "ask-owner:question",
        answers: { answer: "Per key." },
      });
    }).pipe(Effect.scoped),
  );
});
