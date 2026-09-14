import { CardId, ProjectId, type CardStatus, type OrchestrationCard } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_COLUMNS,
  cardDropDecision,
  isCardSnoozed,
  needsYouItems,
  waitingLabel,
} from "./cards.ts";

const projectId = ProjectId.make("project-board");
// Minutes past midnight on 2026-01-01, as an ISO timestamp.
const at = (minute: number) =>
  `2026-01-01T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;

const card = (id: string, overrides: Partial<OrchestrationCard> = {}): OrchestrationCard => ({
  id: CardId.make(id),
  projectId,
  channelId: null,
  parentCardId: null,
  title: `Card ${id}`,
  spec: "",
  specState: "draft",
  tags: [],
  status: "ready",
  ownerHumanId: "human",
  delegateAgentId: null,
  baseBranch: null,
  branch: null,
  worktreePath: null,
  portBase: null,
  relations: [],
  createdBy: { kind: "human", id: "human" },
  createdAt: at(0),
  updatedAt: at(0),
  snoozedUntil: null,
  snoozedAt: null,
  activityAt: at(0),
  diffStat: null,
  ...overrides,
});

describe("cardDropDecision", () => {
  it("turns only the human decisions into commands, and snaps every other drop back with a reason", () => {
    const decisions = (status: CardStatus) =>
      Object.fromEntries(
        BOARD_COLUMNS.map((column) => {
          const decision = cardDropDecision(status, column);
          return [column, decision.kind === "command" ? decision.type : decision.kind];
        }),
      );

    expect(decisions("triage")).toEqual({
      triage: "none",
      ready: "card.approve",
      inProgress: "refuse",
      inReview: "refuse",
      landing: "refuse",
      done: "card.abandon",
    });
    expect(decisions("ready")).toMatchObject({ triage: "card.unapprove", inProgress: "refuse" });
    expect(decisions("inProgress")).toMatchObject({ inReview: "refuse", done: "card.abandon" });
    expect(decisions("inReview")).toMatchObject({ landing: "card.merge.approve", ready: "refuse" });
    expect(decisions("landing")).toMatchObject({ inReview: "card.merge.cancel", done: "card.abandon" });
    expect(decisions("abandoned")).toMatchObject({ triage: "card.reopen", ready: "refuse", done: "none" });
    expect(decisions("landed")).toMatchObject({ triage: "refuse", done: "none" });

    expect(cardDropDecision("ready", "inProgress")).toEqual({
      kind: "refuse",
      reason: "Work starts when the card's agent starts its first session; assign an agent instead.",
    });
  });
});

describe("needsYouItems", () => {
  it("lists what waits on a person across projects, longest waiting first", () => {
    const items = needsYouItems({
      cards: [
        card("proposal", { status: "triage", createdAt: at(10) }),
        card("draft-spec", { spec: "Limit keys.", updatedAt: at(5) }),
        card("empty-spec"),
        card("approved-spec", { spec: "Done.", specState: "approved" }),
        card("asking", { status: "inProgress", specState: "approved" }),
        card("lost", { status: "inProgress", specState: "skipped" }),
        card("gone", { status: "abandoned", spec: "Old." }),
      ],
      sessions: [
        { cardId: CardId.make("asking"), state: "awaitingInput", since: at(1) },
        { cardId: CardId.make("lost"), state: "stale", since: at(20) },
        { cardId: CardId.make("approved-spec"), state: "active", since: at(2) },
      ],
      now: Date.parse(at(30)),
    });

    expect(items.map((item) => [item.kind, item.cardId])).toEqual([
      ["awaitingInput", "asking"],
      ["spec", "draft-spec"],
      ["triage", "proposal"],
      ["sessionFailed", "lost"],
    ]);
  });

  it("hides a snoozed card until its time passes or it has new activity, but never hides a question", () => {
    const snoozed = card("snoozed", {
      status: "triage",
      snoozedAt: at(10),
      snoozedUntil: at(60),
      activityAt: at(5),
    });
    const list = (cards: ReadonlyArray<OrchestrationCard>, now: number) =>
      needsYouItems({
        cards,
        sessions: [{ cardId: CardId.make("snoozed"), state: "awaitingInput", since: at(12) }],
        now,
      }).map((item) => item.kind);

    expect(list([snoozed], Date.parse(at(30)))).toEqual(["awaitingInput"]);
    expect(list([snoozed], Date.parse(at(61)))).toEqual(["triage", "awaitingInput"]);
    expect(list([{ ...snoozed, activityAt: at(20) }], Date.parse(at(30)))).toEqual([
      "triage",
      "awaitingInput",
    ]);

    const untilActivity = { ...snoozed, snoozedUntil: null };
    expect(isCardSnoozed(untilActivity, Date.parse("2026-01-08T00:00:00.000Z"))).toBe(true);
    expect(isCardSnoozed({ ...untilActivity, activityAt: at(11) }, Date.parse(at(30)))).toBe(false);
  });
});

describe("waitingLabel", () => {
  it("says how long at the coarsest unit", () => {
    const now = Date.parse(at(0)) + 3 * 24 * 60 * 60_000;
    expect(waitingLabel(at(0), Date.parse(at(4)))).toBe("4m");
    expect(waitingLabel(at(0), Date.parse(at(0)) + 3 * 60 * 60_000)).toBe("3h");
    expect(waitingLabel(at(0), now)).toBe("3d");
  });
});
