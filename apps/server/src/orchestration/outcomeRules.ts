import type { CardOutcome, OrchestrationCard, Reason } from "@iskra/contracts";

/** How long a landed card is watched before it counts as a success. */
export const OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pauses that mean the work couldn't be done, so abandoning after one is a blocked outcome. */
export const BLOCKED_PAUSE_CODES: ReadonlyArray<string> = ["fixRoundsExhausted", "startFailed", "sessionFailed"];

/** The reason code Iskra records when a card's branch carries commits from someone else. */
export const FOREIGN_COMMIT_CODE = "foreignCommit";

/**
 * What the outcome reactor found about a landed card.
 * ponytail: heuristics over revert, CI-on-base and author signals; a person's override is the
 * correction. Upgrade path: pull-request-level revert and blame signals from the host.
 */
export interface LandedSignals {
  readonly landedAt: string;
  /** A revert card for it landed. */
  readonly revertLanded: boolean;
  /** Its base has a commit saying "This reverts commit <landedSha>". */
  readonly revertOnBase: boolean;
  /** A CI failure trigger fired on a later base commit, and the failure names a file it changed. */
  readonly ciFailureOnBase: boolean;
  /** A person merged it on the host instead of through Iskra. */
  readonly mergedOnHost: boolean;
  /** Its branch carried commits from an author other than this machine's. */
  readonly foreignCommit: boolean;
}

const reason = (code: string, text: string): Reason => ({ code, text });

/**
 * A finished card's outcome, or null while it isn't decided yet (or never will be here). Blocked is
 * immediate; flawed as soon as a signal shows inside the window; manual or success once the window
 * passes. An outcome already recorded, a person's included, is never replaced.
 */
export function outcomeOf(input: {
  readonly card: Pick<OrchestrationCard, "status" | "outcome" | "paused">;
  readonly now: string;
  readonly landed: LandedSignals | null;
}): CardOutcome | null {
  const { card, now, landed } = input;
  if (card.outcome !== null) return null;
  if (card.status === "abandoned") {
    const pause = card.paused?.reason;
    return pause !== undefined && BLOCKED_PAUSE_CODES.includes(pause.code)
      ? { state: "blocked", decidedAt: now, signals: [pause] }
      : null;
  }
  if (card.status !== "landed" || landed === null) return null;

  const flawed = [
    ...(landed.revertLanded ? [reason("revertLanded", "A revert of it landed.")] : []),
    ...(landed.revertOnBase ? [reason("revertOnBase", "Its base has a commit reverting it.")] : []),
    ...(landed.ciFailureOnBase
      ? [reason("ciFailureOnBase", "CI failed on its base after it landed, in a file it changed.")]
      : []),
  ];
  if (flawed.length > 0) return { state: "flawed", decidedAt: now, signals: flawed };
  if (Date.parse(now) - Date.parse(landed.landedAt) < OUTCOME_WINDOW_MS) return null;

  const manual = [
    ...(landed.mergedOnHost ? [reason("mergedOnHost", "A person merged it on the host.")] : []),
    ...(landed.foreignCommit
      ? [reason(FOREIGN_COMMIT_CODE, "Its branch has commits from someone other than Iskra.")]
      : []),
  ];
  return manual.length > 0
    ? { state: "manual", decidedAt: now, signals: manual }
    : {
        state: "success",
        decidedAt: now,
        signals: [reason("quietWindow", "Nothing went wrong in the 7 days after it landed.")],
      };
}

/** What a person reads on a flawed card: why, and that a hidden scenario would catch it next time. */
export const outcomeFlawedBody = (outcome: CardOutcome): string =>
  `This card turned out flawed: ${outcome.signals.map((signal) => signal.text).join(" ")} Add a hidden scenario so the verifier catches this next time.`;

/** The first full commit SHA in a text, such as a CI failure card's spec. */
export const firstCommitSha = (text: string): string | null => /\b[0-9a-f]{40}\b/.exec(text)?.[0] ?? null;
