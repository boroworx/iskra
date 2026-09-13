import { CommandId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionChannelRepositoryLive } from "../persistence/Layers/ProjectionChannels.ts";
import {
  ProjectionChannelRepository,
  toOrchestrationChannelMessage,
} from "../persistence/Services/ProjectionChannels.ts";
import { forkParked } from "../serverActivation.ts";
import {
  buildRunContext,
  renderNewMessage,
  renderRunContext,
  toRunContextMessage,
} from "./runContext.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Turns agent wakes into runs, and runs' answers into channel messages. A wake
 * builds the agent's context, records the run and starts its hidden thread.
 * When that thread's turn settles, the final assistant text is posted to the
 * channel and the session is stopped: the next wake starts a fresh run.
 */
export class RunReactor extends Context.Service<
  RunReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/RunReactor") {}

type WakeRequestedEvent = Extract<OrchestrationEvent, { type: "channel.agent-wake-requested" }>;

type RunRequest =
  | { readonly kind: "wake"; readonly event: WakeRequestedEvent }
  | { readonly kind: "settled"; readonly threadId: ThreadId };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const channels = yield* ProjectionChannelRepository;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const startRun = Effect.fn("RunReactor.startRun")(function* (event: WakeRequestedEvent) {
    const { channelId, agentId, triggerMessageId } = event.payload;
    // ponytail: reads the whole command read model per wake; add a narrow
    // agent/channel query if wakes become frequent enough to show up in profiles.
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const channel = readModel.channels?.find((candidate) => candidate.id === channelId);
    const agent = readModel.agents?.find((candidate) => candidate.id === agentId);
    const trigger = yield* channels.getMessageById({ messageId: triggerMessageId });
    if (!channel || !agent || Option.isNone(trigger)) {
      return yield* Effect.logWarning("run reactor could not resolve a wake", {
        channelId,
        agentId,
        triggerMessageId,
      });
    }

    const projectAgents = (readModel.agents ?? []).filter(
      (candidate) => candidate.projectId === channel.projectId,
    );

    const liveRunThreadId = event.payload.liveRunThreadId;
    if (liveRunThreadId !== undefined) {
      // The agent is already working in this channel: the message joins its live run.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`run-follow-up:${event.eventId}`),
        threadId: liveRunThreadId,
        message: {
          messageId: MessageId.make(`run-follow-up:${event.eventId}`),
          role: "user",
          text: renderNewMessage(
            toRunContextMessage(toOrchestrationChannelMessage(trigger.value), projectAgents),
          ),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: yield* nowIso,
      });
      return;
    }

    const history = yield* channels.listWakeHistory({ channelId });
    const context = buildRunContext({
      agent,
      channel,
      agents: projectAgents,
      messages: history.map(toOrchestrationChannelMessage),
      trigger: toOrchestrationChannelMessage(trigger.value),
    });
    const rendered = renderRunContext(context);
    // Ids derive from the wake event, so a retried wake cannot start a second run.
    const threadId = ThreadId.make(`run-${event.eventId}`);
    const startedAt = yield* nowIso;

    yield* engine.dispatch({
      type: "channel.run.start",
      commandId: CommandId.make(`run-start:${event.eventId}`),
      threadId,
      channelId,
      agentId,
      triggerMessageId,
      capabilities: ["read"],
      context,
      rendered,
      startedAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`run-thread:${event.eventId}`),
      threadId,
      projectId: channel.projectId,
      title: `@${agent.name} in #${channel.name}`,
      modelSelection: agent.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: startedAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`run-turn:${event.eventId}`),
      threadId,
      message: {
        messageId: MessageId.make(`run-message:${threadId}`),
        role: "user",
        text: rendered.firstMessage,
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: startedAt,
    });
  });

  const postReply = Effect.fn("RunReactor.postReply")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run)) {
      return;
    }
    const thread = yield* snapshotQuery.getThreadDetailById(threadId, { activityKinds: [] });
    const turnId = Option.isSome(thread) ? thread.value.latestTurn?.turnId : undefined;
    if (Option.isNone(thread) || turnId === undefined) {
      return;
    }
    const reply = thread.value.messages.findLast(
      (message) =>
        message.role === "assistant" && message.turnId === turnId && message.text.trim().length > 0,
    );
    if (reply === undefined) {
      return;
    }

    const createdAt = yield* nowIso;
    // Ids derive from the turn, so a repeated settle posts the reply once.
    yield* engine.dispatch({
      type: "channel.message.agent.post",
      commandId: CommandId.make(`run-reply:${threadId}:${turnId}`),
      channelId: run.value.channelId,
      messageId: MessageId.make(`run-reply:${threadId}:${turnId}`),
      agentId: run.value.agentId,
      runThreadId: threadId,
      body: reply.text,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(`run-stop:${threadId}:${turnId}`),
      threadId,
      createdAt,
    });
  });

  const worker = yield* makeDrainableWorker((request: RunRequest) =>
    (request.kind === "wake" ? startRun(request.event) : postReply(request.threadId)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("run reactor request failed", {
              kind: request.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "channel.agent-wake-requested":
        return worker.enqueue({ kind: "wake", event });
      case "thread.session-set":
        // A turn ended: the session is ready again with nothing running.
        if (
          event.payload.session.status === "ready" &&
          event.payload.session.activeTurnId === null
        ) {
          return worker.enqueue({ kind: "settled", threadId: event.payload.threadId });
        }
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("RunReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies RunReactor["Service"];
});

export const layer = Layer.effect(RunReactor, make).pipe(
  Layer.provide(ProjectionChannelRepositoryLive),
);
