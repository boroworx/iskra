import {
  CARD_AUTOFIX_ATTEMPTS,
  type CardId,
  type CardStatus,
  type OrchestrationCard,
  type ProjectId,
  type RunSessionState,
  type CardPriority,
} from "@iskra/contracts";

/** The board's columns, left to right. Landed and abandoned cards share Done. */
export const BOARD_COLUMNS = ["triage", "ready", "inProgress", "inReview", "landing", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABEL: Record<BoardColumn, string> = {
  triage: "Triage",
  ready: "Ready",
  inProgress: "In progress",
  inReview: "Review",
  landing: "Landing",
  done: "Done",
};

export function boardColumnOf(status: CardStatus): BoardColumn {
  return status === "landed" || status === "abandoned" ? "done" : status;
}

/** The human decision a drag stands for; everything else moves on its own. */
export type CardDecisionCommand =
  | "card.approve"
  | "card.unapprove"
  | "card.merge.approve"
  | "card.merge.cancel"
  | "card.abandon"
  | "card.reopen";

export type CardDropDecision =
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly type: CardDecisionCommand }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * What dropping a card in a column means. Only human decisions move a card by
 * hand; a drop anywhere else snaps back with the reason. The server can still
 * refuse a decision (an open sub-card, a blocker) and its reason is shown then.
 */
export function cardDropDecision(status: CardStatus, to: BoardColumn): CardDropDecision {
  if (boardColumnOf(status) === to) {
    return { kind: "none" };
  }
  if (status === "landed") {
    return { kind: "refuse", reason: "A landed card is finished." };
  }
  if (status === "abandoned") {
    return to === "triage"
      ? { kind: "command", type: "card.reopen" }
      : { kind: "refuse", reason: "Reopen an abandoned card by dropping it on Triage." };
  }
  switch (to) {
    case "done":
      return { kind: "command", type: "card.abandon" };
    case "ready":
      return status === "triage"
        ? { kind: "command", type: "card.approve" }
        : { kind: "refuse", reason: "Only a card in triage can be approved." };
    case "triage":
      return status === "ready"
        ? { kind: "command", type: "card.unapprove" }
        : { kind: "refuse", reason: "Only a ready card whose work has not started can go back to triage." };
    case "landing":
      return status === "inReview"
        ? { kind: "command", type: "card.merge.approve" }
        : { kind: "refuse", reason: "Only a card in review can be approved to merge." };
    case "inReview":
      return status === "landing"
        ? { kind: "command", type: "card.merge.cancel" }
        : { kind: "refuse", reason: "The card's agent sends it to review when the work is done." };
    case "inProgress":
      return {
        kind: "refuse",
        reason: "Work starts when the card's agent starts its first session; assign an agent instead.",
      };
  }
}

type SnoozeFacts = Pick<OrchestrationCard, "snoozedUntil" | "snoozedAt" | "activityAt">;

/** Snoozed until its time passes or the card has new activity, whichever comes first. */
export function isCardSnoozed(card: SnoozeFacts, now: number): boolean {
  if (card.snoozedAt === null || Date.parse(card.activityAt) > Date.parse(card.snoozedAt)) {
    return false;
  }
  return card.snoozedUntil === null || Date.parse(card.snoozedUntil) > now;
}

/** A card session's standing, as the Needs you list reads it. */
export interface CardSessionSummary {
  readonly cardId: CardId;
  readonly state: RunSessionState;
  /** When the session reached this state. */
  readonly since: string;
}

export type NeedsYouKind =
  | "triage"
  | "spec"
  | "awaitingInput"
  | "sessionFailed"
  | "readyToMerge"
  | "checksExhausted"
  | "budgetReached"
  | "unpricedModel";

/** Linear's priority names, most urgent first, then none. */
export const CARD_PRIORITIES: ReadonlyArray<CardPriority> = [1, 2, 3, 4, 0];
export const CARD_PRIORITY_LABEL: Record<CardPriority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export interface NeedsYouItem {
  readonly key: string;
  readonly kind: NeedsYouKind;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** When the item started waiting on a person. */
  readonly since: string;
  /** A session waiting on an answer is never snoozed away. */
  readonly snoozable: boolean;
}

export const NEEDS_YOU_LABEL: Record<NeedsYouKind, string> = {
  triage: "Approve or drop this proposal",
  spec: "Approve or skip the spec",
  awaitingInput: "Its agent is waiting on you",
  sessionFailed: "Its session stopped without finishing",
  readyToMerge: "Checks passed; approve the merge",
  checksExhausted: "Checks kept failing; its agent stopped retrying",
  budgetReached: "It reached its budget; raise the cap to continue",
  unpricedModel: "Its model has no known price; accept running it uncapped",
};

/**
 * Everything across projects waiting on a person, longest waiting first. Derived,
 * never stored; snoozed cards drop out until their time or their next activity.
 */
export function needsYouItems(input: {
  readonly cards: ReadonlyArray<OrchestrationCard>;
  readonly sessions: ReadonlyArray<CardSessionSummary>;
  readonly now: number;
}): ReadonlyArray<NeedsYouItem> {
  const items: NeedsYouItem[] = [];
  const cardsById = new Map(input.cards.map((card) => [card.id, card] as const));
  for (const card of input.cards) {
    const base = { cardId: card.id, projectId: card.projectId, title: card.title, snoozable: true };
    if (card.status === "triage") {
      items.push({ ...base, key: `triage:${card.id}`, kind: "triage", since: card.createdAt });
    } else if (
      card.specState === "draft" &&
      card.spec.trim().length > 0 &&
      card.status !== "landed" &&
      card.status !== "abandoned"
    ) {
      items.push({ ...base, key: `spec:${card.id}`, kind: "spec", since: card.updatedAt });
    }
    if (card.status === "inReview" && card.checks !== null) {
      if (card.checks.state === "passed") {
        items.push({
          ...base,
          key: `merge:${card.id}`,
          kind: "readyToMerge",
          since: card.checks.updatedAt,
        });
      } else if (card.checks.state === "failed" && card.checks.failedRuns >= CARD_AUTOFIX_ATTEMPTS) {
        items.push({
          ...base,
          key: `checks:${card.id}`,
          kind: "checksExhausted",
          since: card.checks.updatedAt,
        });
      }
    }
    // Invariant 13: a card that may not spend waits on a person.
    if (card.status !== "landed" && card.status !== "abandoned") {
      if (card.spentUsd >= card.budgetCapUsd) {
        items.push({ ...base, key: `budget:${card.id}`, kind: "budgetReached", since: card.activityAt });
      } else if (card.unpricedTurns > 0 && !card.acceptsUnpriced) {
        items.push({ ...base, key: `unpriced:${card.id}`, kind: "unpricedModel", since: card.activityAt });
      }
    }
  }
  for (const session of input.sessions) {
    const card = cardsById.get(session.cardId);
    if (card === undefined) {
      continue;
    }
    const base = { cardId: card.id, projectId: card.projectId, title: card.title, since: session.since };
    if (session.state === "awaitingInput") {
      items.push({ ...base, key: `input:${card.id}`, kind: "awaitingInput", snoozable: false });
    } else if (session.state === "error" || session.state === "stale") {
      items.push({ ...base, key: `failed:${card.id}`, kind: "sessionFailed", snoozable: true });
    }
  }
  return items
    .filter((item) => {
      const card = cardsById.get(item.cardId);
      return !item.snoozable || card === undefined || !isCardSnoozed(card, input.now);
    })
    // The filter's copy is sorted in place: Hermes has no Array#toSorted.
    .sort((left, right) => Date.parse(left.since) - Date.parse(right.since));
}

/** How long an item has waited, at the coarsest unit that says it: "4m", "3h", "2d". */
export function waitingLabel(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
