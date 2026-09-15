import { CardId } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { undoCommandOf } from "./undo.ts";

const cardId = CardId.make("card-1");
const otherCardId = CardId.make("card-2");

describe("undoCommandOf", () => {
  it("reverses each command a toast offers to undo", () => {
    expect(undoCommandOf({ type: "card.pause", cardId })).toEqual({ type: "card.resume", cardId });
    expect(undoCommandOf({ type: "card.abandon", cardId })).toEqual({ type: "card.reopen", cardId });
    expect(undoCommandOf({ type: "card.unapprove", cardId })).toEqual({ type: "card.approve", cardId });
    expect(undoCommandOf({ type: "card.snooze", cardId })).toEqual({ type: "card.unsnooze", cardId });
    expect(
      undoCommandOf({ type: "card.relation.add", cardId, kind: "blockedBy", otherCardId }),
    ).toEqual({ type: "card.relation.remove", cardId, kind: "blockedBy", otherCardId });
  });

  it("offers nothing for a dismissed lesson", () => {
    expect(undoCommandOf({ type: "project.knowledge.dismiss" })).toBeNull();
  });
});
