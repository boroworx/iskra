import { createFileRoute } from "@tanstack/react-router";

import { NeedsYouView } from "../components/cards/NeedsYouView";

export const Route = createFileRoute("/_chat/needs-you")({
  component: NeedsYouView,
});
