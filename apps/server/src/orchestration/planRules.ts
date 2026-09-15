import {
  MIGRATION_ITEMS_MAX,
  type CardMigration,
  type CardPlan,
  type CardPlanChild,
  type OrchestrationAgent,
  type OrchestrationCard,
  type OrchestrationEvent,
} from "@iskra/contracts";

import { criteriaRefusal, isFinishedCardStatus } from "./cardRules.ts";

/**
 * Pure rules for plan and migration cards: validating a coordinator's plan, the children an
 * approval creates, releasing slices, coalescing digests for the coordinator, and choosing which
 * migration items run next. The decider and the plan and migration reactors call these.
 */

export const PLAN_EMPTY_REASON =
  "A plan needs at least one child, and every child needs acceptance criteria.";
export const PLAN_DUPLICATE_KEY_REASON = "Each child in a plan needs its own key.";
export const PLAN_SLICE_ORDER_REASON = "A later slice can't be depended on by an earlier one.";
export const planCycleReason = (a: string, b: string) =>
  `The plan has a dependency cycle between ${a} and ${b}.`;
export const planUnknownDependencyReason = (key: string, dependency: string) =>
  `Child '${key}' depends on '${dependency}', which isn't in the plan.`;
export const PLAN_REVISION_REPLACED_REASON =
  "This plan revision was replaced; approve the latest one.";
export const PLAN_NOT_PROPOSED_REASON = "Only a proposed plan can be approved.";
export const planBuilderRoleReason = (agentName: string) =>
  `@${agentName} can't build plan children; choose an agent whose roles include builder.`;
export const COORDINATOR_OWN_CHILDREN_REASON =
  "A coordinator can only reach its own plan's children.";
export const NOT_PLAN_CARD_REASON = "Only a plan card takes a plan.";
export const PLAN_SLICE_RELEASE_REASON =
  "Only the approved plan's next slice can be released.";

export const migrationTooManyItemsReason = (count: number) =>
  `The enumerate script listed ${count} items; split the migration to ${MIGRATION_ITEMS_MAX} or fewer.`;
export const NOT_MIGRATION_CARD_REASON = "Only a migration card has items to sweep.";
export const MIGRATION_ENUMERATE_COMMAND_REASON =
  "A migration card needs the command that lists its items.";
export const MIGRATION_PHASE_ORDER_REASON = "A migration moves through its phases in order.";
export const migrationItemReason = (key: string) =>
  `Item '${key}' isn't a pending item of this migration.`;
export const migrationUnknownItemReason = (key: string) =>
  `Item '${key}' isn't in this migration.`;

/** A dependency edge that closes a cycle, as [child, dependency], or null. */
export function planCycle(
  children: ReadonlyArray<Pick<CardPlanChild, "key" | "dependsOn">>,
): readonly [string, string] | null {
  const dependsOn = new Map(children.map((child) => [child.key, child.dependsOn] as const));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): readonly [string, string] | null => {
    state.set(key, "visiting");
    for (const dependency of dependsOn.get(key) ?? []) {
      if (state.get(dependency) === "visiting") return [key, dependency];
      if (state.get(dependency) === undefined && dependsOn.has(dependency)) {
        const found = visit(dependency);
        if (found !== null) return found;
      }
    }
    state.set(key, "done");
    return null;
  };
  for (const child of children) {
    if (state.get(child.key) === undefined) {
      const found = visit(child.key);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Why a coordinator's plan can't be proposed, or null. */
export function planRefusal(children: ReadonlyArray<CardPlanChild>): string | null {
  if (children.length === 0 || children.some((child) => child.criteria.length === 0)) {
    return PLAN_EMPTY_REASON;
  }
  for (const child of children) {
    const refusal = criteriaRefusal(child.criteria);
    if (refusal !== null) return refusal;
  }
  const slices = new Map(children.map((child) => [child.key, child.slice] as const));
  if (slices.size !== children.length) return PLAN_DUPLICATE_KEY_REASON;
  for (const child of children) {
    for (const dependency of child.dependsOn) {
      const slice = slices.get(dependency);
      if (slice === undefined) return planUnknownDependencyReason(child.key, dependency);
      if (slice > child.slice) return PLAN_SLICE_ORDER_REASON;
    }
  }
  const cycle = planCycle(children);
  return cycle === null ? null : planCycleReason(cycle[0], cycle[1]);
}

/** The branch a plan's children land into, named once when the plan is approved. */
export const planIntegrationBranch = (card: Pick<OrchestrationCard, "id" | "title">): string => {
  const slug = card.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `iskra/plan-${slug === "" ? "work" : `${slug}`}-${card.id.slice(0, 8)}`;
};

/** The slice after the plan's current one, or null when none is left. */
export const planNextSlice = (plan: Pick<CardPlan, "children" | "currentSlice">): number | null => {
  const later = plan.children.map((child) => child.slice).filter((slice) => slice > plan.currentSlice);
  return later.length === 0 ? null : Math.min(...later);
};

/** One child an approval creates: the child's plan entry, its builder, and whether it waits for a checkpoint. */
export interface PlanChildCard {
  readonly child: CardPlanChild;
  readonly delegate: Pick<OrchestrationAgent, "id" | "name"> | null;
  readonly held: boolean;
}

/**
 * The children approving `plan` creates, or why it can't be approved. Keys that already have a card
 * under the plan (from an earlier approved revision) are left alone. A suggested agent that isn't an
 * active project agent leaves its child for a person to assign; one without the builder role refuses.
 */
export function planChildCards(input: {
  readonly card: Pick<OrchestrationCard, "id" | "projectId" | "plan">;
  readonly revision: number;
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  readonly cards: ReadonlyArray<Pick<OrchestrationCard, "parentCardId" | "planKey">>;
}):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly plan: CardPlan; readonly children: ReadonlyArray<PlanChildCard> } {
  const { plan } = input.card;
  if (plan === null) return { ok: false, reason: NOT_PLAN_CARD_REASON };
  if (input.revision !== plan.revision) return { ok: false, reason: PLAN_REVISION_REPLACED_REASON };
  if (plan.state !== "proposed") return { ok: false, reason: PLAN_NOT_PROPOSED_REASON };
  const existing = new Set(
    input.cards
      .filter((card) => card.parentCardId === input.card.id && card.planKey !== null)
      .map((card) => card.planKey),
  );
  const children: PlanChildCard[] = [];
  for (const child of plan.children) {
    if (existing.has(child.key)) continue;
    const agent = input.agents.find(
      (candidate) =>
        candidate.projectId === input.card.projectId &&
        candidate.archivedAt === null &&
        candidate.name === child.suggestedAgent,
    );
    if (agent !== undefined && !agent.roles.includes("builder")) {
      return { ok: false, reason: planBuilderRoleReason(agent.name) };
    }
    children.push({ child, delegate: agent ?? null, held: child.slice > plan.currentSlice });
  }
  return { ok: true, plan, children };
}

/**
 * The slice to release once every child up to the plan's current slice has landed or been
 * abandoned, or null while some still run or no slice is left.
 */
export function nextSliceRelease(
  plan: Pick<CardPlan, "state" | "children" | "currentSlice">,
  children: ReadonlyArray<Pick<OrchestrationCard, "slice" | "status">>,
): number | null {
  if (plan.state !== "approved") return null;
  const next = planNextSlice(plan);
  if (next === null) return null;
  return children
    .filter((child) => child.slice !== null && child.slice <= plan.currentSlice)
    .every((child) => isFinishedCardStatus(child.status))
    ? next
    : null;
}

/** The longest digest a coordinator receives at once. */
export const DIGEST_MAX_LINES = 40;

// ponytail: one line per child with its latest status and the last error text; a coordinator
// that needs the whole history reads the child's worklog.
/**
 * What changed on a plan's children since the last digest, one line per child, or null when
 * nothing a coordinator acts on happened: status moves, errors, used-up fix rounds.
 */
export function digestFor(
  events: ReadonlyArray<OrchestrationEvent>,
  children: ReadonlyArray<Pick<OrchestrationCard, "id" | "planKey" | "title">>,
): string | null {
  const byId = new Map(children.map((child) => [child.id as string, child] as const));
  const lines = new Map<string, { status: string | null; notes: string[] }>();
  const entry = (cardId: string) => {
    const current = lines.get(cardId) ?? { status: null, notes: [] };
    lines.set(cardId, current);
    return current;
  };
  for (const event of events) {
    const cardId = "cardId" in event.payload ? event.payload.cardId : null;
    if (cardId === null || !byId.has(cardId)) continue;
    switch (event.type) {
      case "card.status-changed":
        entry(cardId).status = event.payload.to;
        break;
      case "card.paused":
        if (event.payload.reason.code === "fixRoundsExhausted") {
          entry(cardId).notes = ["used up its fix rounds", ...entry(cardId).notes.filter((note) => note !== "used up its fix rounds")];
        }
        break;
      case "card.activity-recorded":
        if (event.payload.kind === "error") {
          const note = `error: ${event.payload.body.slice(0, 120)}`;
          entry(cardId).notes = [...entry(cardId).notes.filter((existing) => !existing.startsWith("error: ")), note];
        }
        break;
      default:
        break;
    }
  }
  const rendered = [...lines.entries()].flatMap(([cardId, { status, notes }]) => {
    const child = byId.get(cardId);
    if (child === undefined) return [];
    const parts = [...(status === null ? [] : [status]), ...notes];
    return [`- ${child.planKey ?? cardId} "${child.title}": ${parts.join("; ")}`];
  });
  if (rendered.length === 0) return null;
  return rendered.length <= DIGEST_MAX_LINES
    ? rendered.join("\n")
    : [
        ...rendered.slice(0, DIGEST_MAX_LINES - 1),
        `…and ${rendered.length - DIGEST_MAX_LINES + 1} more children changed.`,
      ].join("\n");
}

/** Pending items to start now, so running items stay within `capacity`. */
export const migrationBatch = (
  items: CardMigration["items"],
  capacity: number,
): ReadonlyArray<string> => {
  const running = items.filter((item) => item.state === "running").length;
  return items
    .filter((item) => item.state === "pending")
    .slice(0, Math.max(0, capacity - running))
    .map((item) => item.key);
};

/** Up to `size` pending items spread evenly across the list, so a sample isn't just its first files. */
export const migrationSample = (
  items: CardMigration["items"],
  size: number,
): ReadonlyArray<string> => {
  const pending = items.filter((item) => item.state === "pending");
  if (pending.length <= size) return pending.map((item) => item.key);
  return Array.from({ length: size }, (_, index) => pending[Math.floor((index * pending.length) / size)]!.key);
};

const MIGRATION_PHASES: ReadonlyArray<CardMigration["phase"]> = [
  "enumerating",
  "sampling",
  "tuning",
  "sweeping",
  "done",
];

/** Whether a migration may move from `from` to `to`: forward, one phase at a time. */
export const migrationPhaseAllowed = (
  from: CardMigration["phase"],
  to: CardMigration["phase"],
): boolean => MIGRATION_PHASES.indexOf(to) === MIGRATION_PHASES.indexOf(from) + 1;
