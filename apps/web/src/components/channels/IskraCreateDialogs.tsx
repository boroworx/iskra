import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import type { ChannelId, EnvironmentId, ThreadId } from "@iskra/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useEnvironmentAgents,
  useEnvironmentCards,
  useEnvironmentChannels,
  useProjects,
  useThreadShell,
} from "~/state/entities";
import {
  EMPTY_PROJECT_RAIL_MEMORY,
  PROJECT_RAIL_STORAGE_KEY,
  ProjectRailMemory,
  projectKey,
  rememberRailRoute,
  resolveRailProject,
  routeProjectId,
} from "../projectRail.logic";
import { agentListEntries } from "./channels.logic";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { CreateChannelDialog } from "./CreateChannelDialog";

type CreateDialogKind = "channel" | "agent";

const OPEN_CREATE_DIALOG_EVENT = "iskra:open-create-dialog";

/** Opens New channel or New agent for the route's project, from the command palette or a shortcut. */
export function openCreateDialog(kind: CreateDialogKind): void {
  window.dispatchEvent(new CustomEvent(OPEN_CREATE_DIALOG_EVENT, { detail: kind }));
}

/** The project rail's memory: the last project a route named and each project's last channel. */
export function useProjectRailMemory() {
  return useLocalStorage(PROJECT_RAIL_STORAGE_KEY, EMPTY_PROJECT_RAIL_MEMORY, ProjectRailMemory);
}

/**
 * The project the route is about: the one its board, channel, agent, card or
 * thread belongs to; else the last one a route named; else the first project.
 * Remembers the route's project (and open channel) for routes that name none.
 */
export function useRouteProject(): EnvironmentProject | null {
  const params = useParams({ strict: false });
  const environmentId = (params.environmentId ?? null) as EnvironmentId | null;
  const channels = useEnvironmentChannels(params.channelId === undefined ? null : environmentId);
  const agents = useEnvironmentAgents(params.agentId === undefined ? null : environmentId);
  const cards = useEnvironmentCards(params.cardId === undefined ? null : environmentId);
  const thread = useThreadShell(
    environmentId === null || params.threadId === undefined
      ? null
      : { environmentId, threadId: params.threadId as ThreadId },
  );
  const projects = useProjects();
  const [memory, setMemory] = useProjectRailMemory();
  const { project, fromRoute } = resolveRailProject({
    projects,
    routeEnvironmentId: environmentId,
    routeProjectId: routeProjectId({
      params,
      channels,
      agents,
      cards,
      threadProjectId: thread?.projectId ?? null,
    }),
    storedProjectKey: memory.lastProjectKey,
  });
  const rememberKey = fromRoute && project !== null ? projectKey(project) : null;
  const rememberChannelId = (params.channelId ?? null) as ChannelId | null;
  useEffect(() => {
    if (rememberKey === null) return;
    const next = rememberRailRoute(memory, rememberKey, rememberChannelId);
    if (next !== memory) setMemory(next);
  }, [memory, rememberChannelId, rememberKey, setMemory]);
  return project;
}

/** Hosts the create dialogs `openCreateDialog` asks for; mounted once in the chat layout. */
export function IskraCreateDialogs() {
  const project = useRouteProject();
  const [kind, setKind] = useState<CreateDialogKind | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => setKind((event as CustomEvent<CreateDialogKind>).detail);
    window.addEventListener(OPEN_CREATE_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CREATE_DIALOG_EVENT, onOpen);
  }, []);
  if (project === null) {
    return null;
  }
  return <ProjectCreateDialogs project={project} kind={kind} onClose={() => setKind(null)} />;
}

function ProjectCreateDialogs(props: {
  readonly project: EnvironmentProject;
  readonly kind: CreateDialogKind | null;
  readonly onClose: () => void;
}) {
  const { environmentId, id: projectId } = props.project;
  const agents = useEnvironmentAgents(environmentId);
  const memberAgentIds = useMemo(
    () => agentListEntries(agents, projectId).map((agent) => agent.id),
    [agents, projectId],
  );
  const onOpenChange = (open: boolean) => {
    if (!open) props.onClose();
  };
  return (
    <>
      <CreateChannelDialog
        open={props.kind === "channel"}
        onOpenChange={onOpenChange}
        environmentId={environmentId}
        projectId={projectId}
        memberAgentIds={memberAgentIds}
      />
      <CreateAgentDialog
        open={props.kind === "agent"}
        onOpenChange={onOpenChange}
        project={props.project}
      />
    </>
  );
}
