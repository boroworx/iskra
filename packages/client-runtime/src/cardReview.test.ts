import type { CardEvidenceItem } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { evidenceArtifactResource, fixRoundsView, reviewByCriterion } from "./cardReview.ts";

const item = (itemId: string, overrides: Partial<CardEvidenceItem> = {}): CardEvidenceItem => ({
  itemId,
  kind: "check",
  source: "local",
  name: itemId,
  criterionId: null,
  exitCode: 0,
  timedOut: false,
  durationMs: 1000,
  logTail: "",
  artifactPath: null,
  unavailable: null,
  ...overrides,
});

describe("reviewByCriterion", () => {
  it("groups evidence under its criterion and keeps untied evidence apart", () => {
    const review = reviewByCriterion({
      criteria: [
        { id: "login", text: "Login works", verification: "automated" },
        { id: "screen", text: "The screen shows", verification: "automated" },
        { id: "ios", text: "Looks right on iOS", verification: "manual" },
        { id: "empty", text: "Nothing recorded", verification: "automated" },
      ],
      items: [
        item("typecheck"),
        item("login-test", { criterionId: "login", exitCode: 1 }),
        item("login-slow", { criterionId: "login", exitCode: null, timedOut: true }),
        item("shot", {
          kind: "screenshot",
          source: "preview",
          criterionId: "screen",
          exitCode: null,
          unavailable: { code: "noPreviewHost", text: "No host." },
        }),
        item("ios-unit", { criterionId: "ios" }),
        item("orphan", { criterionId: "removed-criterion" }),
      ],
    });

    expect(
      review.criteria.map((entry) => [entry.criterion.id, entry.state, entry.items.length]),
    ).toEqual([
      ["login", "failed", 2],
      ["screen", "unavailable", 1],
      ["ios", "needsYourCheck", 1],
      ["empty", "noEvidence", 0],
    ]);
    expect(review.criteria[1]?.items[0]?.unavailableText).toBe(
      "No desktop client was connected to capture the preview",
    );
    expect(review.general.map((view) => [view.item.itemId, view.state])).toEqual([
      ["typecheck", "passed"],
      ["orphan", "passed"],
    ]);
  });

  it("serves artifacts as attachments named by their file, inline only for media", () => {
    expect(
      evidenceArtifactResource("/home/u/.iskra/attachments/card-evidence-c1-uuid-png.png"),
    ).toEqual({
      _tag: "attachment",
      attachmentId: "card-evidence-c1-uuid-png",
      fileName: "card-evidence-c1-uuid-png.png",
      disposition: "inline",
    });
    expect(evidenceArtifactResource("logs/check-log.txt")).toMatchObject({
      disposition: "attachment",
    });
    expect(evidenceArtifactResource(null)).toBeNull();
  });
});

describe("fixRoundsView", () => {
  it("reports rounds against the project's caps", () => {
    expect(fixRoundsView({ ci: 2, review: 0 }, { ciFixRounds: 2, reviewFixRounds: 2 })).toEqual({
      ci: { used: 2, cap: 2 },
      review: { used: 0, cap: 2 },
      exhausted: true,
    });
    expect(
      fixRoundsView({ ci: 1, review: 1 }, { ciFixRounds: 2, reviewFixRounds: 2 }).exhausted,
    ).toBe(false);
  });
});
