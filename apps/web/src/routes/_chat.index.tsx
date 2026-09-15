import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { agentListEntries } from "../components/channels/channels.logic";
import { CreateAgentDialog } from "../components/channels/CreateAgentDialog";
import { CreateChannelDialog } from "../components/channels/CreateChannelDialog";
import { useProjectRailMemory } from "../components/channels/IskraCreateDialogs";
import { projectKey, withStoredProjectFirst } from "../components/projectRail.logic";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/iskra/Page";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentAgents,
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
 * Landing on the index route opens a channel: the first one in the most
 * recently active project that has any. Without channels it points at the
 * sidebar, where agents and channels are created; without projects it shows
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

  // The project last opened comes first, then the most recently active.
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
  const landingProject = sortedProjects.find(
    (project) =>
      project.environmentId === primaryEnvironmentId &&
      primaryChannels.some((channel) => channel.projectId === project.id),
  );
  const landingProjectChannels = primaryChannels.filter(
    (channel) => channel.projectId === landingProject?.id,
  );
  const lastChannelId =
    landingProject === undefined
      ? undefined
      : railMemory.lastChannelByProject[projectKey(landingProject)];
  const landingChannel =
    landingProjectChannels.find((channel) => channel.id === lastChannelId) ??
    landingProjectChannels.find((channel) => channel.kind === "channel") ??
    landingProjectChannels[0];
  const landingEnvironmentId = landingProject?.environmentId ?? null;
  const landingChannelId = landingChannel?.id ?? null;

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
  const setupProject =
    sortedProjects.find((project) => project.environmentId === primaryEnvironmentId) ??
    sortedProjects[0];
  if (setupProject === undefined) {
    // First-run routing to the welcome wizard happens in FirstRunGate at the
    // root, before this route ever renders.
    return <NoProjectsHero />;
  }
  return <NoChannelsLanding project={setupProject} />;
}

/** A project with no channel yet: how work moves through Iskra, and the two things to create first. */
function NoChannelsLanding(props: { readonly project: EnvironmentProject }) {
  const { environmentId, id: projectId } = props.project;
  const agents = useEnvironmentAgents(environmentId);
  const memberAgentIds = useMemo(
    () => agentListEntries(agents, projectId).map((agent) => agent.id),
    [agents, projectId],
  );
  const [openDialog, setOpenDialog] = useState<"channel" | "agent" | null>(null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} />
      <EmptyState
        title="No channels yet"
        body="Talk to agents in a channel; its lead turns requests into cards."
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpenDialog("agent")}>
              <PlusIcon />
              New agent
            </Button>
            <Button onClick={() => setOpenDialog("channel")}>
              <PlusIcon />
              New channel
            </Button>
          </>
        }
      />
      <CreateAgentDialog
        open={openDialog === "agent"}
        onOpenChange={(open) => setOpenDialog(open ? "agent" : null)}
        project={props.project}
      />
      <CreateChannelDialog
        open={openDialog === "channel"}
        onOpenChange={(open) => setOpenDialog(open ? "channel" : null)}
        environmentId={environmentId}
        projectId={projectId}
        memberAgentIds={memberAgentIds}
      />
    </SidebarInset>
  );
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
