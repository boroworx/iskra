import type { CardId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardView } from "../components/cards/BoardView";

/** `card` opens that card's sheet, so a card is linkable from Needs you and elsewhere. */
interface BoardSearch {
  readonly card?: string;
}

function BoardRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const { card } = Route.useSearch();
  return (
    <BoardView
      environmentId={environmentId as EnvironmentId}
      projectId={projectId as ProjectId}
      openCardId={(card ?? null) as CardId | null}
    />
  );
}

export const Route = createFileRoute("/_chat/board/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch =>
    typeof raw.card === "string" && raw.card ? { card: raw.card } : {},
  component: BoardRouteView,
});
