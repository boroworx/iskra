import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  MessageId,
  ThreadId,
  isRunEndingSessionStatus,
  type AgentId,
  type CardId,
  type CardSessionRole,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionCardRepositoryLive } from "../persistence/Layers/ProjectionCards.ts";
import { ProjectionCardRepository } from "../persistence/Services/ProjectionCards.ts";
import { forkParked } from "../serverActivation.ts";
import { buildCardBrief, diffStatOf, renderCardBrief, renderCardMessages } from "./cardBrief.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Runs card sessions. Assigning an agent, or asking for a fresh session, starts
 * the card's owner session in its worktree from a handoff brief (spec, decisions
 * and diff). Reassigning stops the idle owner session and starts the new
 * agent's once it has ended, so a card never has two writers. A helper answers
 * a question read-only; its answer joins the card's activity for the owner.
 *
 * Messages for the owner go in as its next turn once it is idle, never into a
 * running turn, and are `delivered` only once that turn runs. A message whose
 * turn never ran is `undelivered`; one still pending when the session ends
 * waits for the card's next owner session (invariant 10).
 */
export class CardSessionReactor extends Context.Service<
  CardSessionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardSessionReactor") {}

type HelperRequestedEvent = Extract<OrchestrationEvent, { type: "card.helper-requested" }>;
type SessionRequestedEvent = Extract<OrchestrationEvent, { type: "card.session-requested" }>;
type SpecSubmittedEvent = Extract<OrchestrationEvent, { type: "card.spec-submitted" }>;

type CardSessionRequest =
  | { readonly kind: "assigned"; readonly cardId: CardId; readonly key: string }
  | { readonly kind: "requested"; readonly event: SessionRequestedEvent }
  | { readonly kind: "helper"; readonly event: HelperRequestedEvent }
  | { readonly kind: "critic"; readonly event: SpecSubmittedEvent }
  | { readonly kind: "deliver"; readonly cardId: CardId }
  | { readonly kind: "finished"; readonly cardId: CardId; readonly key: string }
  | { readonly kind: "settled"; readonly threadId: ThreadId }
  | { readonly kind: "running"; readonly threadId: ThreadId }
  | { readonly kind: "ended"; readonly threadId: ThreadId };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const cards = yield* ProjectionCardRepository;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const crypto = yield* Crypto.Crypto;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // ponytail: reads the whole command read model per request, like RunReactor; add
  // narrow card and live-run queries if card sessions become frequent enough to profile.
  const readModel = () => snapshotQuery.getCommandReadModel();

  const liveCardRuns = (cardId: CardId) =>
    readModel().pipe(
      Effect.map((model) => (model.liveRuns ?? []).filter((run) => run.cardId === cardId)),
    );

  /** Says on the card why a session did not start, instead of dropping it (invariant 4). */
  const postSystem = (cardId: CardId, key: string, body: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.message.record",
        commandId: CommandId.make(`card-system:${key}`),
        cardId,
        messageId: MessageId.make(`card-system:${key}`),
        authorKind: "system",
        authorId: CHANNEL_SYSTEM_AUTHOR_ID,
        body,
        runThreadId: null,
        forOwner: false,
        createdAt: yield* nowIso,
      });
    });

  const stopSession = (threadId: ThreadId, key: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`card-session-stop:${key}`),
        threadId,
        createdAt: yield* nowIso,
      });
    });

  const startSessionUnsafe = Effect.fn("CardSessionReactor.startSession")(function* (input: {
    readonly cardId: CardId;
    readonly agentId: AgentId;
    readonly role: CardSessionRole;
    readonly key: string;
    readonly question: string | null;
  }) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === input.cardId);
    const agent = model.agents?.find((candidate) => candidate.id === input.agentId);
    if (card === undefined || agent === undefined) {
      return yield* Effect.logWarning("card session reactor could not resolve a session", input);
    }
    // The owner writes in the card's worktree, created now if this is the first session.
    const current =
      input.role === "owner" ? { ...card, ...(yield* workspace.ensure(card.id)) } : card;
    const { baseBranch, diff } = yield* workspace.diff(card.id);
    const decisions = yield* cards.listDecisions({ cardId: card.id });
    const context = buildCardBrief({
      agent,
      role: input.role,
      card: current,
      agents: (model.agents ?? []).filter((candidate) => candidate.projectId === card.projectId),
      decisions,
      baseBranch,
      diff,
      question: input.question,
    });
    const rendered = renderCardBrief(context);
    // Ids derive from the request, so a retried request cannot start a second session.
    const threadId = ThreadId.make(`card-session-${input.key}`);
    const startedAt = yield* nowIso;

    yield* engine.dispatch({
      type: "card.session.record",
      commandId: CommandId.make(`card-session-record:${input.key}`),
      threadId,
      cardId: card.id,
      agentId: agent.id,
      role: input.role,
      // A helper reads; the owner gets whatever its agent is allowed.
      capabilities: input.role === "owner" ? agent.capabilities : ["read"],
      context,
      rendered,
      startedAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`card-session-thread:${input.key}`),
      threadId,
      projectId: card.projectId,
      title:
        input.role === "owner"
          ? `@${agent.name} on ${card.title}`
          : input.role === "critic"
            ? `@${agent.name} reviewing ${card.title}`
            : `@${agent.name} helping on ${card.title}`,
      modelSelection: agent.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: current.branch,
      worktreePath: current.worktreePath,
      createdAt: startedAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`card-session-turn:${input.key}`),
      threadId,
      message: {
        messageId: MessageId.make(`card-session-message:${threadId}`),
        role: "user",
        text: rendered.firstMessage,
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: startedAt,
    });
    if (input.role === "owner" && card.status === "ready") {
      yield* engine.dispatch({
        type: "card.work.start",
        commandId: CommandId.make(`card-work-start:${input.key}`),
        cardId: card.id,
      });
    }
  });

  const startSession = (input: Parameters<typeof startSessionUnsafe>[0]) =>
    startSessionUnsafe(input).pipe(
      Effect.catch((error) =>
        postSystem(
          input.cardId,
          input.key,
          `A ${input.role === "owner" ? "session" : input.role} could not start: ${error.message}`,
        ),
      ),
    );

  const onAssigned = Effect.fn("CardSessionReactor.onAssigned")(function* (
    cardId: CardId,
    key: string,
  ) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    if (card === undefined || isFinishedCardStatus(card.status)) {
      return;
    }
    const owner = (model.liveRuns ?? []).find(
      (run) => run.cardId === cardId && run.role === "owner",
    );
    if (owner !== undefined) {
      // Hand off: the new agent starts once this session has ended.
      if (owner.agentId !== card.delegateAgentId) {
        yield* stopSession(owner.threadId, key);
      }
      return;
    }
    // The plan gate: the owner starts once a human approves or skips the spec.
    if (card.delegateAgentId !== null && card.specState !== "draft") {
      yield* startSession({
        cardId,
        agentId: card.delegateAgentId,
        role: "owner",
        key,
        question: null,
      });
    }
  });

  const deliverToOwner = Effect.fn("CardSessionReactor.deliverToOwner")(function* (
    cardId: CardId,
  ) {
    const owner = (yield* liveCardRuns(cardId)).find((run) => run.role === "owner");
    if (owner === undefined) {
      return;
    }
    const thread = yield* snapshotQuery.getThreadShellById(owner.threadId);
    const session = Option.isSome(thread) ? thread.value.session : null;
    // Only into an idle session; a running turn takes the messages when it settles.
    if (session === null || session.status !== "ready" || session.activeTurnId !== null) {
      return;
    }
    const open = yield* cards.listOpenOwnerMessages({ cardId });
    if (open.some((message) => message.deliveryThreadId === owner.threadId)) {
      return; // A turn carrying earlier messages is already on its way.
    }
    const waiting = open.filter((message) => message.deliveryStatus === "pending");
    if (waiting.length === 0) {
      return;
    }
    const model = yield* readModel();
    const messageIds = waiting.map((message) => message.messageId);
    // Each attempt gets its own id: a turn refused at the budget cap is tried again after a
    // raise, and the engine never re-decides a rejected command id. Sent messages are skipped,
    // so a repeated attempt cannot deliver twice.
    const attempt = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const key = `${owner.threadId}:${messageIds.join(",")}:${attempt}`;
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`card-owner-turn:${key}`),
      threadId: owner.threadId,
      message: {
        messageId: MessageId.make(`card-owner-turn:${key}`),
        role: "user",
        text: renderCardMessages(waiting, model.agents ?? []),
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
    });
    yield* engine.dispatch({
      type: "card.delivery.update",
      commandId: CommandId.make(`card-delivery:sent:${key}`),
      cardId,
      messageIds,
      status: "sent",
      threadId: owner.threadId,
      updatedAt: createdAt,
    });
  });

  const updateThreadDeliveries = (
    cardId: CardId,
    threadId: ThreadId,
    status: "delivered" | "undelivered",
  ) =>
    Effect.gen(function* () {
      const sent = (yield* cards.listOpenOwnerMessages({ cardId })).filter(
        (message) => message.deliveryStatus === "sent" && message.deliveryThreadId === threadId,
      );
      if (sent.length === 0) {
        return;
      }
      const messageIds = sent.map((message) => message.messageId);
      yield* engine.dispatch({
        type: "card.delivery.update",
        commandId: CommandId.make(`card-delivery:${status}:${threadId}:${messageIds.join(",")}`),
        cardId,
        messageIds,
        status,
        threadId,
        updatedAt: yield* nowIso,
      });
    });

  /** Records the card's diff size for its face; a failed measurement keeps the last one. */
  const measureDiff = (cardId: CardId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const { diff } = yield* workspace.diff(cardId);
      const measuredAt = yield* nowIso;
      yield* engine.dispatch({
        type: "card.diff.record",
        commandId: CommandId.make(`card-diff:${threadId}:${measuredAt}`),
        cardId,
        diffStat: diffStatOf(diff),
        measuredAt,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("card diff could not be measured", { cardId, error: error.message }),
      ),
    );

  const settleTurn = Effect.fn("CardSessionReactor.settleTurn")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.cardId === null) {
      return;
    }
    const { cardId, agentId, role } = run.value;
    if (role === "owner") {
      yield* measureDiff(cardId, threadId);
      return yield* deliverToOwner(cardId);
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
    if (reply !== undefined) {
      // A helper's answer waits for the owner; a critic's findings stay on the card.
      yield* engine.dispatch({
        type: "card.message.record",
        commandId: CommandId.make(`card-${role}-reply:${threadId}:${turnId}`),
        cardId,
        messageId: MessageId.make(`card-${role}-reply:${threadId}:${turnId}`),
        authorKind: "agent",
        authorId: agentId,
        body: reply.text,
        runThreadId: threadId,
        forOwner: role === "helper",
        createdAt: yield* nowIso,
      });
    }
    yield* stopSession(threadId, `${threadId}:${turnId}`);
  });

  const markDelivered = Effect.fn("CardSessionReactor.markDelivered")(function* (
    threadId: ThreadId,
  ) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isSome(run) && run.value.cardId !== null && run.value.role === "owner") {
      yield* updateThreadDeliveries(run.value.cardId, threadId, "delivered");
    }
  });

  const endSession = Effect.fn("CardSessionReactor.endSession")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.cardId === null || run.value.role !== "owner") {
      return;
    }
    const { cardId, agentId } = run.value;
    yield* updateThreadDeliveries(cardId, threadId, "undelivered");
    // A reassignment was waiting for this session to end: the new agent starts now.
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    const ownerLive = (model.liveRuns ?? []).some(
      (candidate) => candidate.cardId === cardId && candidate.role === "owner",
    );
    if (
      card !== undefined &&
      !isFinishedCardStatus(card.status) &&
      card.delegateAgentId !== null &&
      card.delegateAgentId !== agentId &&
      !ownerLive
    ) {
      yield* startSession({
        cardId,
        agentId: card.delegateAgentId,
        role: "owner",
        key: `handoff-${threadId}`,
        question: null,
      });
    }
  });

  const handle = (request: CardSessionRequest) => {
    switch (request.kind) {
      case "assigned":
        return onAssigned(request.cardId, request.key);
      case "requested":
        return startSession({
          cardId: request.event.payload.cardId,
          agentId: request.event.payload.agentId,
          role: "owner",
          key: request.event.eventId,
          question: null,
        });
      case "helper":
        return startSession({
          cardId: request.event.payload.cardId,
          agentId: request.event.payload.agentId,
          role: "helper",
          key: request.event.eventId,
          question: request.event.payload.question,
        });
      case "critic":
        return startSession({
          cardId: request.event.payload.cardId,
          agentId: request.event.payload.agentId,
          role: "critic",
          key: request.event.eventId,
          question: null,
        });
      case "deliver":
        return deliverToOwner(request.cardId);
      case "finished":
        return liveCardRuns(request.cardId).pipe(
          Effect.flatMap((runs) =>
            Effect.forEach(runs, (run) => stopSession(run.threadId, `${request.key}:${run.threadId}`), {
              discard: true,
            }),
          ),
        );
      case "settled":
        return settleTurn(request.threadId);
      case "running":
        return markDelivered(request.threadId);
      case "ended":
        return endSession(request.threadId);
    }
  };

  const worker = yield* makeDrainableWorker((request: CardSessionRequest) =>
    handle(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card session reactor request failed", {
              kind: request.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.delegate-changed":
        return worker.enqueue({ kind: "assigned", cardId: event.payload.cardId, key: event.eventId });
      case "card.session-requested":
        return worker.enqueue({ kind: "requested", event });
      case "card.helper-requested":
        return worker.enqueue({ kind: "helper", event });
      case "card.spec-submitted":
        return worker.enqueue({ kind: "critic", event });
      case "card.spec-state-changed":
        return event.payload.to === "draft"
          ? Effect.void
          : worker.enqueue({ kind: "assigned", cardId: event.payload.cardId, key: event.eventId });
      case "card.message-posted":
        return event.payload.forOwner
          ? worker.enqueue({ kind: "deliver", cardId: event.payload.cardId })
          : Effect.void;
      // A raised cap or an accepted model lets the card spend again: restart and deliver.
      case "card.budget-set":
      case "card.unpriced-accepted":
        return Effect.all(
          [
            worker.enqueue({ kind: "assigned", cardId: event.payload.cardId, key: event.eventId }),
            worker.enqueue({ kind: "deliver", cardId: event.payload.cardId }),
          ],
          { discard: true },
        );
      case "card.status-changed":
        if (isFinishedCardStatus(event.payload.to)) {
          return worker.enqueue({ kind: "finished", cardId: event.payload.cardId, key: event.eventId });
        }
        // Back to work after failed checks, a comment or a conflict: its agent needs a live session.
        return event.payload.move === "returnToWork"
          ? worker.enqueue({ kind: "assigned", cardId: event.payload.cardId, key: event.eventId })
          : Effect.void;
      case "thread.session-set": {
        const { threadId, session } = event.payload;
        if (session.status === "ready" && session.activeTurnId === null) {
          return worker.enqueue({ kind: "settled", threadId });
        }
        if (session.status === "running" && session.activeTurnId !== null) {
          return worker.enqueue({ kind: "running", threadId });
        }
        if (isRunEndingSessionStatus(session.status)) {
          return worker.enqueue({ kind: "ended", threadId });
        }
        return Effect.void;
      }
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardSessionReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies CardSessionReactor["Service"];
});

export const layer = Layer.effect(CardSessionReactor, make).pipe(
  Layer.provide(ProjectionCardRepositoryLive),
);
