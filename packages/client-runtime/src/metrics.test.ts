import { AgentId, CARD_VERIFICATION_OFF, type OrchestrationCard } from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import { METRICS_WINDOW_MS, metricsLine, templateMetrics } from "./metrics.ts";

const builder = AgentId.make("builder");
const now = Date.parse("2026-03-01T00:00:00.000Z");
const DAYS_AGO: Record<number, string> = {
  0: "2026-03-01T00:00:00.000Z",
  1: "2026-02-28T00:00:00.000Z",
  31: "2026-01-29T00:00:00.000Z",
};
const daysAgo = (days: 0 | 1 | 31) => DAYS_AGO[days]!;

const card = (overrides: Partial<OrchestrationCard> = {}) => ({
  delegateAgentId: builder,
  status: "landed" as OrchestrationCard["status"],
  updatedAt: daysAgo(1),
  spentUsd: 2,
  fixRounds: { ci: 0, review: 0 },
  verification: CARD_VERIFICATION_OFF,
  outcome: null,
  attemptGroupId: null,
  ...overrides,
});

describe("templateMetrics", () => {
  it("counts an agent's finished cards in the window: merged, flawed, cost per merged card", () => {
    const metrics = templateMetrics(
      [
        card({ spentUsd: 3, fixRounds: { ci: 1, review: 1 } }),
        card({
          outcome: { state: "flawed", decidedAt: daysAgo(0), signals: [] },
          verification: { ...CARD_VERIFICATION_OFF, state: "overridden" },
        }),
        card({
          status: "abandoned",
          spentUsd: 1,
          outcome: { state: "blocked", decidedAt: daysAgo(0), signals: [] },
        }),
        card({ verification: { ...CARD_VERIFICATION_OFF, state: "passed" } }),
        // Not counted: still open, outside the window, an attempt, or nobody's.
        card({ status: "inReview" }),
        card({ updatedAt: daysAgo(31) }),
        card({ attemptGroupId: "race" }),
        card({ delegateAgentId: null }),
      ],
      now,
      METRICS_WINDOW_MS,
    ).get(builder);

    expect(metrics).toEqual({
      agentId: builder,
      finished: 4,
      merged: 3,
      flawed: 1,
      blocked: 1,
      costPerMergedUsd: 8 / 3,
      roundsPerCard: 0.5,
      verifierFailureRate: 0.5,
    });
    expect(metricsLine("builder", metrics)).toBe(
      "@builder: 3/4 merged, 1 flawed, $2.67 per merged card",
    );
  });

  it("has no cost per merged card before one lands, and no verifier rate without a verifier", () => {
    const metrics = templateMetrics([card({ status: "abandoned" })], now).get(builder);
    expect(metrics?.costPerMergedUsd).toBeNull();
    expect(metrics?.verifierFailureRate).toBeNull();
    expect(metricsLine("builder", metrics)).toBe("@builder: 0/1 merged");
    expect(metricsLine("builder", undefined)).toBe(
      "@builder: no finished cards in the last 30 days",
    );
  });
});
