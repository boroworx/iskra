import { requestsChannelId } from "@iskra/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { channelListEntries } from "../components/channels/channels.logic";
import { useProjectRailMemory } from "../components/channels/IskraCreateDialogs";
import {
  projectKey,
  railClickTarget,
  withStoredProjectFirst,
} from "../components/projectRail.logic";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/iskra/Page";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentChannels,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedStaticOnboardingState />;
  }

  return <IndexChannelLanding />;
}

/**
 * Landing on the index route opens the last opened, else most recently active, project: its
 * remembered channel while that is still active, else its Requests. Without projects it shows
 * the add-project hero.
 */
function IndexChannelLanding() {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryChannels = useEnvironmentChannels(primaryEnvironmentId);

  const [railMemory] = useProjectRailMemory();

  const sortedProjects = useMemo(
    () =>
      bootstrapped
        ? withStoredProjectFirst(
            sortScopedProjectsForSidebar(projects, threads, "updated_at"),
            railMemory.lastProjectKey,
          )
        : [],
    [bootstrapped, projects, railMemory.lastProjectKey, threads],
  );
  const landingProject =
    sortedProjects.find((project) => project.environmentId === primaryEnvironmentId) ??
    sortedProjects[0];
  const landingEnvironmentId = landingProject?.environmentId ?? null;
  const landingChannelId =
    landingProject === undefined
      ? null
      : railClickTarget(
          channelListEntries(primaryChannels, landingProject.id).map((entry) => entry.id),
          railMemory.lastChannelByProject[projectKey(landingProject)],
          requestsChannelId(landingProject.id),
        );

  useEffect(() => {
    if (landingEnvironmentId === null || landingChannelId === null) {
      return;
    }
    void navigate({
      to: "/channels/$environmentId/$channelId",
      params: { environmentId: landingEnvironmentId, channelId: landingChannelId },
      replace: true,
    });
  }, [landingChannelId, landingEnvironmentId, navigate]);

  if (!bootstrapped || landingChannelId !== null) {
    return null;
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Enable Iskra Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} />
      <EmptyState
        icon={<LinkIcon className="size-8" />}
        title="Connect to a computer running Iskra"
        body={
          <>
            Start the Iskra desktop app or command-line server on that machine and keep it running.{" "}
            {description}
          </>
        }
        actions={
          <Button render={<Link to="/settings/connections" />}>
            <PlusIcon />
            Open Connections
          </Button>
        }
      />
    </SidebarInset>
  );
}
