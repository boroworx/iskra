import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  useAllEnvironmentShellsBootstrapped,
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

  const sortedProjects = useMemo(
    () => (bootstrapped ? sortScopedProjectsForSidebar(projects, threads, "updated_at") : []),
    [bootstrapped, projects, threads],
  );
  const landingProject = sortedProjects.find(
    (project) =>
      project.environmentId === primaryEnvironmentId &&
      primaryChannels.some((channel) => channel.projectId === project.id),
  );
  const landingProjectChannels = primaryChannels.filter(
    (channel) => channel.projectId === landingProject?.id,
  );
  const landingChannel =
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
  if (sortedProjects.length === 0) {
    // First-run routing to the welcome wizard happens in FirstRunGate at the
    // root, before this route ever renders.
    return <NoProjectsHero />;
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">No channels yet</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            Add an agent and a channel from the sidebar, then mention the agent in the channel to
            put it to work.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader className="border-b border-border">
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
                This browser connects to Iskra running on your computer or a server. Start the Iskra
                Code desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Enable Iskra Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
                  : "Open Connections and add that machine using its pairing link. This browser must be able to reach it."}
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
