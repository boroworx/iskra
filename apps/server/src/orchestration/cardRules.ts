import {
  DEFAULT_CARD_BUDGET_USD,
  type CardId,
  type CardMove,
  type CardRelation,
  type CardRelationKind,
  type CardStatus,
  type OrchestrationCard,
  type OrchestrationEvent,
} from "@iskra/contracts";

/**
 * A card's status is derived from what happened to it. Humans decide only
 * approve, assign, approve merge and abandon, plus the reverse of each; every
 * other move happens on an event. Pure: the decider calls these and turns a
 * rejection into a command error.
 */

/** What the status rules need to know about a card besides its status. */
export interface CardFacts {
  readonly status: CardStatus;
  readonly delegateAgentId: string | null;
  /** Sub-cards that have neither landed nor been abandoned. */
  readonly openChildCount: number;
  /** `blockedBy` relations whose blocker has not landed. */
  readonly openBlockerCount: number;
}

export type CardMoveResult =
  | { readonly ok: true; readonly status: CardStatus }
  | { readonly ok: false; readonly reason: string };

export type CardRuleCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const reject = (reason: string): CardMoveResult => ({ ok: false, reason });
const to = (status: CardStatus): CardMoveResult => ({ ok: true, status });

/** Landed and abandoned cards are finished: nothing moves them except reopening an abandoned one. */
export const isFinishedCardStatus = (status: CardStatus): boolean =>
  status === "landed" || status === "abandoned";

/** The status a card moves to, or why it cannot. */
export function nextCardStatus(card: CardFacts, move: CardMove): CardMoveResult {
  const from = card.status;
  switch (move) {
    case "approve":
      return from === "triage" ? to("ready") : reject("Only a card in triage can be approved.");
    case "unapprove":
      return from === "ready"
        ? to("triage")
        : reject("Only a ready card whose work has not started can go back to triage.");
    case "workStarted":
      if (from !== "ready") {
        return reject("Work can only start on a ready card.");
      }
      return card.delegateAgentId === null
        ? reject("Assign an agent before work starts.")
        : to("inProgress");
    case "requestReview":
      return from === "inProgress"
        ? to("inReview")
        : reject("Only a card in progress can be sent to review.");
    case "returnToWork":
      return from === "inReview" || from === "landing"
        ? to("inProgress")
        : reject("Only a card in review or landing can go back to work.");
    case "approveMerge":
      if (from !== "inReview") {
        return reject("Only a card in review can be approved to merge.");
      }
      if (card.openChildCount > 0) {
        return reject("Land or abandon its sub-cards first.");
      }
      return card.openBlockerCount > 0
        ? reject("It is blocked by a card that has not landed.")
        : to("landing");
    case "cancelLanding":
      return from === "landing"
        ? to("inReview")
        : reject("Only a card in the merge queue can be taken out of it.");
    case "landed":
      return from === "landing" ? to("landed") : reject("Only a landing card can land.");
    case "abandon":
      return isFinishedCardStatus(from)
        ? reject("A card that has landed or been abandoned cannot be abandoned.")
        : to("abandoned");
    case "reopen":
      return from === "abandoned"
        ? to("triage")
        : reject("Only an abandoned card can be reopened.");
  }
}

/**
 * Assigning or changing the delegate. Not a status move: work starts when the
 * delegate's first write session does. The delegate cannot change while the
 * owner session is in a turn (one writer per card), before approval, or once
 * finished. An idle owner session is stopped and handed off.
 */
export function canChangeDelegate(
  card: Pick<CardFacts, "status">,
  ownerTurnRunning: boolean,
): CardRuleCheck {
  if (isFinishedCardStatus(card.status)) {
    return { ok: false, reason: "A card that has landed or been abandoned keeps its agent." };
  }
  if (card.status === "triage") {
    return { ok: false, reason: "Approve the card before assigning an agent." };
  }
  if (ownerTurnRunning) {
    return {
      ok: false,
      reason: "Wait for the agent's current turn to end before changing the agent.",
    };
  }
  return { ok: true };
}

/** A card's facts as the rules see them, counted from the project's cards. */
export function cardFactsOf(
  cards: ReadonlyArray<OrchestrationCard>,
  card: OrchestrationCard,
): CardFacts {
  const statusById = new Map(cards.map((candidate) => [candidate.id, candidate.status] as const));
  return {
    status: card.status,
    delegateAgentId: card.delegateAgentId,
    openChildCount: cards.filter(
      (candidate) => candidate.parentCardId === card.id && !isFinishedCardStatus(candidate.status),
    ).length,
    openBlockerCount: card.relations.filter(
      (relation) => relation.kind === "blockedBy" && statusById.get(relation.cardId) !== "landed",
    ).length,
  };
}

const INVERSE_RELATION: Readonly<Record<CardRelationKind, CardRelationKind | null>> = {
  blocks: "blockedBy",
  blockedBy: "blocks",
  duplicateOf: null,
  related: "related",
  overlaps: "overlaps",
};

/** The relation the other card holds back, or null when it is one-way (`duplicateOf`). */
export const inverseRelationKind = (kind: CardRelationKind): CardRelationKind | null =>
  INVERSE_RELATION[kind];

const sameRelation = (left: CardRelation, right: CardRelation) =>
  left.kind === right.kind && left.cardId === right.cardId;

export function withRelation(
  relations: ReadonlyArray<CardRelation>,
  relation: CardRelation,
): ReadonlyArray<CardRelation> {
  return relations.some((existing) => sameRelation(existing, relation))
    ? relations
    : [...relations, relation];
}

export function withoutRelation(
  relations: ReadonlyArray<CardRelation>,
  relation: CardRelation,
): ReadonlyArray<CardRelation> {
  return relations.filter((existing) => !sameRelation(existing, relation));
}

/**
 * Why a card's turns cannot start (invariant 13): its spend reached the cap, or
 * its model has no known price and no person accepted running it uncapped.
 */
export function cardBudgetRefusal(
  card: Pick<OrchestrationCard, "spentUsd" | "budgetCapUsd" | "unpricedTurns" | "acceptsUnpriced">,
): string | null {
  if (card.spentUsd >= card.budgetCapUsd) {
    return `The card has spent $${card.spentUsd.toFixed(2)} of its $${card.budgetCapUsd.toFixed(2)} budget; raise the cap to continue.`;
  }
  if (card.unpricedTurns > 0 && !card.acceptsUnpriced) {
    return "The card's model has no known price; accept running it uncapped to continue.";
  }
  return null;
}

/** A card as the read model and its projection row both hold it, less the id they key differently. */
export type CardFields = Omit<OrchestrationCard, "id">;

/** One change to a card, applied alike to the read model's card and its projection row. */
export type CardPatch = <C extends CardFields>(card: C) => C;

/** A new card's fields from its `card.created` payload. */
export function newCard(
  payload: Extract<OrchestrationEvent, { type: "card.created" }>["payload"],
): CardFields {
  return {
    projectId: payload.projectId,
    channelId: payload.channelId,
    parentCardId: payload.parentCardId,
    title: payload.title,
    spec: payload.spec,
    specState: payload.specState,
    tags: payload.tags,
    status: payload.status,
    ownerHumanId: payload.ownerHumanId,
    delegateAgentId: null,
    baseBranch: payload.baseBranch,
    branch: null,
    worktreePath: null,
    portBase: null,
    relations: [],
    snoozedUntil: null,
    snoozedAt: null,
    activityAt: payload.createdAt,
    diffStat: null,
    checks: null,
    spentUsd: 0,
    budgetCapUsd: DEFAULT_CARD_BUDGET_USD,
    unpricedTurns: 0,
    acceptsUnpriced: false,
    reviewReturns: 0,
    attemptGroupId: payload.attemptGroupId ?? null,
    linearIssue: null,
    sourceMessageId: payload.sourceMessageId ?? null,
    proposalReasoning: payload.proposalReasoning ?? null,
    suggestedAgentId: payload.suggestedAgentId ?? null,
    priority: payload.priority ?? 0,
    createdBy: payload.createdBy,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

/** Marks something happening on a card, which also wakes it from a snooze. */
export const touchCard =
  (activityAt: string): CardPatch =>
  (card) => ({ ...card, activityAt });

/**
 * The cards an event changes, and how. A relation change also gives the other card the inverse,
 * when there is one. `card.session-started` touches its card too, but projections apply that where
 * they record the run.
 */
export function cardPatches(
  event: OrchestrationEvent,
): ReadonlyArray<readonly [CardId, CardPatch]> {
  switch (event.type) {
    case "card.updated": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.spec !== undefined ? { spec: payload.spec } : {}),
            ...(payload.specState !== undefined ? { specState: payload.specState } : {}),
            ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
            ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
            updatedAt: payload.updatedAt,
            activityAt: payload.updatedAt,
          }),
        ],
      ];
    }
    case "card.status-changed": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            status: payload.to,
            updatedAt: payload.updatedAt,
            activityAt: payload.updatedAt,
            reviewReturns: card.reviewReturns + (payload.move === "returnToWork" ? 1 : 0),
          }),
        ],
      ];
    }
    case "card.delegate-changed": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            delegateAgentId: payload.delegateAgentId,
            updatedAt: payload.updatedAt,
            activityAt: payload.updatedAt,
          }),
        ],
      ];
    }
    case "card.relation-added":
    case "card.relation-removed": {
      const { cardId, kind, otherCardId, updatedAt } = event.payload;
      const change = event.type === "card.relation-added" ? withRelation : withoutRelation;
      const relate =
        (relation: CardRelation): CardPatch =>
        (card) => ({ ...card, relations: change(card.relations, relation), updatedAt });
      const inverse = inverseRelationKind(kind);
      return inverse === null
        ? [[cardId, relate({ kind, cardId: otherCardId })]]
        : [
            [cardId, relate({ kind, cardId: otherCardId })],
            [otherCardId, relate({ kind: inverse, cardId })],
          ];
    }
    case "card.workspace-set": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            portBase: payload.portBase,
            updatedAt: payload.updatedAt,
          }),
        ],
      ];
    }
    case "card.workspace-cleared": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            branch: null,
            worktreePath: null,
            portBase: null,
            updatedAt: payload.updatedAt,
          }),
        ],
      ];
    }
    case "card.decision-recorded":
    case "card.message-posted":
      return [[event.payload.cardId, touchCard(event.payload.createdAt)]];
    case "card.spec-submitted":
      return [[event.payload.cardId, touchCard(event.payload.submittedAt)]];
    case "card.snoozed": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({ ...card, snoozedUntil: payload.snoozedUntil, snoozedAt: payload.snoozedAt }),
        ],
      ];
    }
    case "card.unsnoozed":
      return [[event.payload.cardId, (card) => ({ ...card, snoozedUntil: null, snoozedAt: null })]];
    case "card.spend-recorded": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            spentUsd: card.spentUsd + payload.costUsd,
            unpricedTurns: card.unpricedTurns + (payload.costSource === "unpriced" ? 1 : 0),
          }),
        ],
      ];
    }
    case "card.linear-synced": {
      const { payload } = event;
      return [[payload.cardId, (card) => ({ ...card, linearIssue: payload.issue })]];
    }
    case "card.budget-set": {
      const { payload } = event;
      return [[payload.cardId, (card) => ({ ...card, budgetCapUsd: payload.capUsd })]];
    }
    case "card.unpriced-accepted": {
      const { payload } = event;
      return [[payload.cardId, (card) => ({ ...card, acceptsUnpriced: payload.accepts })]];
    }
    case "card.checks-updated": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({ ...card, checks: payload.checks, activityAt: payload.checks.updatedAt }),
        ],
      ];
    }
    case "card.diff-measured": {
      const { payload } = event;
      return [[payload.cardId, (card) => ({ ...card, diffStat: payload.diffStat })]];
    }
    case "card.spec-state-changed": {
      const { payload } = event;
      return [
        [
          payload.cardId,
          (card) => ({
            ...card,
            specState: payload.to,
            updatedAt: payload.updatedAt,
            activityAt: payload.updatedAt,
          }),
        ],
      ];
    }
    default:
      return [];
  }
}
