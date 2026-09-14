import type { TurnTokenUsage, UsageTokenTotals } from "@iskra/contracts";

/**
 * A turn's normalized token usage as the pricing table counts it. Turn usage
 * folds cache reads and writes into input; pricing keeps uncached input apart.
 * Null when the provider reported no counts to price.
 */
export function turnUsageTotals(usage: TurnTokenUsage | undefined): UsageTokenTotals | null {
  if (usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)) {
    return null;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}
