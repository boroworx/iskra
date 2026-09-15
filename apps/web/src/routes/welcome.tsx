import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { GuidedFirstRun } from "../components/welcome/GuidedFirstRun";

/** Onboarding overlays the workspace. Visiting /welcome reopens setup; ?guide=1 opens the guided first run. */
export const Route = createFileRoute("/welcome")({
  validateSearch: (search: Record<string, unknown>): { guide?: true } =>
    search.guide === true || search.guide === "1" || search.guide === 1 ? { guide: true } : {},
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { guide } = Route.useSearch();
  const navigate = useNavigate();
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  // An authenticated gate means a primary server is serving this app —
  // desktop, `npx @iskra/cli`, or a dev server — and that server is "this machine"
  // no matter what hostname the browser used. Only hosted-static has no
  // local server to offer.
  const localAvailable = authGateState.status === "authenticated";
  if (guide === true) {
    return <GuidedFirstRun />;
  }
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={localAvailable}
          onDone={() => {
            setDismissed(true);
            // Iskra has no free-standing threads: setup lands on the channel shell.
            void navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
