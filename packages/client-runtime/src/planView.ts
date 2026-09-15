import type {
  CardId,
  CardMigration,
  CardMigrationItemState,
  CardPlan,
  CardPlanChild,
  OrchestrationCard,
} from "@iskra/contracts";

/** Where a plan child stands: proposed until approved, then its card's progress. */
export type PlanChildState =
  | "proposed"
  | "needsAgent"
  | "held"
  | "blocked"
  | "queued"
  | "working"
  | "review"
  | "landed"
  | "abandoned";

export interface PlanChildView {
  readonly child: CardPlanChild;
  /** The child's card once the plan is approved; null before, or for a key it skipped. */
  readonly cardId: CardId | null;
  readonly state: PlanChildState;
  /** Titles of the children it depends on, in the plan's order. */
  readonly dependsOnTitles: ReadonlyArray<string>;
}

export interface PlanSliceView {
  readonly slice: number;
  readonly children: ReadonlyArray<PlanChildView>;
  /** Every child in the slice has landed or been abandoned. */
  readonly finished: boolean;
}

type ChildCard = Pick<
  OrchestrationCard,
  | "id"
  | "parentCardId"
  | "planKey"
  | "status"
  | "delegateAgentId"
  | "heldByCheckpoint"
  | "relations"
>;

function childState(
  card: ChildCard | undefined,
  cards: ReadonlyMap<CardId, ChildCard>,
): PlanChildState {
  if (card === undefined) return "proposed";
  switch (card.status) {
    case "landed":
      return "landed";
    case "abandoned":
      return "abandoned";
    case "inReview":
    case "landing":
      return "review";
    case "inProgress":
      return "working";
    case "triage":
    case "ready":
      if (card.heldByCheckpoint) return "held";
      if (
        card.relations.some(
          (relation) =>
            relation.kind === "blockedBy" && cards.get(relation.cardId)?.status !== "landed",
        )
      ) {
        return "blocked";
      }
      return card.delegateAgentId === null ? "needsAgent" : "queued";
  }
}

/**
 * A plan's children grouped by slice, in slice order, each with its card's progress once the plan
 * is approved. Children keep the coordinator's order within a slice.
 */
export function planSlices(
  planCardId: CardId,
  plan: Pick<CardPlan, "children">,
  cards: ReadonlyArray<ChildCard>,
): ReadonlyArray<PlanSliceView> {
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const byKey = new Map(
    cards
      .filter((card) => card.parentCardId === planCardId && card.planKey !== null)
      .map((card) => [card.planKey!, card] as const),
  );
  const titleOf = new Map(plan.children.map((child) => [child.key, child.title] as const));
  const slices = new Map<number, PlanChildView[]>();
  for (const child of plan.children) {
    const card = byKey.get(child.key);
    const views = slices.get(child.slice) ?? [];
    views.push({
      child,
      cardId: card?.id ?? null,
      state: childState(card, byId),
      dependsOnTitles: child.dependsOn.map((key) => titleOf.get(key) ?? key),
    });
    slices.set(child.slice, views);
  }
  return [...slices.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slice, children]) => ({
      slice,
      children,
      finished: children.every((view) => view.state === "landed" || view.state === "abandoned"),
    }));
}

/** How many of a migration's items are in each state. */
export function migrationCounts(
  migration: Pick<CardMigration, "items">,
): Readonly<Record<CardMigrationItemState, number>> {
  const counts = { pending: 0, running: 0, landed: 0, blocked: 0 };
  for (const item of migration.items) counts[item.state] += 1;
  return counts;
}

export const MIGRATION_PHASE_LABEL: Record<CardMigration["phase"], string> = {
  enumerating: "Listing items",
  sampling: "Trying a sample",
  tuning: "Waiting for you to tune",
  sweeping: "Sweeping the rest",
  done: "Done",
};

export const PLAN_CHILD_STATE_LABEL: Record<PlanChildState, string> = {
  proposed: "Proposed",
  needsAgent: "Needs an agent",
  held: "Held for slice checkpoint",
  blocked: "Blocked",
  queued: "Queued",
  working: "In progress",
  review: "In review",
  landed: "Landed",
  abandoned: "Abandoned",
};
