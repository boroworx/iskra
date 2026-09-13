import type {
  CardMove,
  CardRelation,
  CardRelationKind,
  CardStatus,
  OrchestrationCard,
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
      return from === "abandoned" ? to("triage") : reject("Only an abandoned card can be reopened.");
  }
}

/**
 * Assigning or changing the delegate. Not a status move: work starts when the
 * delegate's first write session does. The delegate cannot change during a live
 * write session (one writer per card), before approval, or once finished.
 */
export function canChangeDelegate(
  card: Pick<CardFacts, "status">,
  hasLiveWriteSession: boolean,
): CardRuleCheck {
  if (isFinishedCardStatus(card.status)) {
    return { ok: false, reason: "A card that has landed or been abandoned keeps its agent." };
  }
  if (card.status === "triage") {
    return { ok: false, reason: "Approve the card before assigning an agent." };
  }
  if (hasLiveWriteSession) {
    return { ok: false, reason: "Wait for the current session to end before changing the agent." };
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
