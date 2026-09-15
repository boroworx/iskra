import * as NodeOS from "node:os";

import {
  CommandId,
  MessageId,
  ORPHANED_PROVIDER_SESSION_ERROR,
  ThreadId,
  isRunEndingSessionStatus,
  type AgentId,
  type ChannelDeliveryStatus,
  type ChannelId,
  type OrchestrationAgent,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ProjectId,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionChannelRepositoryLive } from "../persistence/Layers/ProjectionChannels.ts";
import {
  ProjectionChannelRepository,
  toOrchestrationChannelMessage,
  type ProjectionOpenChannelDelivery,
} from "../persistence/Services/ProjectionChannels.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { environmentSessionCapOf } from "./cardQueue.ts";
import {
  buildRunContext,
  renderNewMessage,
  renderRunContext,
  toRunContextMessage,
} from "./runContext.ts";
import { parseMentions } from "./mentions.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { busyRunsOf } from "./wakeRouting.ts";
import { budgetHold, environmentSpendUsd } from "./watchdogRules.ts";

/**
 * Turns agent wakes into runs, and runs' answers into channel messages. A wake
 * builds the agent's context, records the run and starts its hidden thread.
 *
 * A message for an agent already working in the channel waits as `pending`
 * and goes in as the run's next turn once the current turn ends. It is never
 * steered into a running turn, which the provider can end without reading it.
 * A delivery is `delivered` only once the turn carrying it is running. When a
 * turn ends with nothing waiting, the reply is posted and the session stopped,
 * so the next wake starts a fresh run. A run that ends with messages still
 * waiting wakes the agent again for them; a message whose turn never ran is
 * marked `undelivered` (invariant 10), unless a server restart lost the run, when it waits for the
 * agent's next run too.
 *
 * Every channel and DM gets its own run of an agent. A wake past the machine's session cap keeps
 * its messages pending and starts once a session ends (or on the minute tick), saying so in the
 * channel once. Deliveries still `queued` from before instances are woken at startup.
 */
export class RunReactor extends Context.Service<
  RunReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/RunReactor") {}

type WakeRequestedEvent = Extract<OrchestrationEvent, { type: "channel.agent-wake-requested" }>;

type RunRequest =
  | { readonly kind: "wake"; readonly event: WakeRequestedEvent }
  | { readonly kind: "settled"; readonly threadId: ThreadId }
  | { readonly kind: "running"; readonly threadId: ThreadId }
  | { readonly kind: "ended"; readonly threadId: ThreadId; readonly lost: boolean }
  | { readonly kind: "retry" }
  | { readonly kind: "pickUpQueued" };

/** What a session change means for the run on its thread, if anything. */
export const runSessionChange = (
  session: OrchestrationSession,
): "settled" | "running" | "ended" | null => {
  // A turn ended: the session is ready again with nothing running.
  if (session.status === "ready" && session.activeTurnId === null) {
    return "settled";
  }
  if (session.status === "running" && session.activeTurnId !== null) {
    return "running";
  }
  return isRunEndingSessionStatus(session.status) ? "ended" : null;
};

const sentInto = (deliveries: ReadonlyArray<ProjectionOpenChannelDelivery>, threadId: ThreadId) =>
  deliveries.filter(
    (delivery) => delivery.status === "sent" && delivery.deliveryRunThreadId === threadId,
  );

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const channels = yield* ProjectionChannelRepository;
  // Optional so the reactor still builds without settings; wakes then meet no machine cap.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  // Wakes waiting for a session slot, the newest per agent and channel. In memory: after a restart
  // their messages are still pending, and the next message or run end wakes the agent again.
  const waiting = new Map<string, WakeRequestedEvent>();
  const waitKey = (event: WakeRequestedEvent) =>
    `${event.payload.channelId}:${event.payload.agentId}`;

  const cardRuntime = Option.isNone(settings)
    ? Effect.succeed(null)
    : settings.value.getSettings.pipe(
        Effect.map((current) => current.cardRuntime),
        Effect.orElseSucceed(() => null),
      );

  const environmentSessionCap = cardRuntime.pipe(
    Effect.map((runtime) =>
      runtime === null
        ? null
        : environmentSessionCapOf({
            cores: NodeOS.availableParallelism(),
            totalMemBytes: NodeOS.totalmem(),
            override: runtime.environmentSessionCap,
          }),
    ),
  );

  /** Why a monthly budget holds the agent's next turn in the project (at 100%), or null. */
  const budgetHoldIn = Effect.fn("RunReactor.budgetHoldIn")(function* (
    readModel: OrchestrationReadModel,
    projectId: ProjectId | undefined,
    agent: OrchestrationAgent | null,
  ) {
    const project = readModel.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return null;
    const now = yield* nowIso;
    return budgetHold({
      project,
      agent,
      environmentBudgetUsd: (yield* cardRuntime)?.monthlyBudgetUsd ?? null,
      environmentSpentUsd: environmentSpendUsd(readModel.projects, now),
      now,
    });
  });

  const updateDeliveries = Effect.fn("RunReactor.updateDeliveries")(function* (input: {
    readonly channelId: ChannelId;
    readonly agentId: AgentId;
    readonly deliveries: ReadonlyArray<ProjectionOpenChannelDelivery>;
    readonly status: ChannelDeliveryStatus;
    readonly runThreadId: ThreadId | null;
  }) {
    if (input.deliveries.length === 0) {
      return;
    }
    const messageIds = input.deliveries.map((delivery) => delivery.messageId);
    yield* engine.dispatch({
      type: "channel.delivery.update",
      // The id names the change, so a retried update is recorded once.
      commandId: CommandId.make(
        `run-delivery:${input.status}:${input.runThreadId ?? "none"}:${messageIds.join(",")}`,
      ),
      channelId: input.channelId,
      agentId: input.agentId,
      messageIds,
      status: input.status,
      runThreadId: input.runThreadId,
      updatedAt: yield* nowIso,
    });
  });

  const startRun = Effect.fn("RunReactor.startRun")(function* (event: WakeRequestedEvent) {
    // The agent is already working in this channel: the message stays pending
    // until the current turn ends, then goes in as the run's next turn.
    if (event.payload.liveRunThreadId !== undefined) {
      return;
    }

    const { channelId, agentId, triggerMessageId } = event.payload;
    // ponytail: reads the whole command read model per wake; add a narrow
    // agent/channel query if wakes become frequent enough to show up in profiles.
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const channel = readModel.channels?.find((candidate) => candidate.id === channelId);
    const agent = readModel.agents?.find((candidate) => candidate.id === agentId);
    const trigger = yield* channels.getMessageById({ messageId: triggerMessageId });
    if (!channel || !agent || Option.isNone(trigger)) {
      waiting.delete(waitKey(event));
      return yield* Effect.logWarning("run reactor could not resolve a wake", {
        channelId,
        agentId,
        triggerMessageId,
      });
    }
    // A run of the agent started here meanwhile (a rewake, a later message): it takes the messages.
    if (
      (readModel.liveRuns ?? []).some(
        (run) => run.agentId === agentId && run.channelId === channelId,
      )
    ) {
      waiting.delete(waitKey(event));
      return;
    }
    const cap = yield* environmentSessionCap;
    // A budget past its cap (this machine's included, which wakes don't check) holds new runs too.
    const hold = yield* budgetHoldIn(readModel, channel.projectId, agent);
    if (hold !== null || (cap !== null && busyRunsOf(readModel).length >= cap)) {
      const first = !waiting.has(waitKey(event));
      waiting.set(waitKey(event), event);
      if (first) {
        // Said once per wait, and the id derives from the wake, so a replayed wake says it once.
        yield* engine.dispatch({
          type: "channel.message.system.post",
          commandId: CommandId.make(`run-wait:${event.eventId}`),
          channelId,
          messageId: MessageId.make(`run-wait:${event.eventId}`),
          body:
            hold?.text ??
            `@${agent.name} starts when one of this machine's ${cap} session slots frees.`,
          createdAt: yield* nowIso,
        });
      }
      return;
    }
    waiting.delete(waitKey(event));

    const projectAgents = (readModel.agents ?? []).filter(
      (candidate) => candidate.projectId === channel.projectId,
    );
    const history = yield* channels.listWakeHistory({ channelId });
    // The lead triages what mentions no one; mentioned by name, it converses and replies like any member.
    const lead =
      channel.leadAgentId === agentId &&
      !parseMentions(trigger.value.body, projectAgents).includes(agentId);
    const context = buildRunContext({
      agent,
      channel,
      agents: projectAgents,
      messages: history.map(toOrchestrationChannelMessage),
      trigger: toOrchestrationChannelMessage(trigger.value),
      ...(lead ? { lead: { cards: readModel.cards ?? [] } } : {}),
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
      ...(lead ? { role: "lead" as const } : {}),
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
      title: `@${agent.name} in ${channel.kind === "requests" ? "Requests" : `#${channel.name}`}`,
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
    // Everything waiting on the agent here is in the first turn's context.
    const open = yield* channels.listOpenDeliveries({ agentId, channelId });
    yield* updateDeliveries({
      channelId,
      agentId,
      deliveries: open.filter(
        (delivery) => delivery.status === "pending" || delivery.status === "queued",
      ),
      status: "sent",
      runThreadId: threadId,
    });
  });

  const settleTurn = Effect.fn("RunReactor.settleTurn")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.channelId === null) {
      return;
    }
    const { channelId, agentId } = { ...run.value, channelId: run.value.channelId };
    const thread = yield* snapshotQuery.getThreadDetailById(threadId, { activityKinds: [] });
    const turnId = Option.isSome(thread) ? thread.value.latestTurn?.turnId : undefined;
    if (Option.isNone(thread) || turnId === undefined) {
      return;
    }

    const createdAt = yield* nowIso;
    const reply = thread.value.messages.findLast(
      (message) =>
        message.role === "assistant" && message.turnId === turnId && message.text.trim().length > 0,
    );
    // A lead's reply is posted too: its clarifying question, or the line under its proposal.
    if (reply !== undefined) {
      // Ids derive from the turn, so a repeated settle posts the reply once.
      yield* engine.dispatch({
        type: "channel.message.agent.post",
        commandId: CommandId.make(`run-reply:${threadId}:${turnId}`),
        channelId,
        messageId: MessageId.make(`run-reply:${threadId}:${turnId}`),
        agentId,
        runThreadId: threadId,
        body: reply.text,
        createdAt,
      });
    }

    const waiting = (yield* channels.listOpenDeliveries({ agentId, channelId })).filter(
      (delivery) => delivery.status === "pending",
    );
    const stopRun = engine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(`run-stop:${threadId}:${turnId}`),
      threadId,
      createdAt,
    });
    if (waiting.length === 0) {
      yield* stopRun;
      return;
    }

    // ponytail: reads the whole command read model to name authors; add a narrow
    // agents query if follow-ups become frequent enough to show up in profiles.
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const projectId = readModel.channels?.find(
      (candidate) => candidate.id === channelId,
    )?.projectId;
    // Past a monthly budget no new turn starts: the run ends, and its rewake is refused or waits.
    const agent = readModel.agents?.find((candidate) => candidate.id === agentId) ?? null;
    if ((yield* budgetHoldIn(readModel, projectId, agent)) !== null) {
      yield* stopRun;
      return;
    }
    const projectAgents = (readModel.agents ?? []).filter(
      (candidate) => candidate.projectId === projectId,
    );
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`run-follow-up:${threadId}:${turnId}`),
      threadId,
      message: {
        messageId: MessageId.make(`run-follow-up:${threadId}:${turnId}`),
        role: "user",
        text: waiting
          .map((delivery) =>
            renderNewMessage(
              toRunContextMessage(toOrchestrationChannelMessage(delivery), projectAgents),
            ),
          )
          .join("\n\n"),
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
    });
    yield* updateDeliveries({
      channelId,
      agentId,
      deliveries: waiting,
      status: "sent",
      runThreadId: threadId,
    });
  });

  const markDelivered = Effect.fn("RunReactor.markDelivered")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.channelId === null) {
      return;
    }
    const { channelId, agentId } = { ...run.value, channelId: run.value.channelId };
    // A turn is running in this run: the provider has what was sent into it.
    yield* updateDeliveries({
      channelId,
      agentId,
      deliveries: sentInto(yield* channels.listOpenDeliveries({ agentId, channelId }), threadId),
      status: "delivered",
      runThreadId: threadId,
    });
  });

  /**
   * Wakes the agent in a channel for the messages still waiting on it there,
   * triggered by the newest. True if the wake went through; if it is refused,
   * the messages go unanswered.
   */
  const wakeForWaiting = Effect.fn("RunReactor.wakeForWaiting")(function* (input: {
    readonly commandId: CommandId;
    readonly channelId: ChannelId;
    readonly agentId: AgentId;
    readonly waiting: ReadonlyArray<ProjectionOpenChannelDelivery>;
  }) {
    const latest = input.waiting.at(-1);
    if (latest === undefined) {
      return false;
    }
    return yield* engine
      .dispatch({
        type: "channel.agent.wake",
        commandId: input.commandId,
        channelId: input.channelId,
        agentId: input.agentId,
        triggerMessageId: latest.messageId,
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() =>
          updateDeliveries({
            channelId: input.channelId,
            agentId: input.agentId,
            deliveries: input.waiting,
            status: "undelivered",
            runThreadId: null,
          }).pipe(Effect.as(false)),
        ),
      );
  });

  const endRun = Effect.fn("RunReactor.endRun")(function* (threadId: ThreadId, lost: boolean) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.channelId === null) {
      return;
    }
    const { channelId, agentId } = { ...run.value, channelId: run.value.channelId };
    const open = yield* channels.listOpenDeliveries({ agentId, channelId });
    const unread = sentInto(open, threadId);
    // Sent into a turn that never ran: the agent did not read them. A server restart lost the run,
    // not the conversation, so they wait for the agent's next run instead.
    yield* updateDeliveries({
      channelId,
      agentId,
      deliveries: unread,
      status: lost ? "pending" : "undelivered",
      runThreadId: threadId,
    });

    // Still waiting when the run ended: wake the agent again here in a fresh run,
    // whose context carries them. The channel keeps the agent until then.
    yield* wakeForWaiting({
      commandId: CommandId.make(`run-rewake:${threadId}`),
      channelId,
      agentId,
      waiting: [
        ...(lost ? unread : []),
        ...open.filter((delivery) => delivery.status === "pending"),
      ],
    });
  });

  const retryWaiting = Effect.fn("RunReactor.retryWaiting")(function* () {
    for (const event of waiting.values()) {
      yield* startRun(event);
    }
  });

  /** Wakes DMs whose messages were `queued` behind another conversation before instances. */
  const pickUpQueued = Effect.fn("RunReactor.pickUpQueued")(function* () {
    const readModel = yield* snapshotQuery.getCommandReadModel();
    for (const channel of readModel.channels ?? []) {
      if (channel.kind !== "dm" || channel.archivedAt !== null) continue;
      for (const agentId of channel.memberAgentIds) {
        const queued = (yield* channels.listOpenDeliveries({
          agentId,
          channelId: channel.id,
        })).filter((delivery) => delivery.status === "queued");
        yield* wakeForWaiting({
          commandId: CommandId.make(
            `run-queued-pickup:${channel.id}:${queued.at(-1)?.messageId ?? "none"}`,
          ),
          channelId: channel.id,
          agentId,
          waiting: queued,
        });
      }
    }
  });

  const handle = (request: RunRequest) => {
    switch (request.kind) {
      case "wake":
        return startRun(request.event);
      case "settled":
        return settleTurn(request.threadId);
      case "running":
        return markDelivered(request.threadId);
      case "ended":
        return endRun(request.threadId, request.lost);
      case "retry":
        return retryWaiting();
      case "pickUpQueued":
        return pickUpQueued();
    }
  };

  const worker = yield* makeDrainableWorker((request: RunRequest) =>
    handle(request).pipe(
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
      case "thread.session-set": {
        const { session, threadId } = event.payload;
        const kind = runSessionChange(session);
        const handled =
          kind === null
            ? Effect.void
            : worker.enqueue(
                kind === "ended"
                  ? { kind, threadId, lost: session.lastError === ORPHANED_PROVIDER_SESSION_ERROR }
                  : { kind, threadId },
              );
        // Any session going quiet, a card's included, may free the slot a wake waits for.
        return (kind === "settled" || kind === "ended") && waiting.size > 0
          ? Effect.andThen(handled, worker.enqueue({ kind: "retry" }))
          : handled;
      }
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("RunReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* worker.enqueue({ kind: "pickUpQueued" });
    yield* forkParked(
      Effect.suspend(() =>
        waiting.size > 0 ? worker.enqueue({ kind: "retry" }) : Effect.void,
      ).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies RunReactor["Service"];
});

export const layer = Layer.effect(RunReactor, make).pipe(
  Layer.provide(ProjectionChannelRepositoryLive),
);
