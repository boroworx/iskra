import type { CardId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardView } from "../components/cards/BoardView";

/**
 * `card` opens that card's sheet, so a card is linkable from Needs you and elsewhere.
 * `new` opens the New card dialog, for the command palette.
 */
interface BoardSearch {
  readonly card?: string;
  readonly new?: true;
}

function BoardRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <BoardView
      environmentId={environmentId as EnvironmentId}
      projectId={projectId as ProjectId}
      openCardId={(search.card ?? null) as CardId | null}
      openNewCard={search.new === true}
    />
  );
}

export const Route = createFileRoute("/_chat/board/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.card === "string" && raw.card ? { card: raw.card } : {}),
    ...(raw.new === true || raw.new === "true" ? { new: true } : {}),
  }),
  component: BoardRouteView,
});
