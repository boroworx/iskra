import type {
  AgentPresence,
  OrchestrationAgentShell,
  OrchestrationChannelShell,
  ProjectId,
} from "@t3tools/contracts";

export interface SidebarChannelEntry {
  readonly key: string;
  readonly kind: OrchestrationChannelShell["kind"];
  readonly label: string;
}

export interface SidebarAgentEntry {
  readonly key: string;
  readonly name: string;
  readonly presence: AgentPresence;
}

/** A project's channels as the sidebar lists them: channels by name, then DMs by agent. */
export function sidebarChannelEntries(
  channels: ReadonlyArray<OrchestrationChannelShell>,
  agents: ReadonlyArray<OrchestrationAgentShell>,
  projectId: ProjectId,
): ReadonlyArray<SidebarChannelEntry> {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name] as const));
  return channels
    .filter((channel) => channel.projectId === projectId)
    .map((channel): SidebarChannelEntry => {
      if (channel.kind === "channel") {
        return { key: channel.id, kind: channel.kind, label: `#${channel.name}` };
      }
      // A DM is named for its one agent; the channel's own name is not shown.
      const [agentId] = channel.memberAgentIds;
      const agentName = agentId === undefined ? undefined : agentNames.get(agentId);
      return { key: channel.id, kind: channel.kind, label: `@${agentName ?? channel.name}` };
    })
    .toSorted((left, right) =>
      left.kind === right.kind
        ? left.label.localeCompare(right.label)
        : left.kind === "channel"
          ? -1
          : 1,
    );
}

/** A project's agents in name order. */
export function sidebarAgentEntries(
  agents: ReadonlyArray<OrchestrationAgentShell>,
  projectId: ProjectId,
): ReadonlyArray<SidebarAgentEntry> {
  return agents
    .filter((agent) => agent.projectId === projectId)
    .map((agent) => ({ key: agent.id, name: agent.name, presence: agent.presence }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Presence dot colour, matching the thread status palette: working is sky, waiting is amber. */
export function presenceDotClassName(presence: AgentPresence): string {
  switch (presence) {
    case "running":
      return "bg-sky-500 dark:bg-sky-300/80";
    case "blocked":
      return "bg-amber-500 dark:bg-amber-300/90";
    case "idle":
      return "bg-muted-foreground/40";
  }
}

export function presenceLabel(presence: AgentPresence): string {
  switch (presence) {
    case "running":
      return "Working";
    case "blocked":
      return "Waiting on you";
    case "idle":
      return "Idle";
  }
}
