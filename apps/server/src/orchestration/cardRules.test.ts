import { CardId, type CardMove, type CardStatus, type OrchestrationCard } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canChangeDelegate,
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
  ["cancelLanding", { landing: "inReview" }],
  ["landed", { landing: "landed" }],
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
