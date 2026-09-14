import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import type { EnvironmentId } from "@iskra/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentAgents, useEnvironmentChannels, useProjects } from "~/state/entities";
import { agentListEntries } from "./channels.logic";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { CreateChannelDialog } from "./CreateChannelDialog";

type CreateDialogKind = "channel" | "agent";

const OPEN_CREATE_DIALOG_EVENT = "iskra:open-create-dialog";

/** Opens New channel or New agent for the route's project, from the command palette or a shortcut. */
export function openCreateDialog(kind: CreateDialogKind): void {
  window.dispatchEvent(new CustomEvent(OPEN_CREATE_DIALOG_EVENT, { detail: kind }));
}

/** The project the route is about: the open channel's, agent's or board's, else the first project. */
export function useRouteProject(): EnvironmentProject | null {
  const params = useParams({ strict: false });
  const environmentId = (params.environmentId ?? null) as EnvironmentId | null;
  const channels = useEnvironmentChannels(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const projects = useProjects();
  const projectId =
    params.projectId ??
    channels.find((channel) => channel.id === params.channelId)?.projectId ??
    agents.find((agent) => agent.id === params.agentId)?.projectId;
  return (
    projects.find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    ) ??
    projects[0] ??
    null
  );
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
