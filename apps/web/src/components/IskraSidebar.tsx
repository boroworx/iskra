import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChannelId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AtSignIcon, HashIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn, randomUUID } from "../lib/utils";
import { channelEnvironment } from "../state/channels";
import { useEnvironmentAgents, useEnvironmentChannels, useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import {
  agentListEntries,
  channelListEntries,
  presenceDotClassName,
  presenceLabel,
  type AgentListEntry,
} from "./channels/channels.logic";
import { CreateAgentDialog } from "./channels/CreateAgentDialog";
import { CreateChannelDialog } from "./channels/CreateChannelDialog";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function projectKey(project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) {
  return `${project.environmentId}:${project.id}`;
}

function projectInitials(title: string): string {
  const words = title.split(/[\s/_.-]+/).filter((word) => word.length > 0);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : title.slice(0, 2);
  return initials.toUpperCase();
}

/**
 * The Iskra sidebar: a rail of projects, and the selected project's channels
 * and agents. The open channel's project is selected unless the user picked
 * another project since opening it.
 */
export default function IskraSidebar() {
  const projects = useProjects();
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => (params.environmentId ?? null) as EnvironmentId | null,
  });
  const routeChannelId = useParams({
    strict: false,
    select: (params) => (params.channelId ?? null) as ChannelId | null,
  });
  const routeChannels = useEnvironmentChannels(routeChannelId === null ? null : routeEnvironmentId);
  const routeProjectId =
    routeChannels.find((channel) => channel.id === routeChannelId)?.projectId ?? null;
  const [picked, setPicked] = useState<{
    readonly key: string;
    readonly routeChannelId: ChannelId | null;
  } | null>(null);
  const pickedKey = picked !== null && picked.routeChannelId === routeChannelId ? picked.key : null;
  const selected =
    projects.find((project) => projectKey(project) === pickedKey) ??
    projects.find(
      (project) => project.environmentId === routeEnvironmentId && project.id === routeProjectId,
    ) ??
    projects[0] ??
    null;
  const selectedKey = selected === null ? null : projectKey(selected);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Projects"
          className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-sidebar-border py-2"
        >
          {projects.map((project) => {
            const key = projectKey(project);
            const active = key === selectedKey;
            return (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={project.title}
                      aria-current={active ? "true" : undefined}
                      onClick={() => setPicked({ key, routeChannelId })}
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-xl text-xs font-semibold outline-hidden ring-ring focus-visible:ring-2",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent/70",
                      )}
                    >
                      {projectInitials(project.title)}
                    </button>
                  }
                />
                <TooltipPopup side="right">{project.title}</TooltipPopup>
              </Tooltip>
            );
          })}
        </nav>
        <SidebarContent className="gap-0">
          {selected === null ? (
            <p className="px-4 py-3 text-xs text-sidebar-muted-foreground">
              Add a project to get started.
            </p>
          ) : (
            <ProjectChannels
              key={selectedKey}
              project={selected}
              activeChannelId={routeChannelId}
            />
          )}
        </SidebarContent>
      </div>
      <SidebarChromeFooter />
    </>
  );
}

const ProjectChannels = memo(function ProjectChannels(props: {
  readonly project: EnvironmentProject;
  readonly activeChannelId: ChannelId | null;
}) {
  const { environmentId, id: projectId } = props.project;
  const navigate = useNavigate();
  const channels = useEnvironmentChannels(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const handleNewThread = useNewThreadHandler();
  const createChannel = useAtomCommand(channelEnvironment.create);
  const [openDialog, setOpenDialog] = useState<"channel" | "agent" | null>(null);
  const channelEntries = useMemo(
    () => channelListEntries(channels, projectId),
    [channels, projectId],
  );
  const agentEntries = useMemo(
    () => agentListEntries(channels, agents, projectId),
    [channels, agents, projectId],
  );

  // Agents created before DMs existed have none; the first click opens one.
  const openDirectMessage = async (agent: AgentListEntry) => {
    const channelId = ChannelId.make(randomUUID());
    const result = await createChannel({
      environmentId,
      input: {
        channelId,
        projectId,
        kind: "dm",
        name: `dm-${agent.name}`,
        memberAgentIds: [agent.id],
      },
    });
    if (result._tag === "Success") {
      void navigate({
        to: "/channels/$environmentId/$channelId",
        params: { environmentId, channelId },
      });
    }
  };

  return (
    <>
      <div className="flex h-10 shrink-0 items-center px-4 text-sm font-semibold">
        <span className="truncate">{props.project.title}</span>
      </div>
      <SidebarListGroup
        label="Channels"
        addLabel="New channel"
        onAdd={() => setOpenDialog("channel")}
        isEmpty={channelEntries.length === 0}
      >
        {channelEntries.map((entry) => (
          <SidebarMenuItem key={entry.id}>
            <SidebarMenuButton
              isActive={entry.id === props.activeChannelId}
              render={
                <Link
                  to="/channels/$environmentId/$channelId"
                  params={{ environmentId, channelId: entry.id }}
                />
              }
            >
              <HashIcon />
              <span className="truncate">{entry.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarListGroup>
      <SidebarListGroup
        label="Agents"
        addLabel="New agent"
        onAdd={() => setOpenDialog("agent")}
        isEmpty={agentEntries.length === 0}
      >
        {agentEntries.map((entry) => {
          const content = (
            <>
              <AtSignIcon />
              <span className="truncate">{entry.name}</span>
              <span className="ml-auto flex shrink-0 items-center">
                <span
                  aria-hidden
                  className={cn("size-2 rounded-full", presenceDotClassName(entry.presence))}
                />
                <span className="sr-only">{presenceLabel(entry.presence)}</span>
              </span>
            </>
          );
          return (
            <SidebarMenuItem key={entry.id}>
              {entry.dmChannelId === null ? (
                <SidebarMenuButton onClick={() => void openDirectMessage(entry)}>
                  {content}
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  isActive={entry.dmChannelId === props.activeChannelId}
                  render={
                    <Link
                      to="/channels/$environmentId/$channelId"
                      params={{ environmentId, channelId: entry.dmChannelId }}
                    />
                  }
                >
                  {content}
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          );
        })}
      </SidebarListGroup>
      <SidebarGroup className="mt-auto">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* The project's ordinary coding threads, in the thread sidebar. */}
            <SidebarMenuButton
              onClick={() => void handleNewThread(scopeProjectRef(environmentId, projectId))}
            >
              <MessagesSquareIcon />
              <span>Threads</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <CreateChannelDialog
        open={openDialog === "channel"}
        onOpenChange={(open) => setOpenDialog(open ? "channel" : null)}
        environmentId={environmentId}
        projectId={projectId}
        memberAgentIds={agentEntries.map((entry) => entry.id)}
      />
      <CreateAgentDialog
        open={openDialog === "agent"}
        onOpenChange={(open) => setOpenDialog(open ? "agent" : null)}
        project={props.project}
      />
    </>
  );
});

function SidebarListGroup(props: {
  readonly label: string;
  readonly addLabel: string;
  readonly onAdd: () => void;
  readonly isEmpty: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{props.label}</SidebarGroupLabel>
      <SidebarGroupAction aria-label={props.addLabel} onClick={props.onAdd}>
        <PlusIcon />
      </SidebarGroupAction>
      <SidebarMenu>
        {props.isEmpty ? (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">None yet</p>
        ) : null}
        {props.children}
      </SidebarMenu>
    </SidebarGroup>
  );
}
