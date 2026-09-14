import type { CardId, EnvironmentId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AttemptsView } from "../components/cards/AttemptsView";

function AttemptsRouteView() {
  const { environmentId, cardId } = Route.useParams();
  return <AttemptsView environmentId={environmentId as EnvironmentId} cardId={cardId as CardId} />;
}

export const Route = createFileRoute("/_chat/attempts/$environmentId/$cardId")({
  component: AttemptsRouteView,
});
