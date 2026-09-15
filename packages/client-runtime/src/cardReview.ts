import {
  ThreadId,
  type AssetResource,
  type CardActivity,
  type CardCriterion,
  type CardEvidenceItem,
  type CardFixRounds,
  type CardId,
  type CardRiskClaims,
  type CardScopeFlag,
  type ProjectOrchestration,
  type Reason,
} from "@iskra/contracts";

import { reasonLabel } from "./cards.ts";

/** The unavailable code of a CI check that hasn't reported on the pull request yet. */
const PENDING_CI_CODE = "pendingCi";

export type EvidenceItemState = "passed" | "failed" | "pending" | "captured" | "unavailable";

export interface EvidenceItemView {
  readonly item: CardEvidenceItem;
  readonly state: EvidenceItemState;
  /** Why it couldn't be captured, in words a person reads; null when it was. */
  readonly unavailableText: string | null;
  /** The screenshot or recording behind the authenticated asset route, if it can be served. */
  readonly artifact: AssetResource | null;
  /** A check's full log, as plain text behind the same route; null for anything else. */
  readonly log: AssetResource | null;
}

export type CriterionState =
  | "passed"
  | "failed"
  | "pending"
  | "unavailable"
  | "needsYourCheck"
  | "noEvidence";

export interface CriterionReview {
  readonly criterion: CardCriterion;
  readonly state: CriterionState;
  readonly items: ReadonlyArray<EvidenceItemView>;
}

export const CRITERION_STATE_LABEL: Record<CriterionState, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Waiting for CI",
  unavailable: "Not captured",
  needsYourCheck: "Needs your check",
  noEvidence: "No evidence",
};

export function unavailableText(reason: Reason): string {
  return reasonLabel(reason).label;
}

/** What the asset route previews in place; check logs go through `checkLogResource` instead. */
const SERVABLE_MEDIA = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;
const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/**
 * The asset resource for an evidence artifact. The server stores screenshots and recordings at
 * absolute paths under its attachments, which the asset route signs as media files; the thread
 * names the card's evidence thread, though an absolute path doesn't need one to resolve.
 */
export function evidenceArtifactResource(
  artifactPath: string | null,
  cardId: CardId,
): AssetResource | null {
  if (
    artifactPath === null ||
    !isAbsolutePath(artifactPath) ||
    !SERVABLE_MEDIA.test(artifactPath)
  ) {
    return null;
  }
  return {
    _tag: "media-file",
    threadId: ThreadId.make(`card-evidence-${cardId}`),
    path: artifactPath,
  };
}

/** Where CardWorkspace writes a card's check logs: `.../card-evidence-<cardId>/checks/<file>.log`. */
const CHECK_LOG = /[\\/]card-evidence-([^\\/]+)[\\/]checks[\\/]([A-Za-z0-9_-]+\.log)$/;

/** The asset resource for a check's full log, or null when the path isn't one of this card's logs. */
export function checkLogResource(artifactPath: string | null, cardId: CardId): AssetResource | null {
  const match = artifactPath === null ? null : CHECK_LOG.exec(artifactPath);
  return match === null || match[1] !== cardId || match[2] === undefined
    ? null
    : { _tag: "card-check-log", cardId, file: match[2] };
}

function evidenceItemState(item: CardEvidenceItem): EvidenceItemState {
  return item.unavailable?.code === PENDING_CI_CODE
    ? "pending"
    : item.unavailable !== null
      ? "unavailable"
      : item.kind === "check"
      ? item.exitCode === 0 && !item.timedOut
          ? "passed"
          : "failed"
        : "captured";
}

export function evidenceItemView(item: CardEvidenceItem, cardId: CardId): EvidenceItemView {
  return {
    item,
    state: evidenceItemState(item),
    unavailableText: item.unavailable === null ? null : unavailableText(item.unavailable),
    artifact: evidenceArtifactResource(item.artifactPath, cardId),
    log: item.kind === "check" ? checkLogResource(item.artifactPath, cardId) : null,
  };
}

/**
 * Review organized by acceptance criteria: each criterion with the evidence recorded for it, and
 * the evidence tied to no criterion (such as the project checks) apart. A manual criterion always
 * needs a person's check, whatever evidence sits under it; the diff is secondary to all of this.
 */
export function reviewByCriterion(input: {
  readonly cardId: CardId;
  readonly criteria: ReadonlyArray<CardCriterion>;
  readonly items: ReadonlyArray<CardEvidenceItem>;
}): {
  readonly criteria: ReadonlyArray<CriterionReview>;
  readonly general: ReadonlyArray<EvidenceItemView>;
} {
  const known = new Set(input.criteria.map((criterion) => criterion.id));
  const views = input.items.map((item) => evidenceItemView(item, input.cardId));
  const criteria = input.criteria.map((criterion): CriterionReview => {
    const items = views.filter((view) => view.item.criterionId === criterion.id);
    const state: CriterionState =
      criterion.verification === "manual"
        ? "needsYourCheck"
        : items.length === 0
          ? "noEvidence"
          : items.some((view) => view.state === "failed")
            ? "failed"
            : items.some((view) => view.state === "pending")
              ? "pending"
              : items.some((view) => view.state === "unavailable")
                ? "unavailable"
                : "passed";
    return { criterion, state, items };
  });
  const general = views.filter(
    (view) => view.item.criterionId === null || !known.has(view.item.criterionId),
  );
  return { criteria, general };
}

export const SCOPE_FLAG_LABEL: Record<CardScopeFlag["kind"], string> = {
  deletedTest: "Deleted test",
  skippedTest: "Skipped test",
  dependencyDowngrade: "Dependency downgrade",
  protectedPath: "Protected file",
  outsideLikelyAreas: "Outside the estimated areas",
};

/**
 * The pull request's CI as the evidence reads it: the checks sourced from CI, which failed, and
 * which haven't reported yet (a pending check is neither failed nor passed).
 */
export function ciSummary(items: ReadonlyArray<CardEvidenceItem>): {
  readonly total: number;
  readonly failed: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
} {
  const ci = items.filter((item) => item.source === "ci" && item.kind === "check");
  const named = (state: (value: EvidenceItemState) => boolean) =>
    ci.filter((item) => state(evidenceItemState(item))).map((item) => item.name);
  return {
    total: ci.length,
    failed: named((state) => state !== "passed" && state !== "pending"),
    pending: named((state) => state === "pending"),
  };
}

/** The reason code the agent's review request is recorded with. */
const REVIEW_REQUESTED_CODE = "reviewRequested";

const RISK_LINE =
  /\n\nRisks \(claimed\): side effects (low|medium|high), performance (low|medium|high), compatibility (low|medium|high)\.(?:\n([\s\S]*))?$/;

/**
 * The risks the agent claimed when it last asked for review, read from that request's text the
 * way the server writes it; null when it hasn't asked or the text carries no claims. Claims, not
 * evidence: review shows them as the agent's word.
 */
export function riskClaimsOf(activities: ReadonlyArray<CardActivity>): CardRiskClaims | null {
  // A loop from the end rather than findLast, which Hermes lacks.
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.reason?.code !== REVIEW_REQUESTED_CODE) continue;
    const match = RISK_LINE.exec(activity.body);
    if (match === null) return null;
    const [, sideEffect, performance, compatibility, notes] = match;
    return {
      sideEffect: sideEffect as CardRiskClaims["sideEffect"],
      performance: performance as CardRiskClaims["performance"],
      compatibility: compatibility as CardRiskClaims["compatibility"],
      notes: (notes ?? "").trim(),
    };
  }
  return null;
}

/**
 * Pull request comments from people who aren't trusted on the repository: the server marks their
 * author untrusted and delivers them to no one, so they wait for a person to forward them.
 */
export function untrustedComments(
  activities: ReadonlyArray<CardActivity>,
): ReadonlyArray<CardActivity> {
  return activities.filter(
    (activity) => activity.author.trusted === false && activity.deliverTo === null,
  );
}

interface FixRoundView {
  readonly used: number;
  readonly cap: number;
}

/** Automatic returns to work used against the project's caps, and whether either ran out. */
export function fixRoundsView(
  rounds: CardFixRounds,
  policy: Pick<ProjectOrchestration, "ciFixRounds" | "reviewFixRounds">,
): { readonly ci: FixRoundView; readonly review: FixRoundView; readonly exhausted: boolean } {
  return {
    ci: { used: rounds.ci, cap: policy.ciFixRounds },
    review: { used: rounds.review, cap: policy.reviewFixRounds },
    exhausted: rounds.ci >= policy.ciFixRounds || rounds.review >= policy.reviewFixRounds,
  };
}
