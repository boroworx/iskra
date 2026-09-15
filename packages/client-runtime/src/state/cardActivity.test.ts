import { CardId, type CardActivity } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_CARD_ACTIVITY, applyCardStreamItem } from "./cardActivity.ts";

const activity = (activityId: string, body = activityId): CardActivity => ({
  activityId,
  cardId: CardId.make("card"),
  kind: "message",
  author: { kind: "human", id: "human" },
  body,
  runThreadId: null,
  deliverTo: "builder",
  delivery: "pending",
  elicitation: null,
  answers: null,
  status: null,
  evidenceId: null,
  reason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("applyCardStreamItem", () => {
  it("keeps one copy of an activity from the snapshot and live, and follows its delivery", () => {
    const state = [
      { kind: "snapshot", activities: [activity("a"), activity("b")], evidence: null },
      { kind: "activity", activity: activity("b", "b again") },
      { kind: "activity", activity: activity("c") },
      { kind: "delivery", activityId: "a", delivery: "delivered" },
      { kind: "evidence", evidenceId: "e1", items: [] },
    ].reduce(
      (current, item) =>
        applyCardStreamItem(current, item as Parameters<typeof applyCardStreamItem>[1]),
      EMPTY_CARD_ACTIVITY,
    );

    expect(state.activities.map((entry) => [entry.activityId, entry.body, entry.delivery])).toEqual(
      [
        ["a", "a", "delivered"],
        ["b", "b again", "pending"],
        ["c", "c", "pending"],
      ],
    );
    expect(state.evidence).toEqual({ evidenceId: "e1", items: [] });
  });

  it("puts older pages before the live activities, in fetch order, and follows hasMore", () => {
    type Item = Parameters<typeof applyCardStreamItem>[1];
    const live = [
      { kind: "snapshot", activities: [activity("c"), activity("d")], evidence: null, hasMore: true },
      { kind: "activity", activity: activity("e") },
    ].reduce((current, item) => applyCardStreamItem(current, item as Item), EMPTY_CARD_ACTIVITY);
    expect(live.hasMore).toBe(true);

    // The first page overlaps the live state by one activity; it is kept once.
    const firstPage = applyCardStreamItem(live, {
      kind: "page",
      activities: [activity("b"), activity("c")],
      hasMore: true,
    });
    const secondPage = applyCardStreamItem(firstPage, {
      kind: "page",
      activities: [activity("a")],
      hasMore: false,
    });

    expect(secondPage.activities.map((entry) => entry.activityId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(secondPage.hasMore).toBe(false);
    // A resubscription's snapshot starts clean; held pages are applied again over it.
    const resubscribed = applyCardStreamItem(secondPage, {
      kind: "snapshot",
      activities: [activity("d"), activity("e")],
      evidence: null,
    });
    expect(resubscribed).toMatchObject({ hasMore: false });
    expect(resubscribed.activities.map((entry) => entry.activityId)).toEqual(["d", "e"]);
  });
});
