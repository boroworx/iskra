import { AgentId, CardId, type CardPlanChild, type OrchestrationCard } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { migrationCounts, planDraftLine, planSlices } from "./planView.ts";

const planId = CardId.make("plan");
const child = (key: string, slice: number, dependsOn: string[] = []): CardPlanChild => ({
  key,
  title: `Title ${key}`,
  spec: "",
  criteria: [],
  suggestedAgent: null,
  dependsOn,
  slice,
});
const childCard = (key: string, overrides: Partial<OrchestrationCard> = {}) => ({
  id: CardId.make(`card-${key}`),
  parentCardId: planId,
  planKey: key,
  status: "ready" as OrchestrationCard["status"],
  delegateAgentId: AgentId.make("builder"),
  heldByCheckpoint: false,
  relations: [] as OrchestrationCard["relations"],
  ...overrides,
});

describe("planSlices", () => {
  const plan = { children: [child("c3", 2), child("c1", 1), child("c2", 1, ["c1"])] };

  it("groups a proposed plan's children by slice, with dependencies by title", () => {
    const slices = planSlices(planId, plan, []);
    expect(
      slices.map((slice) => [slice.slice, slice.children.map((view) => view.child.key)]),
    ).toEqual([
      [1, ["c1", "c2"]],
      [2, ["c3"]],
    ]);
    expect(slices[0]!.children[1]!.dependsOnTitles).toEqual(["Title c1"]);
    expect(slices.flatMap((slice) => slice.children.map((view) => view.state))).toEqual([
      "proposed",
      "proposed",
      "proposed",
    ]);
  });

  it("follows each child's card once approved: landed, blocked by an open card, held", () => {
    const c1 = childCard("c1", { status: "landed" });
    const c2 = childCard("c2", {
      relations: [{ kind: "blockedBy", cardId: CardId.make("card-c4") }],
    });
    const c4 = childCard("c4", { parentCardId: null, planKey: null, status: "inProgress" });
    const c3 = childCard("c3", { heldByCheckpoint: true });
    const slices = planSlices(planId, plan, [c1, c2, c3, c4]);
    expect(slices.map((slice) => slice.children.map((view) => [view.cardId, view.state]))).toEqual([
      [
        ["card-c1", "landed"],
        ["card-c2", "blocked"],
      ],
      [["card-c3", "held"]],
    ]);
    expect(slices.map((slice) => slice.finished)).toEqual([false, false]);
  });

  it("finishes a slice once every child landed or was abandoned", () => {
    const slices = planSlices(planId, plan, [
      childCard("c1", { status: "landed" }),
      childCard("c2", { status: "abandoned" }),
    ]);
    expect(slices[0]!.finished).toBe(true);
  });
});

describe("migrationCounts", () => {
  it("counts items by state", () => {
    expect(
      migrationCounts({
        items: [
          { key: "a", childCardId: null, state: "pending" },
          { key: "b", childCardId: null, state: "landed" },
          { key: "c", childCardId: null, state: "landed" },
          { key: "d", childCardId: null, state: "blocked" },
        ],
      }),
    ).toEqual({ pending: 1, running: 0, landed: 2, blocked: 1 });
  });
});

describe("planDraftLine", () => {
  it("says drafting only once the plan card works, and what's needed before that", () => {
    expect(planDraftLine("triage")).toMatch(/^Confirm its criteria and approve it/);
    expect(planDraftLine("ready")).toBe("Its coordinator drafts a plan once the card starts.");
    expect(planDraftLine("inProgress")).toBe("Its coordinator is drafting a plan.");
  });
});
