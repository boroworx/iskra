import type { ChannelId, EnvironmentId } from "@iskra/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ChannelView } from "../components/channels/ChannelView";

function ChannelRouteView() {
  const { environmentId, channelId } = Route.useParams();
  return (
    <ChannelView
      environmentId={environmentId as EnvironmentId}
      channelId={channelId as ChannelId}
    />
  );
}

export const Route = createFileRoute("/_chat/channels/$environmentId/$channelId")({
  component: ChannelRouteView,
});
