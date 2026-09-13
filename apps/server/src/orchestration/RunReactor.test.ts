import {
  AgentId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
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
import * as RunReactor from "./RunReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-runs");
const channelId = ChannelId.make("channel-backend");
const agentId = AgentId.make("agent-backend");
const triggerMessageId = MessageId.make("message-question");

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-run-reactor-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("RunReactor", (it) => {
  it.effect("starts a read-only hidden run on wake and posts its reply back to the channel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const reactor = yield* RunReactor.RunReactor;
        yield* reactor.start();
        // Subscribe before dispatching so the reactor's events cannot be missed.
        const events = yield* engine.subscribeDomainEvents;
        const nextEvent = <Type extends OrchestrationEvent["type"]>(type: Type) =>
          events.pipe(
            Stream.filter((event) => event.type === type),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project"),
          projectId,
          title: "Runs",
          workspaceRoot: "/tmp/runs",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "agent.create",
          commandId: CommandId.make("cmd-agent"),
          agentId,
          projectId,
          name: "backend",
          roleTags: [],
          rolePrompt: "You own the API.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-4-5",
          },
          capabilities: ["read", "write"],
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "channel.create",
          commandId: CommandId.make("cmd-channel"),
          channelId,
          projectId,
          kind: "channel",
          name: "backend",
          pinnedSpec: "Use REST.",
          memberAgentIds: [agentId],
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "channel.message.post",
          commandId: CommandId.make("cmd-question"),
          channelId,
          messageId: triggerMessageId,
          body: "@backend which API style do we use?",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "channel.agent.wake",
          commandId: CommandId.make("cmd-wake"),
          channelId,
          agentId,
          triggerMessageId,
          createdAt: now,
        });

        const turnStart = yield* nextEvent("thread.turn-start-requested");
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

        const turnId = TurnId.make("turn-run-1");
        const session = {
          threadId,
          providerName: "claudeAgent",
          runtimeMode: "approval-required" as const,
          lastError: null,
          updatedAt: now,
        };
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-running"),
          threadId,
          session: { ...session, status: "running", activeTurnId: turnId },
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-assistant-delta"),
          threadId,
          messageId: MessageId.make("assistant-reply"),
          delta: "We use REST.",
          turnId,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-complete"),
          threadId,
          messageId: MessageId.make("assistant-reply"),
          turnId,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-ready"),
          threadId,
          session: { ...session, status: "ready", activeTurnId: null },
          createdAt: now,
        });

        yield* nextEvent("thread.session-stop-requested");
        const replies = (yield* Stream.runCollect(engine.readEvents(0))).filter(
          (event) =>
            event.type === "channel.message-posted" && event.payload.authorKind === "agent",
        );
        expect(replies.map((event) => event.payload)).toMatchObject([
          { channelId, authorId: agentId, body: "We use REST.", runThreadId: threadId },
        ]);
      }),
    ),
  );
});
