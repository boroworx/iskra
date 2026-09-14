import { AgentId, ProjectId, ProviderInstanceId } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardPreview, costRangeLabel } from "./cardPreview.ts";

describe("cardPreview", () => {
  it("prices sizes from the static table and asks for a split instead of pricing an XL card", () => {
    expect(["S", "M", "L", "XL"].map((size) => costRangeLabel(size as "S"))).toEqual([
      "$0.50–$2",
      "$2–$8",
      "$8–$25",
      "Split first",
    ]);

    const agent = {
      id: AgentId.make("builder"),
      projectId: ProjectId.make("project"),
      name: "builder",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
    };
    const estimate = {
      size: "XL" as const,
      likelyAreas: ["apps/web"],
      risks: ["touches auth"],
      split: { reason: "Two features", cards: [{ title: "A", criteria: ["a"] }] },
    };
    expect(cardPreview({ estimate, agent })).toMatchObject({
      costLabel: "Split first",
      splitFirst: true,
      agentName: "builder",
      model: "claude-opus-5",
      split: { reason: "Two features" },
    });
    expect(cardPreview({ estimate: null, agent })).toBeNull();
  });
});
