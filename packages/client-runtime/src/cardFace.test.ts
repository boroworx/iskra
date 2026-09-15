import {
  AgentId,
  CARD_VERIFICATION_OFF,
  CardId,
  LEGACY_CARD_CONTRACT,
  ProjectId,
  ThreadId,
  type OrchestrationCardShell,
} from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cardShortId,
  cardSparkState,
  cardStatusPill,
  criteriaMarks,
  markOfCriterionState,
  outcomePill,
  wikiAuthorLabel,
} from "./cardFace.ts";

const at = "2026-01-01T00:00:00.000Z";

const card = (overrides: Partial<OrchestrationCardShell> = {}): OrchestrationCardShell => ({
  id: CardId.make("c1"),
  projectId: ProjectId.make("p1"),
  channelId: null,
  parentCardId: null,
  title: "Card",
  spec: "",
  specState: "approved",
  tags: [],
  status: "inProgress",
  ownerHumanId: "human",
  baseBranch: null,
  branch: null,
  worktreePath: null,
  portBase: null,
  relations: [],
  createdBy: { kind: "human", id: "human" },
  createdAt: at,
  updatedAt: at,
  snoozedUntil: null,
  snoozedAt: null,
  activityAt: at,
  diffStat: null,
  checks: null,
  spentUsd: 0,
  budgetCapUsd: 10,
  unpricedTurns: 0,
  acceptsUnpriced: false,
  reviewReturns: 0,
  attemptGroupId: null,
  linearIssue: null,
  sourceMessageId: null,
  proposalReasoning: null,
  suggestedAgentId: null,
  priority: 0,
  ...LEGACY_CARD_CONTRACT,
  delegateAgentId: AgentId.make("agent"),
  acceptance: {
    state: "confirmed",
    criteria: [
      { id: "a", text: "Automated", verification: "automated" },
      { id: "m", text: "Manual", verification: "manual" },
    ],
  },
  ownerSession: null,
  ...overrides,
});

const verification = (state: OrchestrationCardShell["verification"]["state"]) => ({
  ...CARD_VERIFICATION_OFF,
  state,
});

describe("card face", () => {
  it("colors the pill by meaning: orange waits on a person, blue works, green landed, red failed", () => {
    expect(cardStatusPill(card({ status: "triage" }))).toEqual({ label: "Proposed", tone: "orange" });
    expect(cardStatusPill(card({ status: "ready" }))).toEqual({ label: "Queued", tone: "gray" });
    expect(cardStatusPill(card())).toEqual({ label: "In Progress", tone: "blue" });
    expect(cardStatusPill(card({ status: "inReview" }))).toEqual({ label: "In Review", tone: "orange" });
    expect(
      cardStatusPill(card({ status: "inReview", verification: verification("running") })),
    ).toEqual({ label: "Verifying", tone: "blue" });
    expect(cardStatusPill(card({ status: "landed" }))).toEqual({ label: "Landed", tone: "green" });
    const paused = (code: string) => ({
      by: "system" as const,
      reason: { code, text: "" },
      pausedAt: at,
    });
    expect(cardStatusPill(card({ paused: paused("sessionFailed") })).tone).toBe("red");
    expect(cardStatusPill(card({ paused: paused("stuck") }))).toEqual({ label: "Paused", tone: "gray" });
  });

  it("sparks for work, for a person, and for a landing", () => {
    expect(cardSparkState(card())).toBe("idle");
    expect(
      cardSparkState(
        card({
          ownerSession: {
            threadId: ThreadId.make("owner"),
            agentId: AgentId.make("agent"),
            state: "active",
            since: at,
            planProgress: null,
          },
        }),
      ),
    ).toBe("working");
    expect(cardSparkState(card({ status: "triage" }))).toBe("needsYou");
    expect(cardSparkState(card({ status: "inReview" }))).toBe("needsYou");
    expect(cardSparkState(card({ status: "inReview", verification: verification("running") }))).toBe(
      "working",
    );
    expect(cardSparkState(card({ status: "landed" }))).toBe("landed");
  });

  it("marks criteria passed only once something vouches for them, and manual ones for a person", () => {
    expect(criteriaMarks(card())).toEqual(["pending", "needsYou"]);
    expect(criteriaMarks(card({ status: "inReview", verification: verification("passed") }))).toEqual([
      "passed",
      "needsYou",
    ]);
    expect(criteriaMarks(card({ status: "inReview", verification: verification("failed") }))).toEqual([
      "pending",
      "needsYou",
    ]);
    expect(criteriaMarks(card({ status: "landed" }))).toEqual(["passed", "passed"]);
    expect(markOfCriterionState("coveredByChecks")).toBe("passed");
    expect(markOfCriterionState("failed")).toBe("failed");
    expect(markOfCriterionState("needsYourCheck")).toBe("needsYou");
  });
});

describe("outcomePill", () => {
  it("shows only a recorded outcome, never one inferred from landing", () => {
    expect(outcomePill(null)).toBeNull();
    expect(
      outcomePill({ state: "flawed", decidedAt: "2026-09-15T00:00:00.000Z", signals: [] }),
    ).toEqual({ label: "Flawed", tone: "red" });
  });
});

describe("cardShortId", () => {
  it("takes the first four letters or digits after any card- prefix, uppercased", () => {
    expect(cardShortId("7d20b1c4-0000-4000-8000-000000000000")).toBe("C-7D20");
    expect(cardShortId("card-5af2e9")).toBe("C-5AF2");
    expect(cardShortId("a-b-c-d-e")).toBe("C-ABCD");
  });

  it("hashes structured ids that share a prefix, so trigger cards don't all read C-TRIG", () => {
    const first = cardShortId("trigger:project-1:nightly:2026-09-14");
    const second = cardShortId("trigger:project-1:nightly:2026-09-15");
    expect(first).toMatch(/^C-[0-9A-F]{4}$/);
    expect(second).toMatch(/^C-[0-9A-F]{4}$/);
    expect(first).not.toBe(second);
    expect(cardShortId("trigger:project-1:nightly:2026-09-14")).toBe(first);
  });
});

describe("wikiAuthorLabel", () => {
  const name = (agentId: string) => (agentId === "agent-1" ? "builder1" : undefined);

  it("names the agent and the card it wrote from, and a person as you", () => {
    expect(
      wikiAuthorLabel({ kind: "agent", agentId: "agent-1", cardId: "card-af7f00" }, name),
    ).toBe("@builder1 on C-AF7F");
    // A lead writes from a channel, with no card; an archived agent falls back to its id.
    expect(wikiAuthorLabel({ kind: "agent", agentId: "agent-1", cardId: null }, name)).toBe(
      "@builder1",
    );
    expect(wikiAuthorLabel({ kind: "agent", agentId: "agent-9", cardId: null }, name)).toBe(
      "@agent-9",
    );
    expect(wikiAuthorLabel({ kind: "human", agentId: null, cardId: null }, name)).toBe("you");
  });
});
