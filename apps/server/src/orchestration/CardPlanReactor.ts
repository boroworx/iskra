import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  cardOriginOf,
  type CardId,
  type CardPlan,
  type OrchestrationCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { REVIEW_REQUESTED_CODE, renderReviewRequest } from "./CardEvidence.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import { CardWorkspace } from "./CardWorkspace.ts";
import { digestFor, nextSliceRelease, planNextSlice } from "./planRules.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** The reason code of a digest of a plan's children sent to its coordinator. */
export const PLAN_DIGEST_CODE = "planDigest";
/** The reason code of a plan whose integration branch couldn't be made. */
export const INTEGRATION_BRANCH_FAILED_CODE = "integrationBranchFailed";

/** What an approved plan does once its children moved: ask about the next slice, go to review, or wait. */
export type PlanStep =
  | { readonly kind: "checkpoint"; readonly slice: number; readonly next: number }
  | { readonly kind: "review" }
  | null;

export function planStep(
  plan: CardPlan | null,
  children: ReadonlyArray<Pick<OrchestrationCard, "slice" | "status">>,
): PlanStep {
  if (plan === null || plan.state !== "approved" || children.length === 0) return null;
  const next = nextSliceRelease(plan, children);
  if (next !== null) return { kind: "checkpoint", slice: plan.currentSlice, next };
  return planNextSlice(plan) === null &&
    children.every((child) => isFinishedCardStatus(child.status))
    ? { kind: "review" }
    : null;
}

/**
 * Runs approved plans. On approval it makes the plan's integration branch. As children move it sends
 * the coordinator one coalesced digest (`deliverTo: coordinator`), asks a person at each slice
 * checkpoint (continue releases the next slice, redirect goes back to the coordinator, stop pauses
 * the open children), and once every child landed or was dropped asks for the plan's own review,
 * whose blueprint runs on the integration branch before its pull request opens against the base.
 */
export class CardPlanReactor extends Context.Service<
  CardPlanReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardPlanReactor") {}

type PlanJob =
  | { readonly kind: "approved"; readonly cardId: CardId; readonly key: string }
  | {
      readonly kind: "child";
      readonly event: OrchestrationEvent & { readonly payload: { readonly cardId: CardId } };
    }
  | { readonly kind: "flush"; readonly planId: CardId }
  | {
      readonly kind: "resolved";
      readonly event: Extract<OrchestrationEvent, { type: "card.checkpoint-resolved" }>;
    };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // ponytail: reads the whole command read model per job, like the other card reactors.
  const readModel = () => snapshotQuery.getCommandReadModel();
  const childrenOf = (cards: ReadonlyArray<OrchestrationCard>, planId: CardId) =>
    cards.filter((card) => card.parentCardId === planId && cardOriginOf(card).kind === "plan");

  /** Child events waiting for their plan's next digest, and the plans with a flush queued. */
  const pending = new Map<CardId, Array<OrchestrationEvent>>();

  const record = (
    cardId: CardId,
    key: string,
    entry: {
      readonly body: string;
      readonly deliverTo: "coordinator" | null;
      readonly code: string;
      readonly kind: "message" | "error";
    },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`plan-activity:${key}`),
        activityId: `plan-activity:${key}`,
        cardId,
        kind: entry.kind,
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body: entry.body,
        runThreadId: null,
        deliverTo: entry.deliverTo,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code: entry.code, text: entry.body.split("\n")[0]!.slice(0, 200) },
        createdAt: yield* nowIso,
      });
    });

  /** Dispatches a command; a refusal only means the step already happened or no longer applies. */
  const dispatchOrLog = (what: string, command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
        Effect.logInfo("plan reactor: " + what + " refused", { detail: refusal.detail }),
      ),
    );

  const approved = Effect.fn("CardPlanReactor.approved")(function* (cardId: CardId, key: string) {
    yield* workspace.ensureIntegrationBranch(cardId).pipe(
      Effect.catch((error) =>
        record(cardId, `branch-failed:${key}`, {
          kind: "error",
          body: `The plan's integration branch couldn't be made: ${error.message}`,
          deliverTo: null,
          code: INTEGRATION_BRANCH_FAILED_CODE,
        }),
      ),
    );
  });

  const flush = Effect.fn("CardPlanReactor.flush")(function* (planId: CardId) {
    const events = pending.get(planId) ?? [];
    pending.delete(planId);
    const model = yield* readModel();
    const plan = (model.cards ?? []).find((card) => card.id === planId);
    if (plan === undefined || plan.kind !== "plan" || isFinishedCardStatus(plan.status)) return;
    const children = childrenOf(model.cards ?? [], planId);
    const digest = digestFor(events, children);
    const last = events.at(-1);
    if (digest !== null && last !== undefined) {
      yield* record(planId, `digest:${last.eventId}`, {
        kind: "message",
        body: `How the plan's children moved:\n${digest}`,
        deliverTo: "coordinator",
        code: PLAN_DIGEST_CODE,
      });
    }
    const step = planStep(plan.plan, children);
    if (step?.kind === "checkpoint") {
      yield* dispatchOrLog("slice checkpoint", {
        type: "card.checkpoint.request",
        commandId: CommandId.make(`plan-slice-checkpoint:${planId}:${step.slice}`),
        cardId: planId,
        checkpoint: {
          checkpointId: `plan-slice-${step.slice}`,
          whatToTry: `Slice ${step.slice} of the plan finished. Continue with slice ${step.next}?`,
          question: null,
          evidenceId: null,
          requestedAt: yield* nowIso,
        },
      });
    }
    // The review gate runs on the plan's integration branch, as if its coordinator asked for review.
    if (step?.kind === "review" && plan.status === "inProgress" && plan.delegateAgentId !== null) {
      const key = `plan-review:${planId}:${plan.plan?.revision ?? 0}`;
      yield* dispatchOrLog("plan review", {
        type: "card.activity.record",
        commandId: CommandId.make(key),
        activityId: key,
        cardId: planId,
        kind: "message",
        author: { kind: "agent", id: plan.delegateAgentId },
        body: renderReviewRequest(
          "Every child of the plan landed or was dropped; its branch is ready for review.",
          {
            sideEffect: "medium",
            performance: "low",
            compatibility: "medium",
            notes: "",
          },
        ),
        runThreadId: null,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code: REVIEW_REQUESTED_CODE, text: "Asked for review." },
        createdAt: yield* nowIso,
      });
    }
  });

  const resolved = Effect.fn("CardPlanReactor.resolved")(function* (
    event: Extract<OrchestrationEvent, { type: "card.checkpoint-resolved" }>,
  ) {
    const { cardId, decision, note } = event.payload;
    const model = yield* readModel();
    const plan = (model.cards ?? []).find((card) => card.id === cardId);
    if (plan?.kind !== "plan" || plan.plan?.state !== "approved") return;
    switch (decision) {
      case "continue": {
        const next = planNextSlice(plan.plan);
        if (next === null) return;
        return yield* dispatchOrLog("slice release", {
          type: "card.plan.slice.release",
          commandId: CommandId.make(`plan-slice-release:${cardId}:${next}`),
          cardId,
          slice: next,
        });
      }
      case "redirect":
        return yield* record(cardId, `redirect:${event.eventId}`, {
          kind: "message",
          body: `A person redirected the plan at its slice checkpoint${note === null || note.trim() === "" ? "." : `: ${note}`}\nPropose a revised plan if the remaining work should change.`,
          deliverTo: "coordinator",
          code: "planRedirected",
        });
      case "stop":
        for (const child of childrenOf(model.cards ?? [], cardId)) {
          if (isFinishedCardStatus(child.status) || child.paused !== null) continue;
          yield* dispatchOrLog("child pause", {
            type: "card.pause.system",
            commandId: CommandId.make(`plan-stop:${event.eventId}:${child.id}`),
            cardId: child.id,
            reason: { code: "checkpointStopped", text: "Its plan stopped at a slice checkpoint." },
          });
        }
        return;
    }
  });

  /** Buffers a plan child's event for its plan's next digest, queueing one flush per burst. */
  const onChild = Effect.fn("CardPlanReactor.onChild")(function* (
    event: OrchestrationEvent & { readonly payload: { readonly cardId: CardId } },
  ) {
    const model = yield* readModel();
    const child = (model.cards ?? []).find((card) => card.id === event.payload.cardId);
    if (child === undefined || child.parentCardId === null || cardOriginOf(child).kind !== "plan")
      return;
    const planId = child.parentCardId;
    const events = pending.get(planId);
    if (events !== undefined) {
      events.push(event); // A flush is already queued; it takes this event too.
      return;
    }
    pending.set(planId, [event]);
    yield* worker.enqueue({ kind: "flush", planId });
  });

  const handle = (job: PlanJob): Effect.Effect<void> =>
    (job.kind === "approved"
      ? approved(job.cardId, job.key)
      : job.kind === "flush"
        ? flush(job.planId)
        : job.kind === "resolved"
          ? resolved(job.event)
          : onChild(job.event)
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("card plan reactor job failed", {
              kind: job.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(handle);

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.plan-approved":
        return worker.enqueue({
          kind: "approved",
          cardId: event.payload.cardId,
          key: event.eventId,
        });
      case "card.checkpoint-resolved":
        return worker.enqueue({ kind: "resolved", event });
      case "card.status-changed":
      case "card.paused":
        return worker.enqueue({ kind: "child", event });
      case "card.activity-recorded":
        return event.payload.kind === "error"
          ? worker.enqueue({ kind: "child", event })
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardPlanReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // After a restart: approved plans get their branch, and each is looked at once.
    const model = yield* readModel().pipe(
      Effect.orElseSucceed(() => ({ cards: [] as ReadonlyArray<OrchestrationCard> })),
    );
    for (const card of model.cards ?? []) {
      if (
        card.kind !== "plan" ||
        card.plan?.state !== "approved" ||
        isFinishedCardStatus(card.status)
      )
        continue;
      if (card.worktreePath === null)
        yield* worker.enqueue({ kind: "approved", cardId: card.id, key: `recover:${card.id}` });
      yield* worker.enqueue({ kind: "flush", planId: card.id });
    }
  });

  return { start, drain: worker.drain } satisfies CardPlanReactor["Service"];
});

export const layer = Layer.effect(CardPlanReactor, make);
