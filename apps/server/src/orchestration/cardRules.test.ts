import {
  CARD_PLAN_DRAFTING,
  CARD_VERIFICATION_OFF,
  CardId,
  type CardMove,
  type CardStatus,
  type OrchestrationCard,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_MERGE_OFF_REASON,
  AUTO_MERGE_NEEDS_VERIFIED_REASON,
  TRIGGER_WORK_WAITS_REASON,
  autoMergeSatisfactionReason,
  BLOCKED_REASON,
  NO_CHECKS_REASON,
  PENDING_CI_REASON,
  PLAN_CHILD_LANDING_REASON,
  REVIEW_EVIDENCE_REASON,
  UNACKNOWLEDGED_FLAGS_REASON,
  VERIFIER_NOT_PASSED_REASON,
  WORK_CRITERIA_REASON,
  cardActivitiesOf,
  criteriaRefusal,
  elicitationRefusal,
  evidencePassed,
  fixRoundRefusal,
  landingBeginRefusal,
  reviewEntryRefusal,
  canChangeDelegate,
  cardBudgetRefusal,
  cardFactsOf,
  inverseRelationKind,
  nextCardStatus,
  withRelation,
  withoutRelation,
  type CardFacts,
} from "./cardRules.ts";

const STATUSES: ReadonlyArray<CardStatus> = [
  "triage",
  "ready",
  "inProgress",
  "inReview",
  "landing",
  "landed",
  "abandoned",
];

const facts = (status: CardStatus, overrides: Partial<CardFacts> = {}): CardFacts => ({
  status,
  delegateAgentId: "agent-backend",
  openChildCount: 0,
  openBlockerCount: 0,
  criteriaConfirmed: true,
  unacknowledgedHardFlags: false,
  pendingCiChecks: false,
  ...overrides,
});

/** For each move, the statuses it is allowed from and where each goes; everything else is rejected. */
const ALLOWED: ReadonlyArray<readonly [CardMove, Partial<Record<CardStatus, CardStatus>>]> = [
  ["approve", { triage: "ready" }],
  ["unapprove", { ready: "triage" }],
  ["workStarted", { ready: "inProgress" }],
  ["requestReview", { inProgress: "inReview" }],
  ["returnToWork", { inReview: "inProgress", landing: "inProgress" }],
  ["approveMerge", { inReview: "landing" }],
  ["beginLanding", { inReview: "landing" }],
  ["cancelLanding", { landing: "inReview" }],
  ["landed", { landing: "landed" }],
  ["mergedOnHost", { inReview: "landed", landing: "landed" }],
  [
    "abandon",
    {
      triage: "abandoned",
      ready: "abandoned",
      inProgress: "abandoned",
      inReview: "abandoned",
      landing: "abandoned",
    },
  ],
  ["reopen", { abandoned: "triage" }],
];

describe("nextCardStatus", () => {
  for (const [move, allowed] of ALLOWED) {
    it(`moves ${move} only from ${Object.keys(allowed).join(", ")}`, () => {
      for (const status of STATUSES) {
        const expected = allowed[status];
        const result = nextCardStatus(facts(status), move);
        expect(result.ok ? result.status : null).toBe(expected ?? null);
      }
    });
  }

  it("does not start work without a delegate", () => {
    expect(nextCardStatus(facts("ready", { delegateAgentId: null }), "workStarted")).toEqual({
      ok: false,
      reason: "Assign an agent before work starts.",
    });
  });

  it("holds a merge while a sub-card or a blocker is still open", () => {
    expect(nextCardStatus(facts("inReview", { openChildCount: 1 }), "approveMerge")).toEqual({
      ok: false,
      reason: "Land or abandon its sub-cards first.",
    });
    expect(nextCardStatus(facts("inReview", { openBlockerCount: 1 }), "approveMerge")).toEqual({
      ok: false,
      reason: "It is blocked by a card that has not landed.",
    });
  });
});

describe("canChangeDelegate", () => {
  it("allows a change on approved, unfinished work with no live session", () => {
    for (const status of ["ready", "inProgress", "inReview", "landing"] as const) {
      expect(canChangeDelegate({ status }, false)).toEqual({ ok: true });
    }
  });

  it("refuses in triage, during a live write session, and once finished", () => {
    expect(canChangeDelegate({ status: "triage" }, false).ok).toBe(false);
    expect(canChangeDelegate({ status: "inProgress" }, true).ok).toBe(false);
    expect(canChangeDelegate({ status: "landed" }, false).ok).toBe(false);
    expect(canChangeDelegate({ status: "abandoned" }, false).ok).toBe(false);
  });
});

describe("cardFactsOf", () => {
  const card = (id: string, overrides: Partial<OrchestrationCard> = {}) =>
    ({
      id: CardId.make(id),
      status: "inReview",
      delegateAgentId: null,
      parentCardId: null,
      relations: [],
      acceptance: { criteria: [], state: "confirmed" },
      evidence: null,
      ...overrides,
    }) as OrchestrationCard;

  it("counts unfinished sub-cards and blockers that have not landed", () => {
    const parent = card("parent", {
      relations: [
        { kind: "blockedBy", cardId: CardId.make("landed-blocker") },
        { kind: "blockedBy", cardId: CardId.make("open-blocker") },
        { kind: "related", cardId: CardId.make("open-blocker") },
      ],
    });
    const cards = [
      parent,
      card("open-child", { parentCardId: parent.id, status: "inProgress" }),
      card("done-child", { parentCardId: parent.id, status: "abandoned" }),
      card("landed-blocker", { status: "landed" }),
      card("open-blocker", { status: "ready" }),
    ];

    expect(cardFactsOf(cards, parent)).toMatchObject({ openChildCount: 1, openBlockerCount: 1 });
  });
});

describe("relations", () => {
  const other = CardId.make("card-other");

  it("pairs blocks with blockedBy, mirrors related and overlaps, and keeps duplicateOf one-way", () => {
    expect(inverseRelationKind("blocks")).toBe("blockedBy");
    expect(inverseRelationKind("blockedBy")).toBe("blocks");
    expect(inverseRelationKind("related")).toBe("related");
    expect(inverseRelationKind("overlaps")).toBe("overlaps");
    expect(inverseRelationKind("duplicateOf")).toBeNull();
  });

  it("adds a relation once and removes it", () => {
    const added = withRelation(withRelation([], { kind: "blocks", cardId: other }), {
      kind: "blocks",
      cardId: other,
    });
    expect(added).toEqual([{ kind: "blocks", cardId: other }]);
    expect(withoutRelation(added, { kind: "blocks", cardId: other })).toEqual([]);
  });
});

describe("cardBudgetRefusal", () => {
  const budget = { spentUsd: 4, budgetCapUsd: 10, unpricedTurns: 0, acceptsUnpriced: false };

  it("lets turns start under the cap, and stops them at it", () => {
    expect(cardBudgetRefusal(budget)).toBeNull();
    expect(cardBudgetRefusal({ ...budget, spentUsd: 10 })).toBe(
      "The card has spent $10.00 of its $10.00 budget; raise the cap to continue.",
    );
  });

  it("holds an unpriced model until a person accepts running it uncapped", () => {
    expect(cardBudgetRefusal({ ...budget, unpricedTurns: 1 })).toContain("no known price");
    expect(cardBudgetRefusal({ ...budget, unpricedTurns: 1, acceptsUnpriced: true })).toBeNull();
  });
});

describe("card contract gates", () => {
  const evidence = {
    evidenceId: "evidence-1",
    headSha: "abc123",
    purpose: "review" as const,
    passed: true,
    checkCount: 2,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  const policy = {
    checksWaived: false,
    ciFixRounds: 2,
    reviewFixRounds: 1,
    autoMerge: { enabled: false, minSatisfaction: 0.9 },
  };

  it("starts work only on confirmed criteria and no open blocker, and merges only acknowledged flags", () => {
    expect(nextCardStatus(facts("ready", { criteriaConfirmed: false }), "workStarted")).toEqual({
      ok: false,
      reason: WORK_CRITERIA_REASON,
    });
    expect(nextCardStatus(facts("ready", { openBlockerCount: 1 }), "workStarted")).toEqual({
      ok: false,
      reason: BLOCKED_REASON,
    });
    for (const move of ["approveMerge", "beginLanding"] as const) {
      expect(nextCardStatus(facts("inReview", { unacknowledgedHardFlags: true }), move)).toEqual({
        ok: false,
        reason: UNACKNOWLEDGED_FLAGS_REASON,
      });
      expect(nextCardStatus(facts("inReview", { pendingCiChecks: true }), move)).toEqual({
        ok: false,
        reason: PENDING_CI_REASON,
      });
    }
  });

  it("passes evidence only when every check exited 0 in time, whatever the captures", () => {
    const check = { kind: "check" as const, exitCode: 0, timedOut: false };
    const capture = { kind: "screenshot" as const, exitCode: null, timedOut: false };
    expect(evidencePassed([check, capture])).toBe(true);
    // A CI check that hasn't reported holds the merge, not review.
    expect(
      evidencePassed([check, { ...check, exitCode: null, unavailable: { code: "pendingCi" } }]),
    ).toBe(true);
    expect(evidencePassed([check, { ...check, exitCode: 1 }])).toBe(false);
    expect(evidencePassed([{ ...check, timedOut: true }])).toBe(false);
    expect(evidencePassed([check, { ...check, exitCode: null }])).toBe(false);
  });

  it("enters review only on passing evidence for the commit, with checks or a waiver", () => {
    expect(reviewEntryRefusal({ evidence }, policy, "abc123")).toBeNull();
    expect(reviewEntryRefusal({ evidence: null }, policy, "abc123")).toBe(REVIEW_EVIDENCE_REASON);
    expect(reviewEntryRefusal({ evidence }, policy, "def456")).toBe(REVIEW_EVIDENCE_REASON);
    expect(reviewEntryRefusal({ evidence: { ...evidence, passed: false } }, policy, "abc123")).toBe(
      REVIEW_EVIDENCE_REASON,
    );
    expect(
      reviewEntryRefusal({ evidence: { ...evidence, purpose: "checkpoint" } }, policy, "abc123"),
    ).toBe(REVIEW_EVIDENCE_REASON);
    const unchecked = { evidence: { ...evidence, checkCount: 0 } };
    expect(reviewEntryRefusal(unchecked, policy, "abc123")).toBe(NO_CHECKS_REASON);
    expect(reviewEntryRefusal(unchecked, { checksWaived: true }, "abc123")).toBeNull();
  });

  it("counts CI and review rounds apart against the project's caps", () => {
    expect(fixRoundRefusal({ fixRounds: { ci: 1, review: 0 } }, policy, "ci")).toBeNull();
    expect(fixRoundRefusal({ fixRounds: { ci: 2, review: 0 } }, policy, "ci")).toBe(
      "The card used its 2 CI fix rounds; a person can give it more.",
    );
    expect(fixRoundRefusal({ fixRounds: { ci: 2, review: 0 } }, policy, "review")).toBeNull();
    expect(fixRoundRefusal({ fixRounds: { ci: 0, review: 1 } }, policy, "review")).toContain(
      "1 review fix rounds",
    );
  });

  it("lands without a person only a plan child into its plan's branch, or under auto-merge", () => {
    const plan = { kind: "plan" as const, branch: "iskra/plan-limits", plan: null };
    const child = {
      evidence,
      baseBranch: "iskra/plan-limits",
      verification: CARD_VERIFICATION_OFF,
      attemptGroupId: null,
      unattended: false,
      createdBy: { kind: "human" as const, id: "human" },
    };
    const begin = (overrides: Partial<Parameters<typeof landingBeginRefusal>[0]>) =>
      landingBeginRefusal({
        card: child,
        parent: plan,
        policy,
        reason: "planChild",
        verificationRequired: false,
        ...overrides,
      });
    // A required verifier holds both until it passed the latest commit, or a person overrode it.
    expect(begin({ verificationRequired: true })).toBe(VERIFIER_NOT_PASSED_REASON);
    const verified = (state: "passed" | "overridden", headSha: string) => ({
      ...child,
      verification: { ...CARD_VERIFICATION_OFF, state, headSha },
    });
    expect(begin({ verificationRequired: true, card: verified("passed", "abc123") })).toBeNull();
    expect(begin({ verificationRequired: true, card: verified("passed", "old") })).toBe(
      VERIFIER_NOT_PASSED_REASON,
    );
    expect(begin({ verificationRequired: true, card: verified("overridden", "old") })).toBeNull();
    expect(begin({})).toBeNull();
    expect(begin({ parent: undefined })).toBe(PLAN_CHILD_LANDING_REASON);
    expect(begin({ parent: { kind: "task", branch: plan.branch, plan: null } })).toBe(
      PLAN_CHILD_LANDING_REASON,
    );
    expect(begin({ card: { ...child, baseBranch: "main" } })).toBe(PLAN_CHILD_LANDING_REASON);
    expect(begin({ card: { ...child, evidence: { ...evidence, passed: false } } })).toBe(
      PLAN_CHILD_LANDING_REASON,
    );
    expect(begin({ reason: "autoMergePolicy" })).toBe(AUTO_MERGE_OFF_REASON);
    // A plan's children may also land into the integration branch the plan named at approval.
    expect(
      begin({ parent: { kind: "plan", branch: null, plan: { ...CARD_PLAN_DRAFTING, integrationBranch: plan.branch } } }),
    ).toBeNull();
  });

  it("auto-merges only verified, attended work whose hidden scenarios held", () => {
    const autoMerge = (
      card: Partial<Parameters<typeof landingBeginRefusal>[0]["card"]>,
      minSatisfaction = 0.9,
    ) =>
      landingBeginRefusal({
        card: {
          evidence,
          baseBranch: null,
          verification: CARD_VERIFICATION_OFF,
          attemptGroupId: null,
          unattended: false,
          createdBy: { kind: "human", id: "human" },
          ...card,
        },
        parent: undefined,
        policy: { ...policy, autoMerge: { enabled: true, minSatisfaction } },
        reason: "autoMergePolicy",
        verificationRequired: false,
      });
    const passed = (satisfied: number, total: number, headSha = "abc123") => ({
      ...CARD_VERIFICATION_OFF,
      state: "passed" as const,
      headSha,
      satisfaction: total === 0 ? null : { satisfied, total },
    });
    expect(autoMerge({})).toBe(AUTO_MERGE_NEEDS_VERIFIED_REASON);
    expect(autoMerge({ verification: passed(0, 0) })).toBe(AUTO_MERGE_NEEDS_VERIFIED_REASON);
    expect(autoMerge({ verification: passed(1, 1, "old") })).toBe(AUTO_MERGE_NEEDS_VERIFIED_REASON);
    // An override lets a person merge, never auto-merge.
    expect(
      autoMerge({ verification: { ...passed(1, 1), state: "overridden" } }),
    ).toBe(AUTO_MERGE_NEEDS_VERIFIED_REASON);
    expect(autoMerge({ verification: passed(1, 1) })).toBeNull();
    expect(autoMerge({ verification: passed(1, 2) })).toBe(autoMergeSatisfactionReason(1, 2, 90));
    expect(autoMerge({ verification: passed(1, 2) }, 0.5)).toBeNull();
    expect(autoMerge({ verification: passed(1, 1), unattended: true })).toBe(
      TRIGGER_WORK_WAITS_REASON,
    );
    expect(
      autoMerge({ verification: passed(1, 1), origin: { kind: "trigger", id: "nightly" } }),
    ).toBe(TRIGGER_WORK_WAITS_REASON);
  });

  it("refuses criteria and questions that can't be held to", () => {
    expect(criteriaRefusal([{ id: "a" }, { id: "b" }])).toBeNull();
    expect(criteriaRefusal([])).toBe("Add at least one acceptance criterion.");
    expect(criteriaRefusal([{ id: "a" }, { id: "a" }])).toContain("its own id");
    const options = [{ id: "a" }, { id: "b" }];
    expect(elicitationRefusal({ options, recommendedOptionId: "a" })).toBeNull();
    expect(elicitationRefusal({ options: [{ id: "a" }], recommendedOptionId: null })).toContain(
      "two or three",
    );
    expect(elicitationRefusal({ options, recommendedOptionId: "c" })).toContain("recommended");
  });

  it("maps legacy card messages, decisions and status moves into activities as migration 070 did", () => {
    const base = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "card",
      aggregateId: CardId.make("card-1"),
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;
    const [message] = cardActivitiesOf({
      ...base,
      type: "card.message-posted",
      payload: {
        cardId: CardId.make("card-1"),
        messageId: "message-1",
        authorKind: "human",
        authorId: "human",
        body: "Also cap bursts.",
        runThreadId: null,
        forOwner: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as OrchestrationEvent);
    expect(message).toMatchObject({
      activityId: "message-1",
      kind: "message",
      deliverTo: "builder",
      delivery: "pending",
    });
    const [decision] = cardActivitiesOf({
      ...base,
      type: "card.decision-recorded",
      payload: {
        cardId: CardId.make("card-1"),
        decisionId: "decision-1",
        author: { kind: "lead", id: "agent-lead" },
        text: "Asked for.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as OrchestrationEvent);
    expect(decision).toMatchObject({ kind: "decision", author: { kind: "agent", id: "agent-lead" } });
    const [status] = cardActivitiesOf({
      ...base,
      type: "card.status-changed",
      payload: {
        cardId: CardId.make("card-1"),
        from: "inReview",
        to: "inProgress",
        move: "returnToWork",
        reason: "Checks failed.",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    } as OrchestrationEvent);
    expect(status).toMatchObject({
      activityId: "status:event-1",
      author: { kind: "system", id: "system" },
      body: "",
      status: { from: "inReview", to: "inProgress" },
      reason: { code: "returnToWork", text: "Checks failed." },
    });
  });
});
