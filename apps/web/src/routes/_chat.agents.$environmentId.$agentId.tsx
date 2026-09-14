import type { AgentId, EnvironmentId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AgentView } from "../components/channels/AgentView";

function AgentRouteView() {
  const { environmentId, agentId } = Route.useParams();
  return <AgentView environmentId={environmentId as EnvironmentId} agentId={agentId as AgentId} />;
}

export const Route = createFileRoute("/_chat/agents/$environmentId/$agentId")({
  component: AgentRouteView,
});
