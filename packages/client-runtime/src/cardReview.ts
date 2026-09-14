import type {
  AssetResource,
  CardActivity,
  CardCriterion,
  CardEvidenceItem,
  CardFixRounds,
  CardScopeFlag,
  ProjectOrchestration,
  Reason,
} from "@iskra/contracts";

import { NO_PREVIEW_HOST_TEXT } from "./cards.ts";

export type EvidenceItemState = "passed" | "failed" | "captured" | "unavailable";

export interface EvidenceItemView {
  readonly item: CardEvidenceItem;
  readonly state: EvidenceItemState;
  /** Why it couldn't be captured, in words a person reads; null when it was. */
  readonly unavailableText: string | null;
  /** The screenshot, recording or full log behind the authenticated asset route, if any. */
  readonly artifact: AssetResource | null;
}

export type CriterionState = "passed" | "failed" | "unavailable" | "needsYourCheck" | "noEvidence";

export interface CriterionReview {
  readonly criterion: CardCriterion;
  readonly state: CriterionState;
  readonly items: ReadonlyArray<EvidenceItemView>;
}

export const CRITERION_STATE_LABEL: Record<CriterionState, string> = {
  passed: "Passed",
  failed: "Failed",
  unavailable: "Not captured",
  needsYourCheck: "Needs your check",
  noEvidence: "No evidence",
};

export function unavailableText(reason: Reason): string {
  return reason.code === "noPreviewHost" ? NO_PREVIEW_HOST_TEXT : reason.text;
}

const IMAGE_OR_VIDEO = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;

/**
 * The asset resource for an evidence artifact. Evidence files are attachments: their file name
 * without its extension is the attachment id the asset route signs, so they load only through an
 * authenticated URL. Images and recordings open inline; logs download.
 */
export function evidenceArtifactResource(artifactPath: string | null): AssetResource | null {
  const fileName = artifactPath?.split(/[\\/]/).at(-1) ?? "";
  const dot = fileName.lastIndexOf(".");
  const attachmentId = dot > 0 ? fileName.slice(0, dot) : fileName;
  if (attachmentId.length === 0) return null;
  return {
    _tag: "attachment",
    attachmentId,
    fileName,
    disposition: IMAGE_OR_VIDEO.test(fileName) ? "inline" : "attachment",
  };
}

export function evidenceItemView(item: CardEvidenceItem): EvidenceItemView {
  const state: EvidenceItemState =
    item.unavailable !== null
      ? "unavailable"
      : item.kind === "check"
        ? item.exitCode === 0 && !item.timedOut
          ? "passed"
          : "failed"
        : "captured";
  return {
    item,
    state,
    unavailableText: item.unavailable === null ? null : unavailableText(item.unavailable),
    artifact: evidenceArtifactResource(item.artifactPath),
  };
}

/**
 * Review organized by acceptance criteria: each criterion with the evidence recorded for it, and
 * the evidence tied to no criterion (such as the project checks) apart. A manual criterion always
 * needs a person's check, whatever evidence sits under it; the diff is secondary to all of this.
 */
export function reviewByCriterion(input: {
  readonly criteria: ReadonlyArray<CardCriterion>;
  readonly items: ReadonlyArray<CardEvidenceItem>;
}): {
  readonly criteria: ReadonlyArray<CriterionReview>;
  readonly general: ReadonlyArray<EvidenceItemView>;
} {
  const known = new Set(input.criteria.map((criterion) => criterion.id));
  const views = input.items.map(evidenceItemView);
  const criteria = input.criteria.map((criterion): CriterionReview => {
    const items = views.filter((view) => view.item.criterionId === criterion.id);
    const state: CriterionState =
      criterion.verification === "manual"
        ? "needsYourCheck"
        : items.length === 0
          ? "noEvidence"
          : items.some((view) => view.state === "failed")
            ? "failed"
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

/** The pull request's CI as the evidence reads it: the checks sourced from CI and how many failed. */
export function ciSummary(items: ReadonlyArray<CardEvidenceItem>): {
  readonly total: number;
  readonly failed: ReadonlyArray<string>;
} {
  const ci = items.filter((item) => item.source === "ci" && item.kind === "check");
  return {
    total: ci.length,
    failed: ci.filter((item) => evidenceItemView(item).state !== "passed").map((item) => item.name),
  };
}

/**
 * Pull request comments from people who aren't trusted on the repository: recorded on the card but
 * delivered to no one, so they wait for a person to forward them to the agent.
 */
export function untrustedComments(
  activities: ReadonlyArray<CardActivity>,
): ReadonlyArray<CardActivity> {
  return activities.filter(
    (activity) =>
      activity.kind === "message" &&
      activity.author.kind === "github" &&
      activity.deliverTo === null,
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
