import { createFileRoute, redirect } from "@tanstack/react-router";

// SnapShots moved into Integrations; old links land on its section there.
export const Route = createFileRoute("/settings/snap-shot")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/integrations",
      hash: "snap-shot",
      search: true,
      replace: true,
    });
  },
});
