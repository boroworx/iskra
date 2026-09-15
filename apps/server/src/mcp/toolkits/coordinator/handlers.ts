import { CommandId, type OrchestrationCommand, type ThreadId } from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { worklogSections } from "../../../orchestration/cardBrief.ts";
import { COORDINATOR_OWN_CHILDREN_REASON } from "../../../orchestration/planRules.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { criteriaOf, elicitationOf } from "../board/handlers.ts";
import {
  CoordinatorCommandRefusedError,
  CoordinatorSessionRequiredError,
  CoordinatorToolFailedError,
  CoordinatorToolkit,
} from "./tools.ts";

/** The most of a child's worklog one read returns. */
export const CHILD_WORKLOG_LIMIT = 20_000;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const failed = (cause: unknown) => new CoordinatorToolFailedError({ cause });
  const commandId = (tag: string, threadId: ThreadId) =>
    Effect.map(uuid, (id) => CommandId.make(`server:mcp-coordinator-${tag}:${threadId}:${id}`));

  /**
   * The plan card and agent always come from the session the credential belongs to, never from the
   * tool's input, so a coordinator only ever acts on its own plan.
   */
  const requireCoordinatorSession = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("coordinator");
    const run = yield* snapshots.getRunByThreadId(scope.threadId).pipe(Effect.mapError(failed));
    if (Option.isNone(run) || run.value.role !== "coordinator" || run.value.cardId === null) {
      return yield* new CoordinatorSessionRequiredError({});
    }
    return { threadId: scope.threadId, agentId: run.value.agentId, planCardId: run.value.cardId };
  });
  type CoordinatorSession = Effect.Success<typeof requireCoordinatorSession>;

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError((error) =>
        error._tag === "OrchestrationCommandInvariantError"
          ? new CoordinatorCommandRefusedError({ detail: error.detail })
          : failed(error),
      ),
    );

  // ponytail: reads the whole command read model to find one child, like the board's assistantOf.
  /** A child of the session's own plan by its key; any other card is out of reach. */
  const childOf = (session: CoordinatorSession, childKey: string) =>
    Effect.gen(function* () {
      const model = yield* snapshots.getCommandReadModel().pipe(Effect.mapError(failed));
      const child = (model.cards ?? []).find(
        (card) => card.parentCardId === session.planCardId && card.planKey === childKey,
      );
      if (child === undefined) {
        return yield* new CoordinatorCommandRefusedError({
          detail: COORDINATOR_OWN_CHILDREN_REASON,
        });
      }
      return { child, agents: model.agents ?? [] };
    });

  return CoordinatorToolkit.of({
    propose_plan: (input) =>
      Effect.gen(function* () {
        const session = yield* requireCoordinatorSession;
        yield* dispatch({
          type: "card.plan.propose",
          commandId: yield* commandId("propose-plan", session.threadId),
          cardId: session.planCardId,
          premise: input.premise,
          children: input.children.map((child) => ({
            key: child.key,
            title: child.title,
            spec: child.spec,
            criteria: criteriaOf(child.criteria),
            suggestedAgent: child.suggestedAgent?.replace(/^@/, "") || null,
            dependsOn: child.dependsOn ?? [],
            slice: child.slice ?? 1,
          })),
          createdAt: yield* nowIso,
        });
        return {};
      }),
    read_child_worklog: (input) =>
      Effect.gen(function* () {
        const { child, agents } = yield* childOf(yield* requireCoordinatorSession, input.childKey);
        const { activities } = yield* snapshots
          .getCardActivity(child.id, { limit: 200 })
          .pipe(Effect.mapError(failed));
        const worklog = [
          `# ${input.childKey} "${child.title}": ${child.status}`,
          ...worklogSections({
            card: child,
            agents,
            worklog: { activities, evidenceItems: [], projectRules: null, restarts: 0 },
            diff: "",
            diffTruncated: false,
            question: null,
          }).map((section) => `## ${section.title}\n\n${section.body}`),
        ].join("\n\n");
        return {
          worklog:
            worklog.length > CHILD_WORKLOG_LIMIT
              ? `${worklog.slice(0, CHILD_WORKLOG_LIMIT)}…`
              : worklog,
        };
      }),
    message_child: (input) =>
      Effect.gen(function* () {
        const session = yield* requireCoordinatorSession;
        const { child } = yield* childOf(session, input.childKey);
        yield* dispatch({
          type: "card.coordinator.message",
          commandId: yield* commandId("message-child", session.threadId),
          cardId: child.id,
          planCardId: session.planCardId,
          messageId: `coordinator-message-${yield* uuid}`,
          body: input.body,
          createdAt: yield* nowIso,
        });
        return {};
      }),
    pause_child: (input) =>
      Effect.gen(function* () {
        const session = yield* requireCoordinatorSession;
        const { child } = yield* childOf(session, input.childKey);
        yield* dispatch({
          type: "card.coordinator.pause",
          commandId: yield* commandId("pause-child", session.threadId),
          cardId: child.id,
          planCardId: session.planCardId,
          reason: input.reason,
        });
        return {};
      }),
    ask_plan_owner: (input) =>
      Effect.gen(function* () {
        const session = yield* requireCoordinatorSession;
        yield* dispatch({
          type: "card.activity.record",
          commandId: yield* commandId("ask-plan-owner", session.threadId),
          activityId: `coordinator-question-${yield* uuid}`,
          cardId: session.planCardId,
          kind: "elicitation",
          author: { kind: "agent", id: session.agentId },
          body: input.question,
          runThreadId: session.threadId,
          deliverTo: null,
          elicitation: elicitationOf(input.question, input.options, input.recommended),
          answers: null,
          status: null,
          evidenceId: null,
          reason: null,
          createdAt: yield* nowIso,
        });
        return {};
      }),
  });
});

export const CoordinatorToolkitHandlersLive = CoordinatorToolkit.toLayer(make);
