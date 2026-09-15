import type { CardId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardView } from "../components/cards/BoardView";
import { WikiView } from "../components/wiki/WikiView";

/**
 * `card` opens that card's sheet, so a card is linkable from Needs you and elsewhere.
 * `new` opens the New card dialog, for the command palette.
 * `focus` moves to that control in the open card's sheet, for Needs you's actions.
 */
interface BoardSearch {
  readonly card?: string;
  readonly new?: true;
  readonly focus?: "agent" | "criteria";
  /** `wiki` shows the project's wiki in place of the board, and `page` one of its pages. */
  readonly view?: "wiki";
  readonly page?: string;
}

function BoardRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const search = Route.useSearch();
  if (search.view === "wiki") {
    return (
      <WikiView
        environmentId={environmentId as EnvironmentId}
        projectId={projectId as ProjectId}
        slug={search.page ?? null}
      />
    );
  }
  return (
    <BoardView
      environmentId={environmentId as EnvironmentId}
      projectId={projectId as ProjectId}
      openCardId={(search.card ?? null) as CardId | null}
      openNewCard={search.new === true}
      focus={search.focus}
    />
  );
}

export const Route = createFileRoute("/_chat/board/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.card === "string" && raw.card ? { card: raw.card } : {}),
    ...(raw.new === true || raw.new === "true" ? { new: true } : {}),
    ...(raw.focus === "agent" || raw.focus === "criteria" ? { focus: raw.focus } : {}),
    ...(raw.view === "wiki" ? { view: "wiki" as const } : {}),
    ...(typeof raw.page === "string" && raw.page ? { page: raw.page } : {}),
  }),
  component: BoardRouteView,
});
