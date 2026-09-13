import type {
  AgentId,
  AgentPresence,
  ChannelId,
  OrchestrationAgentShell,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
  ProjectId,
} from "@t3tools/contracts";

export interface ChannelListEntry {
  readonly id: ChannelId;
  readonly name: string;
}

export interface AgentListEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly presence: AgentPresence;
  /** The agent's DM, when it has one. */
  readonly dmChannelId: ChannelId | null;
}

export interface ChannelMemberEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly presence: AgentPresence;
}

export interface ChannelMessageRow {
  readonly message: OrchestrationChannelMessage;
  readonly authorName: string;
  /** False when the message continues its author's run of messages; the row then omits author and time. */
  readonly showHeader: boolean;
}

const MESSAGE_GROUP_WINDOW_MS = 5 * 60_000;

/** A typed channel name as Iskra stores it: lower case, words joined by dashes. */
export function toChannelName(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "-");
}

/** A typed agent name as it can be mentioned: lower-case letters, digits and dashes, at most 64. */
export function toAgentName(input: string): string {
  return toChannelName(input)
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 64);
}

/** A project's channels, by name. DMs are reached through their agent instead. */
export function channelListEntries(
  channels: ReadonlyArray<OrchestrationChannelShell>,
  projectId: ProjectId,
): ReadonlyArray<ChannelListEntry> {
  return channels
    .filter((channel) => channel.projectId === projectId && channel.kind === "channel")
    .map((channel) => ({ id: channel.id, name: channel.name }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** A project's agents by name, with presence and their DM when it exists. */
export function agentListEntries(
  channels: ReadonlyArray<OrchestrationChannelShell>,
  agents: ReadonlyArray<OrchestrationAgentShell>,
  projectId: ProjectId,
): ReadonlyArray<AgentListEntry> {
  const dmByAgent = new Map<AgentId, ChannelId>();
  for (const channel of channels) {
    const [agentId] = channel.memberAgentIds;
    if (channel.kind === "dm" && agentId !== undefined && !dmByAgent.has(agentId)) {
      dmByAgent.set(agentId, channel.id);
    }
  }
  return agents
    .filter((agent) => agent.projectId === projectId)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      presence: agent.presence,
      dmChannelId: dmByAgent.get(agent.id) ?? null,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** A channel's member agents in name order. */
export function channelMemberEntries(
  channel: OrchestrationChannelShell,
  agents: ReadonlyArray<OrchestrationAgentShell>,
): ReadonlyArray<ChannelMemberEntry> {
  const memberIds = new Set<AgentId>(channel.memberAgentIds);
  return agents
    .filter((agent) => memberIds.has(agent.id))
    .map((agent) => ({ id: agent.id, name: agent.name, presence: agent.presence }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Messages as the channel view shows them: named authors, one header per run of messages. */
export function channelMessageRows(
  messages: ReadonlyArray<OrchestrationChannelMessage>,
  agents: ReadonlyArray<OrchestrationAgentShell>,
): ReadonlyArray<ChannelMessageRow> {
  const agentNames = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const continuesRun =
      previous !== undefined &&
      previous.authorKind === message.authorKind &&
      previous.authorId === message.authorId &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) < MESSAGE_GROUP_WINDOW_MS;
    return {
      message,
      authorName: channelAuthorName(message, agentNames),
      showHeader: !continuesRun,
    };
  });
}

function channelAuthorName(
  message: OrchestrationChannelMessage,
  agentNames: ReadonlyMap<string, string>,
): string {
  switch (message.authorKind) {
    case "human":
      return "You";
    case "agent":
      return agentNames.get(message.authorId) ?? message.authorId;
    case "system":
      return "Iskra";
    case "webhook":
      return message.authorId;
  }
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
