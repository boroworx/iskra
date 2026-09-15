import { describe, expect, it } from "vite-plus/test";

import { claudeTurnCostUsd } from "./claudeTurnCost.ts";

describe("claudeTurnCostUsd", () => {
  it("charges each turn only what it added to the query's running total", () => {
    // The eXpose card's three turns: running totals 2.62, 2.84 and 7.06 cost 7.06 in all, not 12.52.
    const totals = [2.62, 2.84, 7.06];
    let previous = 0;
    const costs = totals.map((total) => {
      const cost = claudeTurnCostUsd(previous, total);
      previous = total;
      return cost;
    });
    expect(costs.map((cost) => Number(cost.toFixed(2)))).toEqual([2.62, 0.22, 4.22]);
    expect(Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(2))).toBe(7.06);
  });

  it("takes a lower total as a new count, not a negative cost", () => {
    expect(claudeTurnCostUsd(5, 1.5)).toBe(1.5);
    expect(claudeTurnCostUsd(5, 0)).toBe(0);
  });
});
