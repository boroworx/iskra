import type { CardRiskClaims } from "@iskra/contracts";

const RISK_LINE = /\n\nRisks \(claimed\): side effects (low|medium|high), performance (low|medium|high), compatibility (low|medium|high)\.(?:\n([\s\S]*))?$/;

/** The text a review request is recorded with: the owner's summary and its risk claims. */
export function renderReviewRequest(summary: string, risks: CardRiskClaims): string {
  const notes = risks.notes.trim();
  return `${summary.trim()}\n\nRisks (claimed): side effects ${risks.sideEffect}, performance ${risks.performance}, compatibility ${risks.compatibility}.${notes.length > 0 ? `\n${notes}` : ""}`;
}

/** The risk claims a review request's text carries, or null for text without them. */
export function riskClaimsOf(body: string): CardRiskClaims | null {
  const match = RISK_LINE.exec(body);
  if (match === null) return null;
  const [, sideEffect, performance, compatibility, notes] = match;
  return {
    sideEffect: sideEffect as CardRiskClaims["sideEffect"],
    performance: performance as CardRiskClaims["performance"],
    compatibility: compatibility as CardRiskClaims["compatibility"],
    notes: notes ?? "",
  };
}
