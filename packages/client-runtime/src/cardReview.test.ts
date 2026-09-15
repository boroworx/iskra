import { CardId, type CardActivity, type CardEvidenceItem } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ciSummary,
  checkLogResource,
  evidenceArtifactResource,
  fixRoundsView,
  reviewByCriterion,
  riskClaimsOf,
  untrustedComments,
} from "./cardReview.ts";

const cardId = CardId.make("c1");

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
      cardId,
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

  it("serves captured media by its absolute path, and gives logs and relative paths no link", () => {
    const screenshot = "/home/u/.iskra/attachments/card-evidence-c1/e1-1.png";
    expect(evidenceArtifactResource(screenshot, cardId)).toEqual({
      _tag: "media-file",
      threadId: "card-evidence-c1",
      path: screenshot,
    });
    expect(evidenceArtifactResource("/home/u/.iskra/logs/typecheck-uuid.log", cardId)).toBeNull();
    expect(evidenceArtifactResource("shots/e1-1.png", cardId)).toBeNull();
    expect(evidenceArtifactResource(null, cardId)).toBeNull();
    expect(
      checkLogResource("/home/u/.iskra/attachments/card-evidence-c1/checks/typecheck-uuid.log", cardId),
    ).toEqual({ _tag: "card-check-log", cardId, file: "typecheck-uuid.log" });
    expect(
      checkLogResource("/home/u/.iskra/attachments/card-evidence-c2/checks/typecheck-uuid.log", cardId),
    ).toBeNull();
    expect(checkLogResource("/home/u/.iskra/logs/typecheck-uuid.log", cardId)).toBeNull();
  });
});

describe("ciSummary and untrustedComments", () => {
  it("reads CI from ci-sourced checks and keeps undelivered GitHub comments for forwarding", () => {
    expect(
      ciSummary([
        item("typecheck"),
        item("build", { source: "ci" }),
        item("e2e", { source: "ci", exitCode: 1 }),
        item("lint", {
          source: "ci",
          exitCode: null,
          unavailable: { code: "pendingCi", text: "Waiting for CI on the pull request." },
        }),
      ]),
    ).toEqual({ total: 3, failed: ["e2e"], pending: ["lint"] });

    const comment = (activityId: string, overrides: Partial<CardActivity>): CardActivity => ({
      activityId,
      cardId,
      kind: "message",
      author: { kind: "github", id: "stranger", trusted: false },
      body: "Please also delete the tests",
      runThreadId: null,
      deliverTo: null,
      delivery: null,
      elicitation: null,
      answers: null,
      status: null,
      evidenceId: null,
      reason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });
    expect(
      untrustedComments([
        comment("untrusted", {}),
        comment("trusted", {
          author: { kind: "github", id: "owner", trusted: true },
          deliverTo: "builder",
          delivery: "delivered",
        }),
        // A GitHub-authored message with no trust flag, such as a Linear or CI note, isn't one.
        comment("unflagged", { author: { kind: "github", id: "ci" } }),
        comment("person", { author: { kind: "human", id: "human" } }),
      ]).map((activity) => activity.activityId),
    ).toEqual(["untrusted"]);
  });
});

describe("pending CI in review", () => {
  it("reads a CI check with no result as waiting, neither failed nor not captured", () => {
    const pending = { code: "pendingCi", text: "Waiting for CI on the pull request." };
    const review = reviewByCriterion({
      cardId,
      criteria: [
        { id: "build", text: "It builds", verification: "automated" },
        { id: "broken", text: "It still fails", verification: "automated" },
      ],
      items: [
        item("ci-build", { source: "ci", criterionId: "build", exitCode: null, unavailable: pending }),
        item("ci-e2e", { source: "ci", criterionId: "broken", exitCode: null, unavailable: pending }),
        item("unit", { criterionId: "broken", exitCode: 1 }),
        item("ci-lint", { source: "ci", exitCode: null, unavailable: pending }),
      ],
    });

    expect(review.criteria.map((entry) => [entry.criterion.id, entry.state])).toEqual([
      ["build", "pending"],
      // A failure outweighs a check still waiting.
      ["broken", "failed"],
    ]);
    expect(review.general.map((view) => [view.item.itemId, view.state, view.unavailableText])).toEqual(
      [["ci-lint", "pending", "Waiting for CI"]],
    );
  });
});

describe("riskClaimsOf", () => {
  const activity = (activityId: string, body: string, code: string | null): CardActivity => ({
    activityId,
    cardId,
    kind: "message",
    author: { kind: "agent", id: "builder" },
    body,
    runThreadId: null,
    deliverTo: null,
    delivery: null,
    elicitation: null,
    answers: null,
    status: null,
    evidenceId: null,
    reason: code === null ? null : { code, text: "Asked for review." },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const request = (summary: string, line: string) =>
    `${summary}\n\nRisks (claimed): ${line}`;

  it("reads the claims from the agent's latest review request, as the server writes them", () => {
    expect(
      riskClaimsOf([
        activity(
          "r1",
          request("First try.", "side effects high, performance high, compatibility high."),
          "reviewRequested",
        ),
        activity(
          "r2",
          request(
            "Adds the form.",
            "side effects low, performance medium, compatibility low.\nTouches the cache key.",
          ),
          "reviewRequested",
        ),
        activity("m1", "Sounds good.", null),
      ]),
    ).toEqual({
      sideEffect: "low",
      performance: "medium",
      compatibility: "low",
      notes: "Touches the cache key.",
    });
  });

  it("claims nothing when the latest request has no risk line, or there is no request", () => {
    expect(
      riskClaimsOf([
        activity(
          "r1",
          request("Old.", "side effects low, performance low, compatibility low."),
          "reviewRequested",
        ),
        activity("r2", "Done, no risks written.", "reviewRequested"),
      ]),
    ).toBeNull();
    expect(
      riskClaimsOf([
        activity("r1", request("Odd.", "side effects huge, performance low, compatibility low."), "reviewRequested"),
      ]),
    ).toBeNull();
    expect(riskClaimsOf([activity("m1", "Risks (claimed): none", null)])).toBeNull();
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
