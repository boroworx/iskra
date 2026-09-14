import {
  AgentId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RunCapability,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { nextEventOn, now, providerSession } from "./reactor.testkit.ts";
import * as RunReactor from "./RunReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const channelId = ChannelId.make("channel-backend");
const agentId = AgentId.make("agent-backend");

const layer = RunReactor.layer.pipe(
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-run-reactor-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A fresh project with one agent in one channel, the reactor running, and a
 * tap on domain events. `nextEvent` consumes the tap, so await events in the
 * order they happen.
 */
const startChannel = Effect.fn("startChannel")(function* (
  name: string,
  overrides: {
    readonly rolePrompt?: string;
    readonly capabilities?: ReadonlyArray<RunCapability>;
    readonly pinnedSpec?: string;
  } = {},
) {
  const engine = yield* OrchestrationEngineService;
  const reactor = yield* RunReactor.RunReactor;
  yield* reactor.start();
  const events = yield* engine.subscribeDomainEvents;
  const worldProjectId = ProjectId.make(`project-${name}`);
  const worldAgentId = AgentId.make(`agent-${name}`);
  const worldChannelId = ChannelId.make(`channel-${name}`);

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId: worldProjectId,
    title: name,
    workspaceRoot: `/tmp/${name}`,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: CommandId.make(`cmd-agent-${name}`),
    agentId: worldAgentId,
    projectId: worldProjectId,
    name,
    roleTags: [],
    rolePrompt: overrides.rolePrompt ?? "",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-4-5",
    },
    capabilities: overrides.capabilities ?? ["read"],
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "channel.create",
    commandId: CommandId.make(`cmd-channel-${name}`),
    channelId: worldChannelId,
    projectId: worldProjectId,
    kind: "channel",
    name,
    ...(overrides.pinnedSpec === undefined ? {} : { pinnedSpec: overrides.pinnedSpec }),
    memberAgentIds: [worldAgentId],
    createdAt: now,
  });

  const post = (messageId: string, body: string) =>
    engine.dispatch({
      type: "channel.message.post",
      commandId: CommandId.make(`cmd-post-${messageId}`),
      channelId: worldChannelId,
      messageId: MessageId.make(messageId),
      body,
      createdAt: now,
    });

  return { engine, nextEvent: nextEventOn(events), post, ...(yield* providerSession) };
});

it.layer(layer)("RunReactor", (it) => {
  it.effect("starts a read-only hidden run on wake and posts its reply back to the channel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("backend", {
          rolePrompt: "You own the API.",
          capabilities: ["read", "write"],
          pinnedSpec: "Use REST.",
        });
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* world.post("message-question", "@backend which API style do we use?");
        const turnStart = yield* world.nextEvent("thread.turn-start-requested");
        const threadId = ThreadId.make(turnStart.aggregateId);

        const run = yield* snapshotQuery
          .getRunByThreadId(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        // The agent's own capabilities allow writing; a conversation run still only reads.
        expect(run.capabilities).toEqual(["read"]);
        expect(run.rendered.systemPrompt).toContain("Use REST.");
        expect(run.rendered.firstMessage).toContain("user: @backend which API style do we use?");

        const thread = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(thread.messages.map((message) => message.text)).toEqual([run.rendered.firstMessage]);

        const shell = yield* snapshotQuery.getShellSnapshot();
        expect(shell.threads.map((candidate) => candidate.id)).not.toContain(threadId);

        yield* world.setSession(threadId, "running", "turn-run-1");
        yield* world.answer(threadId, "turn-run-1", "We use REST.");
        yield* world.setSession(threadId, "ready", null);

        yield* world.nextEvent("thread.session-stop-requested");
        const replies = (yield* Stream.runCollect(world.engine.readEvents(0))).filter(
          (event) =>
            event.type === "channel.message-posted" && event.payload.authorKind === "agent",
        );
        expect(replies.map((event) => event.payload)).toMatchObject([
          { channelId, authorId: agentId, body: "We use REST.", runThreadId: threadId },
        ]);
      }),
    ),
  );

  it.effect(
    "delivers a message sent mid-turn as the run's next turn once the current one ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* startChannel("followup");
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          yield* world.post("followup-first", "@followup what changed?");
          const threadId = ThreadId.make(
            (yield* world.nextEvent("thread.turn-start-requested")).aggregateId,
          );
          yield* world.setSession(threadId, "running", "turn-1");

          // The agent is mid-turn: this message waits instead of joining the running turn.
          yield* world.post("followup-second", "@followup and why?");
          yield* world.answer(threadId, "turn-1", "The API.");
          yield* world.setSession(threadId, "ready", null);

          yield* world.nextEvent(
            "thread.turn-start-requested",
            (event) => event.aggregateId === threadId,
          );
          const thread = yield* snapshotQuery
            .getThreadDetailById(threadId)
            .pipe(Effect.map(Option.getOrThrow));
          const followUp = thread.messages.find((message) =>
            message.id.startsWith("run-follow-up:"),
          );
          expect(followUp?.text).toContain("and why?");
          expect(followUp?.text).not.toContain("what changed?");

          yield* world.setSession(threadId, "running", "turn-2");
          const delivered = yield* world.nextEvent(
            "channel.delivery-updated",
            (event) =>
              event.payload.status === "delivered" &&
              event.payload.messageIds.includes(MessageId.make("followup-second")),
          );
          expect(delivered.payload.runThreadId).toBe(threadId);

          const stops = Array.from(yield* Stream.runCollect(world.engine.readEvents(0))).filter(
            (event) =>
              event.type === "thread.session-stop-requested" && event.aggregateId === threadId,
          );
          expect(stops).toHaveLength(0);
        }),
      ),
  );

  it.effect("wakes the agent again when its run ends with a message still waiting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("rewake");
        yield* world.post("rewake-first", "@rewake what changed?");
        const firstRun = ThreadId.make(
          (yield* world.nextEvent("thread.turn-start-requested")).aggregateId,
        );
        yield* world.setSession(firstRun, "running", "turn-1");
        yield* world.answer(firstRun, "turn-1", "The API.");
        yield* world.setSession(firstRun, "ready", null);
        yield* world.nextEvent(
          "thread.session-stop-requested",
          (event) => event.aggregateId === firstRun,
        );

        // The run is live until its session stops, so this message waits on it.
        yield* world.post("rewake-second", "@rewake and why?");
        yield* world.setSession(firstRun, "stopped", null);

        const secondRun = yield* world.nextEvent(
          "channel.run-started",
          (event) => event.payload.threadId !== firstRun,
        );
        expect(secondRun.payload.triggerMessageId).toBe("rewake-second");
        const sent = yield* world.nextEvent(
          "channel.delivery-updated",
          (event) =>
            event.payload.status === "sent" &&
            event.payload.messageIds.includes(MessageId.make("rewake-second")),
        );
        expect(sent.payload.runThreadId).toBe(secondRun.payload.threadId);

        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const runs = yield* snapshotQuery.listRunsByAgent(AgentId.make("agent-rewake"), 10);
        expect(runs.map((run) => [run.threadId, run.endedAt === null])).toEqual([
          [secondRun.payload.threadId, true],
          [firstRun, false],
        ]);
      }),
    ),
  );

  it.effect("marks a message undelivered when its run fails before reading it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("failed");
        yield* world.post("failed-first", "@failed what changed?");
        const threadId = ThreadId.make(
          (yield* world.nextEvent("thread.turn-start-requested")).aggregateId,
        );
        yield* world.setSession(threadId, "running", "turn-1");
        yield* world.post("failed-second", "@failed and why?");
        yield* world.answer(threadId, "turn-1", "The API.");
        yield* world.setSession(threadId, "ready", null);
        yield* world.nextEvent(
          "thread.turn-start-requested",
          (event) => event.aggregateId === threadId,
        );

        yield* world.setSession(threadId, "error", null);
        const undelivered = yield* world.nextEvent(
          "channel.delivery-updated",
          (event) => event.payload.status === "undelivered",
        );
        expect(undelivered.payload.messageIds).toEqual(["failed-second"]);
      }),
    ),
  );
  it.effect("queues a DM while the agent converses elsewhere and picks it up when that ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("dmqueue");
        const reactor = yield* RunReactor.RunReactor;
        yield* world.post("dmqueue-channel", "@dmqueue what changed?");
        const channelRun = ThreadId.make(
          (yield* world.nextEvent("thread.turn-start-requested")).aggregateId,
        );
        yield* world.setSession(channelRun, "running", "turn-1");

        yield* world.engine.dispatch({
          type: "agent.dm.post",
          commandId: CommandId.make("cmd-dmqueue-dm"),
          agentId: AgentId.make("agent-dmqueue"),
          messageId: MessageId.make("dmqueue-dm"),
          body: "ping when you're free",
          createdAt: now,
        });
        const dmChannelId = ChannelId.make("dm:dmqueue-dm");
        yield* world.nextEvent(
          "channel.agent-wake-requested",
          (event) => event.payload.channelId === dmChannelId && event.payload.queued === true,
        );
        yield* reactor.drain;
        const dmRunsWhileBusy = Array.from(
          yield* Stream.runCollect(world.engine.readEvents(0)),
        ).filter(
          (event) => event.type === "channel.run-started" && event.payload.channelId === dmChannelId,
        );
        expect(dmRunsWhileBusy).toHaveLength(0);

        yield* world.answer(channelRun, "turn-1", "The API.");
        yield* world.setSession(channelRun, "ready", null);
        yield* world.nextEvent(
          "thread.session-stop-requested",
          (event) => event.aggregateId === channelRun,
        );
        yield* world.setSession(channelRun, "stopped", null);

        const dmRun = yield* world.nextEvent(
          "channel.run-started",
          (event) => event.payload.channelId === dmChannelId,
        );
        expect(dmRun.payload.triggerMessageId).toBe("dmqueue-dm");
        const sent = yield* world.nextEvent(
          "channel.delivery-updated",
          (event) =>
            event.payload.status === "sent" &&
            event.payload.messageIds.includes(MessageId.make("dmqueue-dm")),
        );
        expect(sent.payload.runThreadId).toBe(dmRun.payload.threadId);
      }),
    ),
  );

  it.effect("wakes a lead mentioned by name as a conversation that replies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("memberlead");
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const memberChannelId = ChannelId.make("channel-memberlead");
        yield* world.engine.dispatch({
          type: "channel.update",
          commandId: CommandId.make("cmd-member-lead-set"),
          channelId: memberChannelId,
          leadAgentId: AgentId.make("agent-memberlead"),
        });

        yield* world.post("message-member-lead", "@memberlead is the export fixed?");
        const threadId = ThreadId.make(
          (yield* world.nextEvent("thread.turn-start-requested")).aggregateId,
        );
        const run = yield* snapshotQuery
          .getRunByThreadId(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(run.role).toBe("conversation");

        yield* world.setSession(threadId, "running", "turn-member-lead");
        yield* world.answer(threadId, "turn-member-lead", "Yes, since this morning.");
        yield* world.setSession(threadId, "ready", null);
        yield* world.nextEvent("thread.session-stop-requested");
        const messages = yield* snapshotQuery.listChannelMessages(memberChannelId, 50);
        expect(messages.map((message) => [message.authorKind, message.body])).toEqual([
          ["human", "@memberlead is the export fixed?"],
          ["agent", "Yes, since this morning."],
        ]);
      }),
    ),
  );

  it.effect("wakes a channel's lead on a message that mentions no one, and posts its clarifying question", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* startChannel("leadworld");
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const reactor = yield* RunReactor.RunReactor;
        const leadId = AgentId.make("agent-triager");
        const leadChannelId = ChannelId.make("channel-leadworld");
        yield* world.engine.dispatch({
          type: "agent.create",
          commandId: CommandId.make("cmd-agent-triager"),
          agentId: leadId,
          projectId: ProjectId.make("project-leadworld"),
          name: "triager",
          roleTags: ["triage"],
          rolePrompt: "",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-4-5",
          },
          capabilities: ["read"],
          createdAt: now,
        });
        yield* world.engine.dispatch({
          type: "channel.update",
          commandId: CommandId.make("cmd-lead-set"),
          channelId: leadChannelId,
          leadAgentId: leadId,
        });

        yield* world.post("message-lead-request", "make an awesome web page");
        const turnStart = yield* world.nextEvent("thread.turn-start-requested");
        const threadId = ThreadId.make(turnStart.aggregateId);
        const run = yield* snapshotQuery
          .getRunByThreadId(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(run).toMatchObject({
          role: "lead",
          agentId: leadId,
          triggerMessageId: "message-lead-request",
          capabilities: ["read"],
        });
        expect(run.rendered.systemPrompt).toContain("call ask_clarification with one short question");
        expect(run.rendered.systemPrompt).toContain("@leadworld");
        expect(run.rendered.firstMessage).toContain("## Open cards");

        yield* world.setSession(threadId, "running", "turn-lead");
        yield* world.answer(threadId, "turn-lead", "What's the page for?");
        yield* world.setSession(threadId, "ready", null);
        yield* world.nextEvent(
          "thread.session-stop-requested",
          (event) => event.payload.threadId === threadId,
        );
        yield* world.setSession(threadId, "stopped", null);
        yield* reactor.drain;
        const messages = yield* snapshotQuery.listChannelMessages(leadChannelId, 50);
        expect(messages.map((message) => [message.authorKind, message.body])).toEqual([
          ["human", "make an awesome web page"],
          ["agent", "What's the page for?"],
        ]);

        // The answer mentions no one either: it wakes the lead again, which reads its own question.
        yield* world.post("message-lead-answer", "a landing page for iskra, in apps/web");
        const answerTurn = yield* world.nextEvent("thread.turn-start-requested");
        const answerRun = yield* snapshotQuery
          .getRunByThreadId(ThreadId.make(answerTurn.aggregateId))
          .pipe(Effect.map(Option.getOrThrow));
        expect(answerRun).toMatchObject({ role: "lead", triggerMessageId: "message-lead-answer" });
        expect(answerRun.rendered.firstMessage).toContain(
          "@triager: What's the page for?",
        );
        expect(answerRun.rendered.firstMessage).toContain(
          "New message for you:\n[2026-01-01T00:00:00.000Z] user: a landing page for iskra, in apps/web",
        );
      }),
    ),
  );
});
