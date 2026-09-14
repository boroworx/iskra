import type {
  AgentId,
  AgentPresence,
  ChannelId,
  OrchestrationAgentRun,
  OrchestrationAgentShell,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
} from "@iskra/contracts";

export interface ChannelListEntry {
  readonly id: ChannelId;
  readonly name: string;
}

export interface AgentListEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly presence: AgentPresence;
}

/** A live session an agent's DM can write into. */
export interface DmTarget {
  readonly threadId: ThreadId;
  readonly label: string;
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

/** A project's agents by name, with their presence across all their sessions. */
export function agentListEntries(
  agents: ReadonlyArray<OrchestrationAgentShell>,
  projectId: ProjectId,
): ReadonlyArray<AgentListEntry> {
  return agents
    .filter((agent) => agent.projectId === projectId)
    .map((agent) => ({ id: agent.id, name: agent.name, presence: agent.presence }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Where a session works: the channel it talks in, or the card it builds or helps on. */
export function sessionWhere(
  run: Pick<OrchestrationAgentRun, "role" | "channelId" | "cardTitle">,
  channels: ReadonlyArray<OrchestrationChannelShell>,
): string {
  if (run.role !== "conversation" && run.role !== "lead") {
    return run.cardTitle ?? "a card";
  }
  const channel = channels.find((candidate) => candidate.id === run.channelId);
  return channel === undefined ? "a channel" : `#${channel.name}`;
}

/**
 * The live sessions an agent's DM can write into, most recently started first:
 * its conversations and the cards it owns. Helpers and critics take no messages.
 */
export function dmTargets(
  runs: ReadonlyArray<OrchestrationAgentRun>,
  channels: ReadonlyArray<OrchestrationChannelShell>,
): ReadonlyArray<DmTarget> {
  // ponytail: "most recently active" is approximated by start time; use the thread's last activity if it misleads.
  return runs
    .filter((run) => run.endedAt === null && (run.role === "conversation" || run.role === "owner"))
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((run) => ({ threadId: run.threadId, label: sessionWhere(run, channels) }));
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

export interface RunOutputItem {
  readonly id: string;
  readonly text: string;
  /** True when the agent speaks to people (full white); false for its ambient work (grey). */
  readonly addressedToUser: boolean;
}

// Updates on work already listed; showing them would repeat each tool call.
const QUIET_ACTIVITY_KINDS = new Set(["tool.updated", "tool.progress", "task.progress"]);

/**
 * A run's output in order. Assistant text is addressed to the user; tool
 * lifecycle, denials and other activity are not. The prompts Iskra sent are
 * left out: the context inspector shows them.
 */
export function runOutputItems(thread: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyArray<RunOutputItem> {
  return [
    ...thread.activities
      .filter((activity) => !QUIET_ACTIVITY_KINDS.has(activity.kind))
      .map((activity) => ({
        id: activity.id,
        text: activity.summary,
        addressedToUser: false,
        at: activity.createdAt,
      })),
    ...thread.messages
      .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
      .map((message) => ({
        id: message.id,
        text: message.text,
        addressedToUser: true,
        at: message.createdAt,
      })),
  ]
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map(({ id, text, addressedToUser }) => ({ id, text, addressedToUser }));
}

export interface DeliveryNote {
  readonly agentId: AgentId;
  readonly text: string;
  readonly undelivered: boolean;
}

/** What a human message says about its deliveries: a wait while unread, a warning if never read. */
export function deliveryNotes(
  message: OrchestrationChannelMessage,
  agents: ReadonlyArray<OrchestrationAgentShell>,
): ReadonlyArray<DeliveryNote> {
  const agentNames = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  return (message.deliveries ?? []).flatMap((delivery): ReadonlyArray<DeliveryNote> => {
    const name = `@${agentNames.get(delivery.agentId) ?? delivery.agentId}`;
    switch (delivery.status) {
      case "pending":
      case "sent":
        return [{ agentId: delivery.agentId, text: `Waiting for ${name}`, undelivered: false }];
      case "undelivered":
        return [{ agentId: delivery.agentId, text: `${name} never read this`, undelivered: true }];
      case "delivered":
        return [];
    }
  });
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
