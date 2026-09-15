import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import type { AgentId, ChannelId, EnvironmentId, ProjectId } from "@iskra/contracts";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  LayoutGridIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
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
  presenceLabel,
  presenceSpark,
} from "./channels/channels.logic";
import { AgentSettingsDialog, useAgentDefinitions } from "./channels/AgentSettingsDialog";
import { ChannelSettingsDialog } from "./channels/ChannelSettingsDialog";
import { CreateAgentDialog } from "./channels/CreateAgentDialog";
import { CreateChannelDialog } from "./channels/CreateChannelDialog";
import { useProjectRailMemory, useRouteProject } from "./channels/IskraCreateDialogs";
import { AgentAvatar } from "./iskra/AgentAvatar";
import { SparkGlyph } from "./iskra/SparkGlyph";
import { projectKey, projectRailInitials, railClickTarget } from "./projectRail.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

/** A source-list row: 28px, 13px regular text on a subtle fill when selected. */
const ROW =
  "h-7 gap-2 rounded-[6px] px-2 text-[13px] font-normal text-sidebar-foreground data-[active=true]:font-normal";

/** A row's hover-only control, such as a channel's settings. */
const ROW_ACTION =
  "absolute top-0 right-0.5 flex size-7 items-center justify-center rounded-md text-tertiary-label opacity-0 outline-hidden ring-ring group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 [&>svg]:size-3.5";

/** A project's tile: its initials on Iskra blue. */
function ProjectTile(props: { readonly initials: string; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-linear-to-b from-[#409cff] to-[#0a6fe0] text-[10px] font-bold text-white",
        props.className,
      )}
    >
      {props.initials}
    </span>
  );
}

/** The cross-project Needs You list, with how many items wait. */
function NeedsYouRow(props: { readonly active: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  const cards = useEnvironmentCards(environmentId);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  // Read once: the count follows card changes, and a snooze ending shows on the next one.
  const [now] = useState(() => Date.now());
  const count = needsYouItems({ cards, sessions: cardOwnerSessions(cards), projects, now }).length;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton className={ROW} isActive={props.active} render={<Link to="/needs-you" />}>
        <span aria-hidden className="flex shrink-0">
          <SparkGlyph state="needsYou" size={16} />
        </span>
        <span className="truncate">Needs You</span>
        {count > 0 ? (
          <span className="ml-auto h-[18px] min-w-[18px] shrink-0 rounded-full bg-[rgb(120_120_128/16%)] px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums dark:bg-[rgb(120_120_128/28%)]">
            {count}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The Iskra sidebar: Needs You across every project, then a project picker and
 * the selected project's board, channels and agents. The URL decides the selected project (see
 * `useRouteProject`); picking a project navigates into it rather than
 * selecting it locally.
 */
export default function IskraSidebar() {
  const projects = useProjects();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
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
  const initials = useMemo(
    () => projectRailInitials(projects.map((project) => project.title)),
    [projects],
  );
  const openProject = (project: EnvironmentProject) => {
    const { environmentId, id: projectId } = project;
    // Read once on pick: subscribing every project entry to its environment's channels would re-render the picker.
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
  const selectedIndex = projects.findIndex((project) => projectKey(project) === selectedKey);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div className="flex min-h-0 flex-1 flex-col px-2.5">
        {/* Needs You spans every project, so it sits above the picker that scopes the rows below. */}
        <SidebarMenu className="mb-2.5">
          <NeedsYouRow active={pathname === "/needs-you"} />
        </SidebarMenu>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="mb-2 flex h-10 w-full shrink-0 items-center gap-2.5 rounded-lg bg-[rgb(120_120_128/10%)] px-2 text-left outline-hidden ring-ring hover:bg-[rgb(120_120_128/16%)] focus-visible:ring-2 data-popup-open:bg-[rgb(120_120_128/16%)] dark:bg-[rgb(120_120_128/14%)] dark:hover:bg-[rgb(120_120_128/20%)]"
              />
            }
          >
            {selected === null ? (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[rgb(120_120_128/24%)] text-sidebar-foreground">
                  <PlusIcon className="size-3.5" />
                </span>
                <span className="truncate text-[13px] font-semibold">Projects</span>
              </>
            ) : (
              <>
                <ProjectTile initials={initials[selectedIndex] ?? ""} />
                <span className="truncate text-[13px] font-semibold">{selected.title}</span>
              </>
            )}
            <ChevronsUpDownIcon aria-hidden className="ml-auto size-3 shrink-0 text-tertiary-label" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-(--anchor-width) min-w-56">
            {projects.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Projects</MenuGroupLabel>
                {projects.map((project, index) => {
                  const key = projectKey(project);
                  return (
                    <MenuItem key={key} onClick={() => openProject(project)}>
                      <ProjectTile initials={initials[index] ?? ""} className="size-5 text-[9px]" />
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                      {key === selectedKey ? (
                        <CheckIcon aria-label="Current project" className="size-3.5 text-foreground" />
                      ) : null}
                    </MenuItem>
                  );
                })}
              </MenuGroup>
            ) : null}
            {projects.length > 0 ? <MenuSeparator /> : null}
            <MenuItem onClick={() => openCommandPalette({ open: "add-project" })}>
              <PlusIcon />
              Add project
            </MenuItem>
          </MenuPopup>
        </Menu>
        <SidebarContent className="gap-0 pb-2">
          <SidebarMenu className="gap-0.5">
            {selected === null ? null : (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className={ROW}
                  isActive={pathname.startsWith(`/board/${selected.environmentId}/${selected.id}`)}
                  render={
                    <Link
                      to="/board/$environmentId/$projectId"
                      params={{ environmentId: selected.environmentId, projectId: selected.id }}
                    />
                  }
                >
                  <LayoutGridIcon className="text-info-foreground!" />
                  <span className="truncate">Board</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
          {selected === null ? (
            <p className="px-2 py-3 text-xs text-tertiary-label">Add a project to get started.</p>
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
      <SidebarListGroup
        label="Channels"
        addLabel="New channel"
        onAdd={() => setOpenDialog("channel")}
        isEmpty={channelEntries.length === 0}
      >
        {channelEntries.map((entry) => (
          <SidebarMenuItem key={entry.id}>
            <SidebarMenuButton
              className={ROW}
              isActive={entry.id === props.activeChannelId}
              render={
                <Link
                  to="/channels/$environmentId/$channelId"
                  params={{ environmentId, channelId: entry.id }}
                />
              }
            >
              <span aria-hidden className="w-4 shrink-0 text-center font-semibold text-info-foreground">
                #
              </span>
              <span className="truncate">{entry.name}</span>
            </SidebarMenuButton>
            <button
              type="button"
              aria-label={`#${entry.name} settings`}
              onClick={() => setSettingsChannelId(entry.id)}
              className={ROW_ACTION}
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
        {agentEntries.map((entry) => {
          const spark = presenceSpark(entry.presence);
          return (
            <SidebarMenuItem key={entry.id}>
              {/* An agent's row opens its DM: a window onto its sessions. */}
              <SidebarMenuButton
                className={ROW}
                isActive={entry.id === props.activeAgentId}
                render={
                  <Link
                    to="/agents/$environmentId/$agentId"
                    params={{ environmentId, agentId: entry.id }}
                  />
                }
              >
                <span aria-hidden className="flex w-4 shrink-0 justify-center">
                  <AgentAvatar
                    name={entry.name}
                    size="xs"
                    spark={spark === "idle" ? undefined : spark}
                  />
                </span>
                <span className="sr-only">{presenceLabel(entry.presence)}</span>
                <span className="truncate">{entry.name}</span>
              </SidebarMenuButton>
              <button
                type="button"
                aria-label={`@${entry.name} settings`}
                onClick={() => setSettingsAgentId(entry.id)}
                className={ROW_ACTION}
              >
                <SettingsIcon />
              </button>
            </SidebarMenuItem>
          );
        })}
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

/** A quiet disclosure row for a list's archived entries. */
function ArchivedToggle(props: {
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={cn(ROW, "text-tertiary-label hover:text-sidebar-foreground")}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ArchiveIcon className="size-3.5!" />
        <span className="truncate">Archived {props.count}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

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
      <ArchivedToggle
        count={archived.length}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open
        ? archived.map((channel) => (
            <SidebarMenuItem key={channel.id}>
              <SidebarMenuButton
                className={cn(ROW, "pl-8 text-muted-foreground")}
                aria-label={`Unarchive #${channel.name}`}
                onClick={() => void unarchiveChannel(channel.id)}
              >
                <span className="truncate">#{channel.name}</span>
                <span className="ml-auto shrink-0 text-[11px] text-tertiary-label">Unarchive</span>
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
      <ArchivedToggle
        count={archived.length}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open
        ? archived.map((definition) => (
            <SidebarMenuItem key={definition.id}>
              <SidebarMenuButton
                className={cn(ROW, "pl-8 text-muted-foreground")}
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
    <SidebarGroup className="group/section p-0">
      <SidebarGroupLabel className="h-auto rounded-none px-2 pt-3.5 pb-1 text-[11px] font-semibold text-tertiary-label">
        {props.label}
      </SidebarGroupLabel>
      {/* Shown on hover or focus; the empty list's link and touch screens keep a way in. */}
      <SidebarGroupAction
        aria-label={props.addLabel}
        onClick={props.onAdd}
        className="top-2 right-0.5 size-7 rounded-md text-tertiary-label opacity-0 group-focus-within/section:opacity-100 group-hover/section:opacity-100 pointer-coarse:opacity-100 hover:text-sidebar-foreground [&>svg:not([class*='size-'])]:size-3.5"
      >
        <PlusIcon />
      </SidebarGroupAction>
      <SidebarMenu className="gap-0.5">
        {props.isEmpty ? (
          <p className="px-2 py-1 text-xs text-tertiary-label">
            None yet.{" "}
            <button
              type="button"
              onClick={props.onAdd}
              className="rounded-sm font-medium text-info-foreground outline-hidden ring-ring hover:underline focus-visible:ring-2"
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
