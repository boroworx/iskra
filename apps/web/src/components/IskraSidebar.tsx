import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import type { AgentId, ChannelId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArchiveIcon, AtSignIcon, HashIcon, InboxIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  useEnvironmentAgents,
  useEnvironmentCards,
  useEnvironmentChannels,
  useProjects,
} from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { channelEnvironment } from "../state/channels";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentAgentChannels } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import {
  agentListEntries,
  channelListEntries,
  presenceDotClassName,
  presenceLabel,
} from "./channels/channels.logic";
import { AgentSettingsDialog, useAgentDefinitions } from "./channels/AgentSettingsDialog";
import { ChannelSettingsDialog } from "./channels/ChannelSettingsDialog";
import { CreateAgentDialog } from "./channels/CreateAgentDialog";
import { CreateChannelDialog } from "./channels/CreateChannelDialog";
import { useProjectRailMemory, useRouteProject } from "./channels/IskraCreateDialogs";
import { projectKey, railClickTarget } from "./projectRail.logic";
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

/** The cross-project Needs you list, with how many items wait. */
function NeedsYouEntry() {
  const cards = useEnvironmentCards(usePrimaryEnvironmentId());
  // Read once: the count follows card changes, and a snooze ending shows on the next one.
  const [now] = useState(() => Date.now());
  const count = needsYouItems({ cards, sessions: cardOwnerSessions(cards), now }).length;
  return (
    <SidebarMenu className="px-2 pt-2">
      <SidebarMenuItem>
        <SidebarMenuButton render={<Link to="/needs-you" />}>
          <InboxIcon />
          <span className="truncate">Needs you</span>
          {count > 0 ? (
            <span className="ml-auto text-xs tabular-nums text-sidebar-muted-foreground">
              {count}
            </span>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function projectInitials(title: string): string {
  const words = title.split(/[\s/_.-]+/).filter((word) => word.length > 0);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : title.slice(0, 2);
  return initials.toUpperCase();
}

/**
 * The Iskra sidebar: a rail of projects, and the selected project's channels
 * and agents. The URL decides the selected project (see `useRouteProject`); a
 * rail click navigates into that project rather than selecting it locally.
 */
export default function IskraSidebar() {
  const projects = useProjects();
  const navigate = useNavigate();
  const routeChannelId = useParams({
    strict: false,
    select: (params) => (params.channelId ?? null) as ChannelId | null,
  });
  const routeAgentId = useParams({
    strict: false,
    select: (params) => (params.agentId ?? null) as AgentId | null,
  });
  const selected = useRouteProject();
  const selectedKey = selected === null ? null : projectKey(selected);
  const [memory] = useProjectRailMemory();
  const openProject = (project: EnvironmentProject) => {
    const { environmentId, id: projectId } = project;
    // Read once on click: subscribing every rail square to its environment's channels would re-render the rail.
    const channels = appAtomRegistry.get(
      environmentAgentChannels.environmentChannelsAtom(environmentId),
    );
    const target = railClickTarget(
      channelListEntries(channels, projectId).map((entry) => entry.id),
      memory.lastChannelByProject[projectKey(project)],
    );
    void (target.kind === "channel"
      ? navigate({
          to: "/channels/$environmentId/$channelId",
          params: { environmentId, channelId: target.channelId },
        })
      : navigate({ to: "/board/$environmentId/$projectId", params: { environmentId, projectId } }));
  };

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
                      onClick={() => openProject(project)}
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
          <NeedsYouEntry />
          {selected === null ? (
            <p className="px-4 py-3 text-xs text-sidebar-muted-foreground">
              Add a project to get started.
            </p>
          ) : (
            <ProjectChannels
              key={selectedKey}
              project={selected}
              activeChannelId={routeChannelId}
              activeAgentId={routeAgentId}
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
  readonly activeAgentId: AgentId | null;
}) {
  const { environmentId, id: projectId } = props.project;
  const channels = useEnvironmentChannels(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const [openDialog, setOpenDialog] = useState<"channel" | "agent" | null>(null);
  const channelEntries = useMemo(
    () => channelListEntries(channels, projectId),
    [channels, projectId],
  );
  const agentEntries = useMemo(() => agentListEntries(agents, projectId), [agents, projectId]);
  const [settingsAgentId, setSettingsAgentId] = useState<AgentId | null>(null);
  const [settingsChannelId, setSettingsChannelId] = useState<ChannelId | null>(null);
  const settingsChannel = channels.find((channel) => channel.id === settingsChannelId) ?? null;

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-sm font-semibold">
        <span className="truncate">{props.project.title}</span>
        <Link
          to="/board/$environmentId/$projectId"
          params={{ environmentId, projectId }}
          className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          Board
        </Link>
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
            <button
              type="button"
              aria-label={`#${entry.name} settings`}
              onClick={() => setSettingsChannelId(entry.id)}
              className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 outline-hidden ring-ring group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 [&>svg]:size-3.5"
            >
              <SettingsIcon />
            </button>
          </SidebarMenuItem>
        ))}
        <ArchivedChannels
          environmentId={environmentId}
          projectId={projectId}
          activeCount={channelEntries.length}
        />
      </SidebarListGroup>
      <SidebarListGroup
        label="Agents"
        addLabel="New agent"
        onAdd={() => setOpenDialog("agent")}
        isEmpty={agentEntries.length === 0}
      >
        {agentEntries.map((entry) => (
          <SidebarMenuItem key={entry.id}>
            {/* An agent's row opens its DM: a window onto its sessions. */}
            <SidebarMenuButton
              isActive={entry.id === props.activeAgentId}
              render={
                <Link
                  to="/agents/$environmentId/$agentId"
                  params={{ environmentId, agentId: entry.id }}
                />
              }
            >
              <AtSignIcon />
              <span className="truncate">{entry.name}</span>
              <span className="ml-auto flex shrink-0 items-center group-focus-within/menu-item:invisible group-hover/menu-item:invisible">
                <span
                  aria-hidden
                  className={cn("size-2 rounded-full", presenceDotClassName(entry.presence))}
                />
                <span className="sr-only">{presenceLabel(entry.presence)}</span>
              </span>
            </SidebarMenuButton>
            <button
              type="button"
              aria-label={`@${entry.name} settings`}
              onClick={() => setSettingsAgentId(entry.id)}
              className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 outline-hidden ring-ring group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 [&>svg]:size-3.5"
            >
              <SettingsIcon />
            </button>
          </SidebarMenuItem>
        ))}
        <ArchivedAgents
          environmentId={environmentId}
          projectId={projectId}
          activeCount={agentEntries.length}
          onOpen={setSettingsAgentId}
        />
      </SidebarListGroup>
      {settingsAgentId === null ? null : (
        <AgentSettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) setSettingsAgentId(null);
          }}
          environmentId={environmentId}
          projectId={projectId}
          agentId={settingsAgentId}
        />
      )}
      {settingsChannel === null ? null : (
        <ChannelSettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) setSettingsChannelId(null);
          }}
          environmentId={environmentId}
          channel={settingsChannel}
        />
      )}
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

/**
 * A project's archived channels, collapsed under its channels, so an archive is
 * never a one-way door: each row unarchives its channel and opens it.
 */
function ArchivedChannels(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly activeCount: number;
}) {
  const archivedChannels = useEnvironmentQuery(
    channelEnvironment.archivedChannels({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const unarchive = useAtomCommand(channelEnvironment.unarchive);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // The list does not stream: refetch when a channel is archived or unarchived.
  const refresh = archivedChannels.refresh;
  const seenCount = useRef(props.activeCount);
  useEffect(() => {
    if (seenCount.current !== props.activeCount) {
      seenCount.current = props.activeCount;
      refresh();
    }
  }, [props.activeCount, refresh]);
  const archived = archivedChannels.data?.channels ?? [];
  if (archived.length === 0) {
    return null;
  }
  const unarchiveChannel = async (channelId: ChannelId) => {
    const result = await unarchive({ environmentId: props.environmentId, input: { channelId } });
    refresh();
    if (result._tag === "Success") {
      void navigate({
        to: "/channels/$environmentId/$channelId",
        params: { environmentId: props.environmentId, channelId },
      });
    }
  };
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ArchiveIcon />
          <span className="truncate text-sidebar-muted-foreground">
            Archived ({archived.length})
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open
        ? archived.map((channel) => (
            <SidebarMenuItem key={channel.id}>
              <SidebarMenuButton
                size="sm"
                className="pl-6 text-sidebar-muted-foreground"
                aria-label={`Unarchive #${channel.name}`}
                onClick={() => void unarchiveChannel(channel.id)}
              >
                <span className="truncate">#{channel.name}</span>
                <span className="ml-auto shrink-0 text-xs">Unarchive</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        : null}
    </>
  );
}

/**
 * A project's archived agents, collapsed under its agents, so an archive is never
 * a one-way door: each opens its settings, which offer Unarchive.
 */
function ArchivedAgents(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly activeCount: number;
  readonly onOpen: (agentId: AgentId) => void;
}) {
  const definitions = useAgentDefinitions(props.environmentId, props.projectId);
  const [open, setOpen] = useState(false);
  // The list does not stream: refetch when an agent is archived or unarchived.
  const refresh = definitions.refresh;
  const seenCount = useRef(props.activeCount);
  useEffect(() => {
    if (seenCount.current !== props.activeCount) {
      seenCount.current = props.activeCount;
      refresh();
    }
  }, [props.activeCount, refresh]);
  const archived = useMemo(
    () =>
      (definitions.data?.agents ?? [])
        .filter((agent) => agent.archived)
        .map((agent) => agent.definition)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [definitions.data],
  );
  if (archived.length === 0) {
    return null;
  }
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ArchiveIcon />
          <span className="truncate text-sidebar-muted-foreground">
            Archived ({archived.length})
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open
        ? archived.map((definition) => (
            <SidebarMenuItem key={definition.id}>
              <SidebarMenuButton
                size="sm"
                className="pl-6 text-sidebar-muted-foreground"
                onClick={() => props.onOpen(definition.id)}
              >
                <span className="truncate">@{definition.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        : null}
    </>
  );
}

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
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
            None yet.{" "}
            <button
              type="button"
              onClick={props.onAdd}
              className="rounded-sm font-medium text-sidebar-foreground underline-offset-2 outline-hidden ring-ring hover:underline focus-visible:ring-2"
            >
              {props.addLabel}
            </button>
          </p>
        ) : null}
        {props.children}
      </SidebarMenu>
    </SidebarGroup>
  );
}
