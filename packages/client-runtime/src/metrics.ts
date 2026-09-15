import type { AgentId, OrchestrationCard } from "@iskra/contracts";

/** The window routing hints and agent stats look back over. */
export const METRICS_WINDOW_MS = 30 * 24 * 60 * 60_000;

type MetricsCard = Pick<
  OrchestrationCard,
  | "delegateAgentId"
  | "status"
  | "updatedAt"
  | "spentUsd"
  | "fixRounds"
  | "verification"
  | "outcome"
  | "attemptGroupId"
>;

/** How one agent's finished cards went: what landed, what turned out flawed, and what it cost. */
export interface TemplateMetrics {
  readonly agentId: AgentId;
  /** Landed or abandoned cards in the window. */
  readonly finished: number;
  readonly merged: number;
  readonly flawed: number;
  readonly blocked: number;
  /** Everything its finished cards spent over the cards that landed; null before one landed. */
  readonly costPerMergedUsd: number | null;
  /** Fix rounds (CI and review) per finished card. */
  readonly roundsPerCard: number;
  /** Verified cards that ended failed or overridden, over verified cards; null when none were. */
  readonly verifierFailureRate: number | null;
}

/**
 * Per-agent outcomes of the cards it owned that finished in the window, newest landings included.
 * Metrics are computed from card shells on the client, so they cover one environment only.
 * ponytail: a card's last update stands in for when it finished; add a finishedAt to the card if a
 * late edit on an old card skews the window.
 */
export function templateMetrics(
  cards: ReadonlyArray<MetricsCard>,
  now: number,
  windowMs: number = METRICS_WINDOW_MS,
): ReadonlyMap<AgentId, TemplateMetrics> {
  const byAgent = new Map<AgentId, MetricsCard[]>();
  for (const card of cards) {
    // Attempts race each other; only the promoted one counts toward its agent.
    if (card.delegateAgentId === null || card.attemptGroupId !== null) continue;
    if (card.status !== "landed" && card.status !== "abandoned") continue;
    if (now - Date.parse(card.updatedAt) > windowMs) continue;
    const own = byAgent.get(card.delegateAgentId) ?? [];
    own.push(card);
    byAgent.set(card.delegateAgentId, own);
  }
  const metrics = new Map<AgentId, TemplateMetrics>();
  for (const [agentId, own] of byAgent) {
    const merged = own.filter((card) => card.status === "landed").length;
    const spent = own.reduce((total, card) => total + card.spentUsd, 0);
    const verified = own.filter((card) => card.verification.state !== "off");
    metrics.set(agentId, {
      agentId,
      finished: own.length,
      merged,
      flawed: own.filter((card) => card.outcome?.state === "flawed").length,
      blocked: own.filter((card) => card.outcome?.state === "blocked").length,
      costPerMergedUsd: merged === 0 ? null : spent / merged,
      roundsPerCard:
        own.reduce((total, card) => total + card.fixRounds.ci + card.fixRounds.review, 0) /
        own.length,
      verifierFailureRate:
        verified.length === 0
          ? null
          : verified.filter(
              (card) =>
                card.verification.state === "failed" || card.verification.state === "overridden",
            ).length / verified.length,
    });
  }
  return metrics;
}

/** One agent's track record as a line: "@builder: 8/10 merged, 1 flawed, $3.40 per merged card". */
export function metricsLine(name: string, metrics: TemplateMetrics | undefined): string {
  if (metrics === undefined) return `@${name}: no finished cards in the last 30 days`;
  const parts = [`${metrics.merged}/${metrics.finished} merged`];
  if (metrics.flawed > 0) parts.push(`${metrics.flawed} flawed`);
  if (metrics.costPerMergedUsd !== null) {
    parts.push(`$${metrics.costPerMergedUsd.toFixed(2)} per merged card`);
  }
  return `@${name}: ${parts.join(", ")}`;
}
