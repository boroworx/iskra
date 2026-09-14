import { describe, expect, it } from "vite-plus/test";

import { renderReviewRequest, riskClaimsOf } from "./CardEvidence.ts";

describe("review request risk claims", () => {
  it("reads back the claims a review request was recorded with, notes included", () => {
    const risks = {
      sideEffect: "high",
      performance: "low",
      compatibility: "medium",
      notes: "Sends email on signup.\nOnly in staging.",
    } as const;
    const body = renderReviewRequest("Adds signup emails.", risks);
    expect(body).toBe(
      "Adds signup emails.\n\nRisks (claimed): side effects high, performance low, compatibility medium.\nSends email on signup.\nOnly in staging.",
    );
    expect(riskClaimsOf(body)).toEqual(risks);
    expect(riskClaimsOf(renderReviewRequest("x", { ...risks, notes: " " }))).toEqual({
      ...risks,
      notes: "",
    });
    expect(riskClaimsOf("Just a message.")).toBeNull();
  });
});
