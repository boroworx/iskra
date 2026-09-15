import { describe, expect, it } from "@effect/vitest";
import { CardId, EventId, type CardPlanChild, type OrchestrationEvent } from "@iskra/contracts";

import {
  DIGEST_MAX_LINES,
  PLAN_DUPLICATE_KEY_REASON,
  PLAN_EMPTY_REASON,
  PLAN_SLICE_ORDER_REASON,
  digestFor,
  migrationBatch,
  migrationPhaseAllowed,
  migrationSample,
  nextSliceRelease,
  planCycleReason,
  planIntegrationBranch,
  planRefusal,
  planUnknownDependencyReason,
} from "./planRules.ts";

const child = (key: string, dependsOn: ReadonlyArray<string> = [], slice = 1): CardPlanChild => ({
  key,
  title: `Child ${key}`,
  spec: "",
  criteria: [{ id: "done", text: "It works.", verification: "automated" }],
  suggestedAgent: null,
  dependsOn,
  slice,
});

describe("planRefusal", () => {
  it.each([
    ["no children", [], PLAN_EMPTY_REASON],
    ["a child without criteria", [{ ...child("c1"), criteria: [] }], PLAN_EMPTY_REASON],
    ["two children with one key", [child("c1"), child("c1")], PLAN_DUPLICATE_KEY_REASON],
    ["a dependency outside the plan", [child("c1", ["c9"])], planUnknownDependencyReason("c1", "c9")],
    ["an earlier slice depending on a later one", [child("c1", ["c2"], 1), child("c2", [], 2)], PLAN_SLICE_ORDER_REASON],
    ["a cycle", [child("c1", ["c2"]), child("c2", ["c1"])], planCycleReason("c2", "c1")],
    ["a longer cycle", [child("a", ["b"]), child("b", ["c"]), child("c", ["a"])], planCycleReason("c", "a")],
  ] as const)("refuses %s", (_name, children, reason) => {
    expect(planRefusal(children)).toBe(reason);
  });

  it("accepts a DAG across slices", () => {
    expect(planRefusal([child("c1"), child("c2", ["c1"]), child("c3", ["c1", "c2"], 2)])).toBeNull();
  });
});

describe("nextSliceRelease", () => {
  const plan = {
    state: "approved" as const,
    currentSlice: 1,
    children: [child("c1"), child("c2", ["c1"]), child("c3", [], 3)],
  };

  it("releases the next slice present once every child up to the current one finished", () => {
    expect(
      nextSliceRelease(plan, [
        { slice: 1, status: "landed" },
        { slice: 1, status: "abandoned" },
        { slice: 3, status: "ready" },
      ]),
    ).toBe(3);
  });

  it("waits while a current child runs, before approval, and after the last slice", () => {
    expect(nextSliceRelease(plan, [{ slice: 1, status: "inReview" }])).toBeNull();
    expect(nextSliceRelease({ ...plan, state: "proposed" }, [])).toBeNull();
    expect(nextSliceRelease({ ...plan, currentSlice: 3 }, [])).toBeNull();
  });
});

describe("digestFor", () => {
  const children = [
    { id: CardId.make("card-c1"), planKey: "c1", title: "Health route" },
    { id: CardId.make("card-c2"), planKey: "c2", title: "Version route" },
  ];
  let sequence = 0;
  const event = (type: string, payload: object) =>
    ({
      sequence: (sequence += 1),
      eventId: EventId.make(`event-${sequence}`),
      aggregateKind: "card",
      aggregateId: "card-c1",
      occurredAt: "2026-03-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    }) as unknown as OrchestrationEvent;
  const status = (cardId: string, to: string) =>
    event("card.status-changed", { cardId, from: "ready", to, move: "workStarted", updatedAt: "2026-03-01T00:00:00.000Z" });

  it("coalesces each child to one line with its latest status and notes", () => {
    expect(
      digestFor(
        [
          status("card-c1", "inProgress"),
          status("card-c1", "inReview"),
          event("card.paused", {
            cardId: "card-c1",
            reason: { code: "fixRoundsExhausted", text: "Out of rounds." },
            by: "system",
            pausedAt: "2026-03-01T00:00:00.000Z",
          }),
          status("card-c2", "landed"),
          status("card-other", "landed"),
        ],
        children,
      ),
    ).toBe('- c1 "Health route": inReview; used up its fix rounds\n- c2 "Version route": landed');
  });

  it("says nothing when nothing a coordinator acts on happened, and caps long digests", () => {
    expect(digestFor([], children)).toBeNull();
    const many = Array.from({ length: 50 }, (_, index) => ({
      id: CardId.make(`card-${index}`),
      planKey: `c${index}`,
      title: "Item",
    }));
    const digest = digestFor(
      many.map((entry) => status(entry.id, "landed")),
      many,
    );
    expect(digest?.split("\n")).toHaveLength(DIGEST_MAX_LINES);
    expect(digest?.split("\n").at(-1)).toBe("…and 11 more children changed.");
  });
});

describe("migrations", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map((key, index) => ({
    key,
    childCardId: null,
    state: index === 0 ? ("running" as const) : ("pending" as const),
  }));

  it("starts only as many pending items as the capacity has room for", () => {
    expect(migrationBatch(items, 3)).toEqual(["b", "c"]);
    expect(migrationBatch(items, 1)).toEqual([]);
  });

  it("samples pending items spread across the list", () => {
    expect(migrationSample(items, 3)).toEqual(["b", "c", "e"]);
    expect(migrationSample(items.slice(0, 2), 3)).toEqual(["b"]);
  });

  it("moves through phases one at a time", () => {
    expect(migrationPhaseAllowed("enumerating", "sampling")).toBe(true);
    expect(migrationPhaseAllowed("sampling", "sweeping")).toBe(false);
    expect(migrationPhaseAllowed("tuning", "sampling")).toBe(false);
  });
});

it("names a plan's integration branch from its title and id", () => {
  expect(planIntegrationBranch({ id: CardId.make("5f2c1d8e-aaaa"), title: "Add /health and /version!" })).toBe(
    "iskra/plan-add-health-and-version-5f2c1d8e",
  );
});
