import type {
  AgentId,
  AgentPresence,
  ChannelId,
  OrchestrationAgentRun,
  OrchestrationAgentShell,
  OrchestrationCard,
  OrchestrationChannelMessage,
  OrchestrationChannelShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
} from "@iskra/contracts";
import { DEFAULT_AGENT_ROLES } from "@iskra/contracts";

export interface ChannelListEntry {
  readonly id: ChannelId;
  readonly name: string;
}

/** An agent in the sidebar or a member list, with its presence across all its sessions. */
export interface AgentEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly presence: AgentPresence;
}

/** Where an agent's DM composer writes: the DM itself (`threadId` null) or one of its live sessions. */
export interface DmTarget {
  readonly threadId: ThreadId | null;
  readonly label: string;
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
    .toSorted(byName);
}

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name.localeCompare(right.name);

function agentEntries(
  agents: ReadonlyArray<OrchestrationAgentShell>,
  keep: (agent: OrchestrationAgentShell) => boolean,
): ReadonlyArray<AgentEntry> {
  return agents
    .filter(keep)
    .map((agent) => ({ id: agent.id, name: agent.name, presence: agent.presence }))
    .toSorted(byName);
}

/**
 * The `@name` being typed just before the cursor, read the way the server reads
 * mentions (so `dev@backend` is not one). Null when the cursor is not in a mention.
 */
export function mentionQueryAt(
  text: string,
  cursor: number,
): { readonly start: number; readonly query: string } | null {
  const match = /(^|[^\w@])@([a-z0-9-]*)$/i.exec(text.slice(0, cursor));
  if (match === null) {
    return null;
  }
  const query = match[2] ?? "";
  return { start: cursor - query.length - 1, query: query.toLowerCase() };
}

const MAX_MENTION_CANDIDATES = 8;

/** Agents to offer for a typed mention: names that start with the query, then names that contain it. */
export function mentionCandidates<T extends { readonly name: string }>(
  agents: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  return [
    ...agents.filter((agent) => agent.name.startsWith(query)),
    ...agents.filter((agent) => !agent.name.startsWith(query) && agent.name.includes(query)),
  ].slice(0, MAX_MENTION_CANDIDATES);
}

/** A project's agents by name. */
export function agentListEntries(agents: ReadonlyArray<OrchestrationAgentShell>, projectId: ProjectId) {
  return agentEntries(agents, (agent) => agent.projectId === projectId);
}

/**
 * The agents a channel's lead picker offers: the project's agents whose roles include lead (older
 * servers send no roles, so the defaults apply), plus the current lead even if it lost the role.
 */
export function leadCandidates(
  agents: ReadonlyArray<OrchestrationAgentShell>,
  projectId: ProjectId,
  currentLeadId: AgentId | null,
) {
  return agentEntries(
    agents,
    (agent) =>
      agent.projectId === projectId &&
      (agent.id === currentLeadId || (agent.roles ?? DEFAULT_AGENT_ROLES).includes("lead")),
  );
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
  if (channel === undefined) {
    return "a channel";
  }
  return channel.kind === "dm" ? "this DM" : `#${channel.name}`;
}

/** An agent's active DM channel, once its first direct message has opened one. */
export function agentDmChannel(
  channels: ReadonlyArray<OrchestrationChannelShell>,
  agentId: AgentId,
): OrchestrationChannelShell | null {
  return (
    channels.find((channel) => channel.kind === "dm" && channel.memberAgentIds.includes(agentId)) ??
    null
  );
}

const DIRECT_MESSAGE_TARGET: DmTarget = { threadId: null, label: "Direct message" };

/**
 * Where an agent's DM composer can write: the DM first, then the live sessions
 * outside it, most recently started first: its channel conversations and the
 * cards it owns. Helpers and critics take no messages; a run in the DM is the DM.
 */
export function dmTargets(
  runs: ReadonlyArray<OrchestrationAgentRun>,
  channels: ReadonlyArray<OrchestrationChannelShell>,
): ReadonlyArray<DmTarget> {
  const dmChannelIds = new Set(
    channels.filter((channel) => channel.kind === "dm").map((channel) => channel.id),
  );
  // ponytail: "most recently active" is approximated by start time; use the thread's last activity if it misleads.
  const sessions = runs
    .filter(
      (run) =>
        run.endedAt === null &&
        (run.role === "conversation" || run.role === "owner") &&
        (run.channelId === null || !dmChannelIds.has(run.channelId)),
    )
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((run) => ({ threadId: run.threadId, label: sessionWhere(run, channels) }));
  return [DIRECT_MESSAGE_TARGET, ...sessions];
}

const RUN_DOING: Record<OrchestrationAgentRun["role"], string> = {
  conversation: "Replying in",
  lead: "Leading",
  owner: "Building",
  helper: "Helping on",
  critic: "Critiquing",
  verifier: "Verifying",
};

/**
 * An agent's live runs, newest first: what each does and where, and since when. Every wake is
 * its own run, so one agent can be live in several channels, DMs and cards at once.
 */
export function liveInstances(
  runs: ReadonlyArray<OrchestrationAgentRun>,
  channels: ReadonlyArray<OrchestrationChannelShell>,
): ReadonlyArray<{
  readonly threadId: OrchestrationAgentRun["threadId"];
  readonly doing: string;
  readonly where: string;
  readonly since: string;
}> {
  return runs
    .filter((run) => run.endedAt === null)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((run) => ({
      threadId: run.threadId,
      doing: RUN_DOING[run.role],
      where: sessionWhere(run, channels),
      since: run.startedAt,
    }));
}

/** A channel's member agents in name order. */
export function channelMemberEntries(
  channel: OrchestrationChannelShell,
  agents: ReadonlyArray<OrchestrationAgentShell>,
) {
  const memberIds = new Set<AgentId>(channel.memberAgentIds);
  return agentEntries(agents, (agent) => memberIds.has(agent.id));
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

/**
 * What a human message says about its deliveries: a wait while unread and a warning if never
 * read. Every wake is its own run now, so a delivery an older server still marks queued is
 * just waiting too.
 */
export function deliveryNotes(
  message: OrchestrationChannelMessage,
  agents: ReadonlyArray<OrchestrationAgentShell>,
): ReadonlyArray<DeliveryNote> {
  const agentNames = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  return (message.deliveries ?? []).flatMap((delivery): ReadonlyArray<DeliveryNote> => {
    const name = `@${agentNames.get(delivery.agentId) ?? delivery.agentId}`;
    switch (delivery.status) {
      case "queued":
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

type ProposalCard = Pick<
  OrchestrationCard,
  "id" | "channelId" | "sourceMessageId" | "createdBy" | "createdAt"
>;

/**
 * Where each lead proposal shows in a channel's timeline, by message id: under the lead's first
 * message posted at or after the card (its reply), or under the message the card came from until
 * that reply arrives. Cards whose source message isn't loaded are left out.
 */
export function proposalAnchors<C extends ProposalCard>(
  messages: ReadonlyArray<OrchestrationChannelMessage>,
  cards: ReadonlyArray<C>,
  channelId: ChannelId,
): ReadonlyMap<string, ReadonlyArray<C>> {
  const indexById = new Map<string, number>(messages.map((message, index) => [message.id, index]));
  const anchors = new Map<string, C[]>();
  for (const card of cards) {
    const sourceId = card.sourceMessageId;
    const sourceIndex = sourceId === null ? undefined : indexById.get(sourceId);
    if (
      sourceId === null ||
      sourceIndex === undefined ||
      card.channelId !== channelId ||
      card.createdBy.kind !== "lead"
    ) {
      continue;
    }
    const reply = messages
      .slice(sourceIndex + 1)
      .find(
        (message) =>
          message.authorKind === "agent" &&
          message.authorId === card.createdBy.id &&
          message.createdAt >= card.createdAt,
      );
    const anchorId = reply?.id ?? sourceId;
    anchors.set(anchorId, [...(anchors.get(anchorId) ?? []), card]);
  }
  return anchors;
}

/**
 * Where a proposal stands once it has an owner, or null while it waits for a person to approve and
 * start it: in triage, or ready with no owner.
 */
export function cardProposalStatus(
  card: Pick<OrchestrationCard, "status" | "delegateAgentId">,
  agents: ReadonlyArray<Pick<AgentEntry, "id" | "name">>,
): string | null {
  const owner = `@${agents.find((agent) => agent.id === card.delegateAgentId)?.name ?? card.delegateAgentId}`;
  switch (card.status) {
    case "triage":
      return null;
    case "ready":
      return card.delegateAgentId === null ? null : `Starting · ${owner}`;
    case "inProgress":
      return `In progress · ${owner}`;
    case "inReview":
      return "Ready for review";
    case "landing":
      return "Landing";
    case "landed":
      return "Landed";
    case "abandoned":
      return "Dropped";
  }
}

/**
 * The card a note from Iskra reports on, read from the note's id, and whether the note is its
 * owner's question. Null for any other message.
 */
export function cardNoteOf(
  message: Pick<OrchestrationChannelMessage, "id" | "authorKind">,
): { readonly cardId: string; readonly question: boolean } | null {
  const match =
    message.authorKind === "system" ? /:card-(progress|question):([^:]+)$/.exec(message.id) : null;
  const cardId = match?.[2];
  return match === null || cardId === undefined ? null : { cardId, question: match[1] === "question" };
}
