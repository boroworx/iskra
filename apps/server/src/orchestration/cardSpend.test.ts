import { describe, expect, it } from "vite-plus/test";

import { turnUsageTotals } from "./cardSpend.ts";

describe("turnUsageTotals", () => {
  it("separates uncached input from the cache reads and writes a turn folds into input", () => {
    expect(
      turnUsageTotals({
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 10_000,
        cachedInputTokens: 6_000,
        cacheCreationTokens: 1_000,
        outputTokens: 800,
        reasoningTokens: 200,
        hasSubagents: false,
      }),
    ).toEqual({
      uncachedInputTokens: 3_000,
      cachedInputTokens: 6_000,
      cacheCreationTokens: 1_000,
      outputTokens: 800,
      reasoningTokens: 200,
    });
  });

  it("prices what a partial report has, and nothing when there are no counts", () => {
    expect(
      turnUsageTotals({
        usageScope: "main_agent",
        usageStatus: "partial",
        outputTokens: 120,
        hasSubagents: false,
      }),
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 120,
      reasoningTokens: 0,
    });
    expect(
      turnUsageTotals({ usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false }),
    ).toBeNull();
    expect(turnUsageTotals(undefined)).toBeNull();
  });
});
