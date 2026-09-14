import type { CardEstimate, OrchestrationAgentShell } from "@iskra/contracts";

type CardSize = CardEstimate["size"];

/**
 * A rough cost range per estimated size, in dollars. Advisory only, from a static table until
 * cost history per template exists; an XL card should be split before anyone prices it.
 */
export const CARD_COST_RANGE_USD: Readonly<Record<CardSize, readonly [number, number] | null>> = {
  S: [0.5, 2],
  M: [2, 8],
  L: [8, 25],
  XL: null,
};

const usd = (value: number) => (Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`);

export function costRangeLabel(size: CardSize): string {
  const range = CARD_COST_RANGE_USD[size];
  return range === null ? "Split first" : `${usd(range[0])}–${usd(range[1])}`;
}

export interface CardPreview {
  readonly size: CardSize;
  readonly costLabel: string;
  /** Too big to price: the preview asks for a split rather than a start. */
  readonly splitFirst: boolean;
  readonly likelyAreas: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly split: CardEstimate["split"];
  readonly agentName: string | null;
  readonly model: string | null;
}

/**
 * What Approve & start shows before a card runs: the lead's estimate, who runs it on which model,
 * and a cost range. Null when nobody estimated the card.
 */
export function cardPreview(input: {
  readonly estimate: CardEstimate | null;
  readonly agent: Pick<OrchestrationAgentShell, "name" | "modelSelection"> | null;
}): CardPreview | null {
  const { estimate, agent } = input;
  if (estimate === null) return null;
  return {
    size: estimate.size,
    costLabel: costRangeLabel(estimate.size),
    splitFirst: CARD_COST_RANGE_USD[estimate.size] === null,
    likelyAreas: estimate.likelyAreas,
    risks: estimate.risks,
    split: estimate.split,
    agentName: agent?.name ?? null,
    model: agent?.modelSelection.model ?? null,
  };
}
