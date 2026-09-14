import {
  ApprovalRequestId,
  CardId,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type ThreadId,
} from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadPlanProgressService } from "../../../orchestration/ThreadPlanProgress.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  BoardCommandRefusedError,
  BoardSessionRequiredError,
  BoardToolFailedError,
  BoardToolkit,
  LeadSessionRequiredError,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const planProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string, threadId: ThreadId) =>
    Effect.map(uuid, (id) => CommandId.make(`server:mcp-board-${tag}:${threadId}:${id}`));
  const failed = (cause: unknown) => new BoardToolFailedError({ cause });

  /**
   * The card and agent always come from the session the credential belongs to, never from the
   * tool's input, so an agent can only act on the card it is building.
   */
  const requireOwnerSession = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("board");
    const run = yield* snapshots.getRunByThreadId(scope.threadId).pipe(Effect.mapError(failed));
    if (Option.isNone(run) || run.value.role !== "owner" || run.value.cardId === null) {
      return yield* new BoardSessionRequiredError({});
    }
    return { ...run.value, cardId: run.value.cardId };
  });

  /** A lead's proposal always comes from its own channel and the message that woke it. */
  const requireLeadSession = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("lead");
    const run = yield* snapshots.getRunByThreadId(scope.threadId).pipe(Effect.mapError(failed));
    if (
      Option.isNone(run) ||
      run.value.role !== "lead" ||
      run.value.channelId === null ||
      run.value.triggerMessageId === null
    ) {
      return yield* new LeadSessionRequiredError({});
    }
    return {
      ...run.value,
      channelId: run.value.channelId,
      triggerMessageId: run.value.triggerMessageId,
    };
  });

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError((error) =>
        error._tag === "OrchestrationCommandInvariantError"
          ? new BoardCommandRefusedError({ detail: error.detail })
          : failed(error),
      ),
    );

  return BoardToolkit.of({
    // ponytail: a lead run that takes later messages as further turns still links proposals to the
    // message that first woke it; carry each turn's message on the run if that misleads.
    propose_triage_card: (input) =>
      Effect.gen(function* () {
        const session = yield* requireLeadSession;
        const channel = yield* snapshots.getChannelShellById(session.channelId).pipe(
          Effect.mapError(failed),
          Effect.flatMap(
            Option.match({ onNone: () => new LeadSessionRequiredError({}), onSome: Effect.succeed }),
          ),
        );
        const cardId = CardId.make(`card-${yield* uuid}`);
        yield* dispatch({
          type: "card.propose",
          commandId: yield* commandId("lead-propose", session.threadId),
          cardId,
          agentId: session.agentId,
          projectId: channel.projectId,
          channelId: channel.id,
          title: input.title,
          spec: input.spec,
          tags: input.tags ?? [],
          lead: {
            sourceMessageId: session.triggerMessageId,
            reasoning: input.reasoning,
            likelyDuplicateCardIds: (input.likelyDuplicateCardIds ?? []).map((id) => CardId.make(id)),
          },
          createdAt: yield* nowIso,
        });
        return { cardId };
      }),
    propose_card: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const card = yield* snapshots.getCardShellById(session.cardId).pipe(
          Effect.mapError(failed),
          Effect.flatMap(Option.match({ onNone: () => new BoardSessionRequiredError({}), onSome: Effect.succeed })),
        );
        const cardId = CardId.make(`card-${yield* uuid}`);
        yield* dispatch({
          type: "card.propose",
          commandId: yield* commandId("propose", session.threadId),
          cardId,
          agentId: session.agentId,
          projectId: card.projectId,
          channelId: card.channelId,
          parentCardId: input.subCard === true ? card.id : null,
          title: input.title,
          spec: input.spec,
          tags: input.tags ?? [],
          createdAt: yield* nowIso,
        });
        return { cardId };
      }),
    record_decision: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const decisionId = `decision-${yield* uuid}`;
        yield* dispatch({
          type: "card.decision.agent.record",
          commandId: yield* commandId("decision", session.threadId),
          cardId: session.cardId,
          agentId: session.agentId,
          decisionId,
          text: input.text,
          createdAt: yield* nowIso,
        });
        return { decisionId };
      }),
    update_plan: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        yield* Effect.sync(() => planProgress.recordPlanProgress(session.threadId, input.steps));
        // The activity puts the plan in the session's work log and refreshes the card's face.
        const createdAt = yield* nowIso;
        yield* dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("plan", session.threadId),
          threadId: session.threadId,
          createdAt,
          activity: {
            id: EventId.make(`mcp-plan:${yield* uuid}`),
            tone: "info",
            kind: "turn.plan.updated",
            summary: "Plan updated",
            payload: { plan: input.steps },
            turnId: null,
            createdAt,
          },
        });
        return {
          completedSteps: input.steps.filter((step) => step.status === "completed").length,
          totalSteps: input.steps.length,
        };
      }),
    request_review: () =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        yield* dispatch({
          type: "card.review.request",
          commandId: yield* commandId("review", session.threadId),
          cardId: session.cardId,
        });
        return {};
      }),
    ask_owner: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const requestId = ApprovalRequestId.make(`ask-owner:${yield* uuid}`);
        const createdAt = yield* nowIso;
        // A message-mode question: the answer is committed as the session's next user message.
        yield* dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("ask", session.threadId),
          threadId: session.threadId,
          createdAt,
          activity: {
            id: EventId.make(`mcp-ask:${requestId}`),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId,
              responseMode: "message",
              questions: [
                {
                  id: "answer",
                  header: "Question",
                  question: input.question,
                  options: (input.options ?? []).map((label) => ({ label, description: "" })),
                  allowCustomAnswer: true,
                  multiSelect: false,
                },
              ],
            },
            turnId: null,
            createdAt,
          },
        });
        return { requestId };
      }),
  });
});

export const BoardToolkitHandlersLive = BoardToolkit.toLayer(make);
