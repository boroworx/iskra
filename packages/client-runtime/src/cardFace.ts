import type { CardOutcome, CardStatus, OrchestrationCardShell } from "@iskra/contracts";

import type { CriterionState } from "./cardReview.ts";

/** A status pill's color: blue for work, orange when a person is needed, green verified, red failed. */
export type PillTone = "gray" | "blue" | "orange" | "green" | "red";
/** The spark on an agent's avatar and a card's face. */
export type SparkState = "idle" | "working" | "needsYou" | "landed";
/** One acceptance criterion as a mark on a card's face. */
export type CriterionMark = "passed" | "failed" | "pending" | "needsYou";

type FaceFacts = Pick<
  OrchestrationCardShell,
  | "status"
  | "paused"
  | "verification"
  | "ownerSession"
  | "openElicitations"
  | "attention"
  | "checkpoint"
  | "evidence"
  | "acceptance"
>;

const STATUS_PILL: Record<CardStatus, { readonly label: string; readonly tone: PillTone }> = {
  triage: { label: "Proposed", tone: "orange" },
  ready: { label: "Queued", tone: "gray" },
  inProgress: { label: "In Progress", tone: "blue" },
  inReview: { label: "In Review", tone: "orange" },
  landing: { label: "Landing", tone: "blue" },
  landed: { label: "Landed", tone: "green" },
  abandoned: { label: "Abandoned", tone: "gray" },
};

/** A card's status pill: its column's word, or Paused, Failed or Verifying when that says more. */
export function cardStatusPill(card: FaceFacts): {
  readonly label: string;
  readonly tone: PillTone;
} {
  if (card.status !== "landed" && card.status !== "abandoned") {
    if (card.paused !== null) {
      return card.paused.reason.code === "sessionFailed"
        ? { label: "Failed", tone: "red" }
        : { label: "Paused", tone: "gray" };
    }
    if (card.status === "inReview" && card.verification.state === "running") {
      return { label: "Verifying", tone: "blue" };
    }
  }
  return STATUS_PILL[card.status];
}

const OUTCOME_PILL: Record<CardOutcome["state"], { readonly label: string; readonly tone: PillTone }> =
  {
    success: { label: "Success", tone: "green" },
    flawed: { label: "Flawed", tone: "red" },
    blocked: { label: "Blocked", tone: "orange" },
    manual: { label: "Manual", tone: "gray" },
  };

/** How a finished card turned out, as a pill; null until its outcome is decided. */
export function outcomePill(
  outcome: CardOutcome | null,
): { readonly label: string; readonly tone: PillTone } | null {
  return outcome === null ? null : OUTCOME_PILL[outcome.state];
}

/** The card's spark: whether it works, waits on a person, landed, or rests. */
export function cardSparkState(card: FaceFacts): SparkState {
  if (card.status === "landed") return "landed";
  if (card.status === "abandoned") return "idle";
  if (
    card.status === "triage" ||
    card.checkpoint !== null ||
    card.openElicitations.length > 0 ||
    card.attention.length > 0 ||
    card.paused?.by === "system" ||
    card.ownerSession?.state === "awaitingInput"
  ) {
    return "needsYou";
  }
  if (card.verification.state === "running") return "working";
  // In review, the card waits on a person's approval unless a verifier still has it.
  if (card.status === "inReview") return card.verification.state === "pending" ? "working" : "needsYou";
  return card.ownerSession?.state === "active" || card.ownerSession?.state === "pending"
    ? "working"
    : "idle";
}

/**
 * The card's criteria as marks on its face, from what the shell knows: all automated criteria pass
 * once the card landed, its verifier passed or was overridden, or its evidence passed with no
 * verifier; a manual criterion waits on a person until the card lands. Review shows each exactly.
 */
export function criteriaMarks(card: FaceFacts): ReadonlyArray<CriterionMark> {
  const verified =
    card.status === "landed" ||
    card.verification.state === "passed" ||
    card.verification.state === "overridden" ||
    (card.verification.state === "off" && card.evidence?.passed === true);
  return card.acceptance.criteria.map((criterion) =>
    criterion.verification === "manual"
      ? card.status === "landed"
        ? "passed"
        : "needsYou"
      : verified
        ? "passed"
        : "pending",
  );
}

/** A reviewed criterion as a mark, for review's own marks. */
export function markOfCriterionState(state: CriterionState): CriterionMark {
  switch (state) {
    case "passed":
    case "coveredByChecks":
      return "passed";
    case "failed":
      return "failed";
    case "needsYourCheck":
      return "needsYou";
    case "pending":
    case "unavailable":
    case "noEvidence":
      return "pending";
  }
}

/**
 * A card's short caption id, as the board, review and proposals show it: `C-` and the first four
 * letters or digits of its id, after any `card-` prefix.
 */
export function cardShortId(cardId: string): string {
  return `C-${cardId
    .replace(/^card-/, "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 4)
    .toUpperCase()}`;
}
