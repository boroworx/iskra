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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
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
import { APP_DISPLAY_NAME } from "~/branding";
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
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">No channels yet</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            How work moves in {props.project.title}:
          </EmptyDescription>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-left text-sm text-muted-foreground">
            <li>You talk in a channel, and its lead turns requests into cards.</li>
            <li>Each card gets an owner agent that works on it in its own session.</li>
            <li>You review the work, then land it.</li>
          </ol>
          <div className="mt-6 flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenDialog("agent")}>
              <PlusIcon className="size-4" />
              New agent
            </Button>
            <Button size="sm" onClick={() => setOpenDialog("channel")}>
              <PlusIcon className="size-4" />
              New channel
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect to a computer running Iskra
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                This app connects to Iskra running on your computer or a server. Start the Iskra
                desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {description}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
