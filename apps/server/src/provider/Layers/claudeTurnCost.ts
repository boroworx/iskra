/**
 * A Claude turn's own cost from the query's running total. The Agent SDK's `total_cost_usd` is
 * cumulative across the turns of one streaming query, so summing it counts early turns again on
 * every later one. A total lower than the last one means the SDK started its count over (a
 * restarted query or a zeroed crash result), so that total is the turn's cost.
 */
export function claudeTurnCostUsd(previousTotalUsd: number, reportedTotalUsd: number): number {
  return reportedTotalUsd >= previousTotalUsd
    ? reportedTotalUsd - previousTotalUsd
    : reportedTotalUsd;
}
