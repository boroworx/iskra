import {
  projectOrchestrationOf,
  type CardId,
  type OrchestrationCard,
  type OrchestrationReadModel,
  type ProjectId,
  type Reason,
  type ThreadId,
} from "@iskra/contracts";

import {
  BLOCKED_REASON,
  cardBudgetRefusal,
  cardFactsOf,
  sessionCapRefusal,
  sideEffectGuardRefusal,
} from "./cardRules.ts";
import { budgetCardOf } from "./decider.ts";
import { priorityRank } from "./HostAdmission.ts";
import { busyRunsOf, holdsSlot } from "./wakeRouting.ts";

/** Wait reason codes the scheduler owns: it sets them, and clears them once they no longer hold. */
export const SCHEDULER_WAIT_CODES = [
  "waitingForSlot",
  "reviewCapacity",
  "waitingForMemory",
  "blocked",
  "startFailed",
] as const;
export type SchedulerWaitCode = (typeof SCHEDULER_WAIT_CODES)[number];

export const WAITING_FOR_MEMORY: Reason = {
  code: "waitingForMemory",
  text: "Waiting for the machine to free memory",
};

/** Sessions this machine runs at once: a third of its cores or one per 8 GB, between 1 and 6. */
export const environmentSessionCapOf = (input: {
  readonly cores: number;
  readonly totalMemBytes: number;
  readonly override: number | null;
}): number =>
  input.override ??
  Math.min(
    6,
    Math.max(1, Math.min(Math.floor(input.cores / 3), Math.floor(input.totalMemBytes / 1024 ** 3 / 8))),
  );

export interface PlanStartsInput {
  readonly readModel: OrchestrationReadModel;
  readonly environmentSessionCap: number;
  // Cards whose start was dispatched and has not recorded a session or failed yet.
  readonly starting: ReadonlySet<CardId>;
  // Epoch millis before which a card that failed to start is not tried again.
  readonly retryAt: ReadonlyMap<CardId, number>;
  readonly memoryPressure: boolean;
  readonly now: number;
}

export interface StartPlan {
  // In start order.
  readonly start: ReadonlyArray<OrchestrationCard>;
  // Wait reasons that changed: set, or null to clear.
  readonly waits: ReadonlyArray<{ readonly cardId: CardId; readonly reason: Reason | null }>;
  // Idle owners of cards in review or landing, stopped to give their slot back.
  readonly stop: ReadonlyArray<ThreadId>;
}

/**
 * Which cards start now. A card is a candidate when a person approved it to run: an agent is
 * delegated, the spec is past the plan gate, criteria are confirmed, no checkpoint is open, the
 * side-effect guard is acknowledged, budget remains, no earlier start failure is waiting out its
 * backoff, and it is ready (or in progress with no owner, a restart). A blocked candidate waits.
 * Candidates start in order (restarts, priority, the project with fewest busy slots, time queued)
 * while the machine and project have room; the rest say why they wait.
 */
export function planStarts(input: PlanStartsInput): StartPlan {
  const { readModel } = input;
  const cards = readModel.cards ?? [];
  const busy = busyRunsOf(readModel);
  const ownedCardIds = new Set(
    (readModel.liveRuns ?? []).flatMap((run) =>
      run.role === "owner" && run.cardId !== null ? [run.cardId] : [],
    ),
  );
  const projectById = new Map(readModel.projects.map((project) => [project.id, project] as const));
  const policyOf = (projectId: ProjectId) => projectOrchestrationOf(projectById.get(projectId) ?? {});

  const desired = new Map<CardId, Reason>();
  const candidates: Array<OrchestrationCard> = [];
  for (const card of cards) {
    const runnable =
      // A ready card can already have its owner: work starts only once the session records.
      (card.status === "ready" || card.status === "inProgress") &&
      !ownedCardIds.has(card.id) &&
      card.paused === null &&
      card.delegateAgentId !== null &&
      card.specState !== "draft" &&
      card.acceptance.state === "confirmed" &&
      card.checkpoint === null &&
      !input.starting.has(card.id) &&
      sideEffectGuardRefusal(policyOf(card.projectId)) === null &&
      cardBudgetRefusal(budgetCardOf(readModel, card)) === null;
    if (!runnable) continue;
    if (cardFactsOf(cards, card).openBlockerCount > 0) {
      desired.set(card.id, { code: "blocked", text: BLOCKED_REASON });
      continue;
    }
    if ((input.retryAt.get(card.id) ?? 0) > input.now) {
      // Keeps the failure note that set the backoff.
      if (card.waitReason?.code === "startFailed") desired.set(card.id, card.waitReason);
      continue;
    }
    candidates.push(card);
  }

  const projectBusy = new Map<ProjectId, number>();
  const bump = (projectId: ProjectId) =>
    projectBusy.set(projectId, (projectBusy.get(projectId) ?? 0) + 1);
  for (const run of busy) bump(run.projectId);
  for (const cardId of input.starting) {
    const card = cards.find((candidate) => candidate.id === cardId);
    if (card !== undefined) bump(card.projectId);
  }
  let busyTotal = busy.length + input.starting.size;
  const openAgentPrs = (projectId: ProjectId) =>
    cards.filter(
      (card) =>
        card.projectId === projectId &&
        (card.status === "inReview" || card.status === "landing") &&
        card.landing?.mode === "pullRequest",
    ).length;

  const order = (a: OrchestrationCard, b: OrchestrationCard) =>
    Number(b.status === "inProgress") - Number(a.status === "inProgress") ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    (projectBusy.get(a.projectId) ?? 0) - (projectBusy.get(b.projectId) ?? 0) ||
    (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt) ||
    a.createdAt.localeCompare(b.createdAt);

  const start: Array<OrchestrationCard> = [];
  // ponytail: re-sorts per pick so project fairness sees updated counts; O(n² log n) over ready cards.
  while (candidates.length > 0) {
    candidates.sort(order);
    const card = candidates.shift() as OrchestrationCard;
    const policy = policyOf(card.projectId);
    if (input.memoryPressure) {
      desired.set(card.id, WAITING_FOR_MEMORY);
      continue;
    }
    if (busyTotal >= input.environmentSessionCap) {
      desired.set(card.id, {
        code: "waitingForSlot",
        text: `All ${input.environmentSessionCap} session slots on this machine are busy; the card starts when one frees.`,
      });
      continue;
    }
    const projectRefusal = sessionCapRefusal(policy, projectBusy.get(card.projectId) ?? 0);
    if (projectRefusal !== null) {
      desired.set(card.id, { code: "waitingForSlot", text: projectRefusal });
      continue;
    }
    // Restarts finish work already under way; only new work waits for reviews.
    if (card.status === "ready" && openAgentPrs(card.projectId) >= policy.openAgentPrCap) {
      desired.set(card.id, {
        code: "reviewCapacity",
        text: `${policy.openAgentPrCap} of this project's pull requests are waiting for review; new work starts when one is merged or closed.`,
      });
      continue;
    }
    start.push(card);
    busyTotal += 1;
    bump(card.projectId);
  }

  const schedulerCodes: ReadonlySet<string> = new Set(SCHEDULER_WAIT_CODES);
  const waits = cards.flatMap((card): StartPlan["waits"] => {
    const next = desired.get(card.id) ?? null;
    const current = card.waitReason;
    if (next === null) {
      return current !== null && schedulerCodes.has(current.code) ? [{ cardId: card.id, reason: null }] : [];
    }
    return current?.code === next.code && current.text === next.text
      ? []
      : [{ cardId: card.id, reason: next }];
  });

  const stop = (readModel.liveRuns ?? []).flatMap((run) => {
    if (run.role !== "owner" || run.cardId === null) return [];
    const card = cards.find((candidate) => candidate.id === run.cardId);
    const idle = !holdsSlot(readModel.threads.find((thread) => thread.id === run.threadId)?.session);
    return card !== undefined && (card.status === "inReview" || card.status === "landing") && idle
      ? [run.threadId]
      : [];
  });

  return { start, waits, stop };
}
