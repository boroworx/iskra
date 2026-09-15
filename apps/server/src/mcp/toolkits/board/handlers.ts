import {
  ApprovalRequestId,
  CardId,
  CommandId,
  EventId,
  MessageId,
  type CardActivity,
  type CardCriterion,
  type Elicitation,
  type OrchestrationCommand,
  type ThreadId,
} from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  REVIEW_REQUESTED_CODE,
  renderReviewRequest,
  RUN_CHECKS_REQUESTED_CODE,
  runChecksJob,
  runChecksRequestBody,
} from "../../../orchestration/CardEvidence.ts";
import { BUILDER_ONLY_ASSIST_REASON } from "../../../orchestration/cardRules.ts";
import * as CardWorkspace from "../../../orchestration/CardWorkspace.ts";
import * as HostAdmission from "../../../orchestration/HostAdmission.ts";
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
  type CriterionInput,
} from "./tools.ts";

/** Criteria numbered in the order the agent wrote them. */
export const criteriaOf = (
  inputs: ReadonlyArray<typeof CriterionInput.Type>,
): ReadonlyArray<CardCriterion> =>
  inputs.map((input, index) => ({
    id: `c${index + 1}`,
    text: input.text,
    verification: input.verification ?? "automated",
  }));

/** A question with numbered options; a recommendation that isn't one of them is left for the decider to refuse. */
export const elicitationOf = (
  question: string,
  options: ReadonlyArray<string>,
  recommended: string | undefined,
): Elicitation => {
  const offered = options.map((label, index) => ({ id: `o${index + 1}`, label }));
  return {
    question,
    options: offered,
    recommendedOptionId:
      recommended === undefined
        ? null
        : (offered.find((option) => option.label === recommended)?.id ?? recommended),
    allowText: true,
    kind: "question",
  };
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const planProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;
  // Optional so the MCP routes still build where the card runtime isn't provided; run_checks then
  // refuses instead.
  const admissionOption = yield* Effect.serviceOption(HostAdmission.HostAdmission);
  const workspaceOption = yield* Effect.serviceOption(CardWorkspace.CardWorkspace);

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

  type OwnerSession = Effect.Success<typeof requireOwnerSession>;

  /** Help and critiques are the builder's to ask for; any other session hears why not. */
  const requireBuilderSession = requireOwnerSession.pipe(
    Effect.catchTag("BoardSessionRequiredError", () =>
      Effect.fail(new BoardCommandRefusedError({ detail: BUILDER_ONLY_ASSIST_REASON })),
    ),
  );

  /**
   * The agent that answers a builder's request: the one it names, else a project agent whose roles
   * include `role` (another agent before the builder's own), else null for the builder's own
   * template. The decider checks the role either way.
   */
  const assistantOf = (
    session: OwnerSession,
    name: string | undefined,
    role: "helper" | "critic",
  ) =>
    Effect.gen(function* () {
      const card = yield* snapshots.getCardShellById(session.cardId).pipe(
        Effect.mapError(failed),
        Effect.flatMap(
          Option.match({ onNone: () => new BoardSessionRequiredError({}), onSome: Effect.succeed }),
        ),
      );
      // ponytail: reads the whole command read model to find one agent; add a by-name query if
      // assist requests show up in profiles.
      const model = yield* snapshots.getCommandReadModel().pipe(Effect.mapError(failed));
      const projectAgents = (model.agents ?? []).filter(
        (candidate) => candidate.projectId === card.projectId && candidate.archivedAt === null,
      );
      if (name === undefined) {
        const able = projectAgents.filter((candidate) => candidate.roles.includes(role));
        return (able.find((candidate) => candidate.id !== session.agentId) ?? able[0])?.id ?? null;
      }
      const bare = name.replace(/^@/, "");
      const agent = projectAgents.find((candidate) => candidate.name === bare);
      if (agent === undefined) {
        return yield* new BoardCommandRefusedError({
          detail: `No agent named @${bare} works on this project.`,
        });
      }
      return agent.id;
    });

  /** An entry in the card's activity, written as the session's agent. */
  const recordActivity = (
    session: OwnerSession,
    tag: string,
    entry: Pick<CardActivity, "activityId" | "kind" | "body"> &
      Partial<Pick<CardActivity, "elicitation" | "reason">>,
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "card.activity.record",
        commandId: yield* commandId(tag, session.threadId),
        cardId: session.cardId,
        author: { kind: "agent", id: session.agentId },
        runThreadId: session.threadId,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: null,
        createdAt: yield* nowIso,
        ...entry,
      });
    });

  return BoardToolkit.of({
    request_help: (input) =>
      Effect.gen(function* () {
        const session = yield* requireBuilderSession;
        const agentId = yield* assistantOf(session, input.agentName, "helper");
        yield* dispatch({
          type: "card.help.request",
          commandId: yield* commandId("help", session.threadId),
          cardId: session.cardId,
          agentId,
          messageId: MessageId.make(`help-request:${yield* uuid}`),
          question: input.question,
          createdAt: yield* nowIso,
        });
        return { requested: true };
      }),
    request_critique: (input) =>
      Effect.gen(function* () {
        const session = yield* requireBuilderSession;
        const agentId = yield* assistantOf(session, input.agentName, "critic");
        yield* dispatch({
          type: "card.critique.request",
          commandId: yield* commandId("critique", session.threadId),
          cardId: session.cardId,
          agentId,
          messageId: MessageId.make(`critique-request:${yield* uuid}`),
          focus: input.focus,
          createdAt: yield* nowIso,
        });
        return { requested: true };
      }),
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
          criteria: criteriaOf(input.criteria),
          estimate: input.estimate,
          premise: input.premise,
          lead: {
            sourceMessageId: session.triggerMessageId,
            reasoning: input.reasoning,
            likelyDuplicateCardIds: (input.likelyDuplicateCardIds ?? []).map((id) => CardId.make(id)),
            ...(input.suggestedAgent === undefined ? {} : { suggestedAgentName: input.suggestedAgent }),
          },
          createdAt: yield* nowIso,
        });
        return { cardId };
      }),
    ask_clarification: (input) =>
      Effect.gen(function* () {
        const session = yield* requireLeadSession;
        const messageId = MessageId.make(`lead-question:${session.threadId}:${yield* uuid}`);
        yield* dispatch({
          type: "channel.message.agent.post",
          commandId: yield* commandId("lead-ask", session.threadId),
          channelId: session.channelId,
          messageId,
          agentId: session.agentId,
          runThreadId: session.threadId,
          body: input.question,
          elicitation: elicitationOf(input.question, input.options, input.recommended),
          createdAt: yield* nowIso,
        });
        return { messageId };
      }),
    propose_card: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const card = yield* snapshots.getCardShellById(session.cardId).pipe(
          Effect.mapError(failed),
          Effect.flatMap(
            Option.match({ onNone: () => new BoardSessionRequiredError({}), onSome: Effect.succeed }),
          ),
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
          ...(input.criteria === undefined ? {} : { criteria: criteriaOf(input.criteria) }),
          ...(input.subCard === true ? { subCard: true } : {}),
          createdAt: yield* nowIso,
        });
        return { cardId };
      }),
    // A proposal only: a person approves it before any brief carries it.
    propose_lesson: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const card = yield* snapshots.getCardShellById(session.cardId).pipe(
          Effect.mapError(failed),
          Effect.flatMap(
            Option.match({ onNone: () => new BoardSessionRequiredError({}), onSome: Effect.succeed }),
          ),
        );
        const lessonId = `lesson-${yield* uuid}`;
        yield* dispatch({
          type: "card.lesson.propose",
          commandId: yield* commandId("lesson", session.threadId),
          projectId: card.projectId,
          cardId: card.id,
          lessonId,
          kind: input.kind,
          text: input.text,
          paths: input.paths ?? [],
          createdAt: yield* nowIso,
        });
        return { lessonId };
      }),
    record_decision: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const decisionId = `decision-${yield* uuid}`;
        yield* recordActivity(session, "decision", {
          activityId: decisionId,
          kind: "decision",
          body: input.text,
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
        // The card's own record of the plan, which later sessions start from.
        yield* recordActivity(session, "plan-activity", {
          activityId: `plan-${yield* uuid}`,
          kind: "plan",
          body: input.steps
            .map(
              (step) =>
                `- [${step.status === "completed" ? "x" : step.status === "inProgress" ? "~" : " "}] ${step.step}`,
            )
            .join("\n"),
        });
        return {
          completedSteps: input.steps.filter((step) => step.status === "completed").length,
          totalSteps: input.steps.length,
        };
      }),
    request_review: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        // Intent only: the review gate runs the checks and moves the card if they pass.
        yield* recordActivity(session, "review-request", {
          activityId: `review-request-${yield* uuid}`,
          kind: "message",
          body: renderReviewRequest(input.summary, input.risks),
          reason: { code: REVIEW_REQUESTED_CODE, text: "Asked for review." },
        });
        return {};
      }),
    run_checks: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        if (Option.isNone(admissionOption) || Option.isNone(workspaceOption)) {
          return yield* new BoardCommandRefusedError({
            detail: "Checks can't run on this server: it has no card workspaces.",
          });
        }
        const admission = admissionOption.value;
        const workspace = workspaceOption.value;
        const card = yield* snapshots.getCardShellById(session.cardId).pipe(
          Effect.mapError(failed),
          Effect.flatMap(
            Option.match({ onNone: () => new BoardSessionRequiredError({}), onSome: Effect.succeed }),
          ),
        );
        const jobId = `run-checks-${yield* uuid}`;
        const position = (yield* admission.snapshot).waiting.length;
        // Recorded first, so a server restart queues the run again (see CardReviewReactor).
        const body = runChecksRequestBody(input.scope, input.filter);
        yield* dispatch({
          type: "card.activity.record",
          commandId: yield* commandId("run-checks-request", session.threadId),
          activityId: `${jobId}:request`,
          cardId: session.cardId,
          kind: "message",
          author: { kind: "system", id: "system" },
          body,
          runThreadId: session.threadId,
          deliverTo: null,
          elicitation: null,
          answers: null,
          status: null,
          evidenceId: null,
          reason: { code: RUN_CHECKS_REQUESTED_CODE, text: body },
          createdAt: yield* nowIso,
        });
        // The call returns at once so a long suite can't time the tool out; the result is the
        // owner's next turn.
        yield* runChecksJob({
          engine,
          admission,
          workspace,
          card,
          threadId: session.threadId,
          jobId,
          scope: input.scope,
          filter: input.filter,
        }).pipe(Effect.forkDetach);
        return { jobId, position };
      }),
    request_checkpoint: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const checkpointId = `checkpoint-${yield* uuid}`;
        yield* dispatch({
          type: "card.checkpoint.request",
          commandId: yield* commandId("checkpoint", session.threadId),
          cardId: session.cardId,
          checkpoint: {
            checkpointId,
            whatToTry: input.whatToTry,
            question: input.question ?? null,
            evidenceId: null,
            requestedAt: yield* nowIso,
          },
        });
        return { checkpointId };
      }),
    ask_owner: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const requestId = ApprovalRequestId.make(`ask-owner:${yield* uuid}`);
        // The question lives on the card: a person answers it there or from Linear, and the answer
        // reaches this session as its next turn.
        yield* recordActivity(session, "ask-activity", {
          activityId: requestId,
          kind: "elicitation",
          body: input.question,
          elicitation:
            input.options === undefined
              ? null
              : elicitationOf(input.question, input.options, input.recommended),
        });
        return { requestId };
      }),
    propose_criteria_change: (input) =>
      Effect.gen(function* () {
        const session = yield* requireOwnerSession;
        const proposalId = `criteria-change-${yield* uuid}`;
        const criteria = criteriaOf(input.criteria);
        yield* recordActivity(session, "criteria-change", {
          activityId: proposalId,
          kind: "elicitation",
          body: `${input.reason}\n\nProposed acceptance criteria:\n${criteria
            .map(
              (criterion) =>
                `- ${criterion.text}${criterion.verification === "manual" ? " (checked by a person)" : ""}`,
            )
            .join("\n")}`,
          elicitation: {
            question: "Change the acceptance criteria to the proposed ones?",
            options: [
              { id: "apply", label: "Apply them" },
              { id: "keep", label: "Keep the current ones" },
            ],
            recommendedOptionId: null,
            allowText: true,
            kind: "criteriaChange",
          },
          reason: { code: "criteriaChange", text: input.reason },
        });
        return { proposalId };
      }),
  });
});

export const BoardToolkitHandlersLive = BoardToolkit.toLayer(make);
