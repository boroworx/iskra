import type { EnvironmentId, ProjectId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardView } from "../components/cards/BoardView";

function BoardRouteView() {
  const { environmentId, projectId } = Route.useParams();
  return (
    <BoardView environmentId={environmentId as EnvironmentId} projectId={projectId as ProjectId} />
  );
}

export const Route = createFileRoute("/_chat/board/$environmentId/$projectId")({
  component: BoardRouteView,
});
