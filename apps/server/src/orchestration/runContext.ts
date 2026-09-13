import type {
  OrchestrationAgent,
  OrchestrationChannel,
  OrchestrationChannelMessage,
  RenderedRunContext,
  RunContextMessage,
  RunContextPayload,
} from "@t3tools/contracts";

export interface RunContextInput {
  readonly agent: OrchestrationAgent;
  readonly channel: OrchestrationChannel;
  /** The project's agents, used to name agent authors. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  /** Channel messages leading up to the trigger, oldest first. May include the trigger. */
  readonly messages: ReadonlyArray<OrchestrationChannelMessage>;
  /** The message that woke the agent. */
  readonly trigger: OrchestrationChannelMessage;
}

function authorName(
  message: OrchestrationChannelMessage,
  agents: ReadonlyArray<OrchestrationAgent>,
): string {
  switch (message.authorKind) {
    case "human":
      return "user";
    case "agent":
      return agents.find((agent) => agent.id === message.authorId)?.name ?? message.authorId;
    case "system":
      return "system";
    case "webhook":
      return message.authorId;
  }
}

/** A channel message as an agent reads it, with its author named. */
export function toRunContextMessage(
  message: OrchestrationChannelMessage,
  agents: ReadonlyArray<OrchestrationAgent>,
): RunContextMessage {
  return {
    messageId: message.id,
    authorKind: message.authorKind,
    authorName: authorName(message, agents),
    body: message.body,
    createdAt: message.createdAt,
  };
}

/**
 * Builds what an agent is handed when it wakes. Pure: the caller loads the
 * messages, and this decides which of them the agent sees.
 */
export function buildRunContext(input: RunContextInput): RunContextPayload {
  const { agent, channel } = input;
  const earlier = input.messages.filter((message) => message.id !== input.trigger.id);
  // `slice(-0)` would keep everything, so a wake depth of zero is handled explicitly.
  const history = channel.wakeDepth === 0 ? [] : earlier.slice(-channel.wakeDepth);
  return {
    agent: { id: agent.id, name: agent.name, rolePrompt: agent.rolePrompt },
    channel: { id: channel.id, kind: channel.kind, name: channel.name, topic: channel.topic },
    pinnedSpec: channel.pinnedSpec,
    wakeDepth: channel.wakeDepth,
    history: history.map((message) => toRunContextMessage(message, input.agents)),
    trigger: toRunContextMessage(input.trigger, input.agents),
  };
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed.length === 0 ? "" : `## ${title}\n\n${trimmed}`;
}

function formatMessage(message: RunContextMessage): string {
  const author = message.authorKind === "agent" ? `@${message.authorName}` : message.authorName;
  return `[${message.createdAt}] ${author}: ${message.body}`;
}

/** The text a message is handed to an agent with, first or mid-run. */
export function renderNewMessage(message: RunContextMessage): string {
  return `New message for you:\n${formatMessage(message)}`;
}

/**
 * The role an agent's DM session starts with. A DM is a continuous working
 * session with a person, not a read-only run, so it carries no channel context.
 */
export function renderAgentDmPrompt(
  agent: Pick<OrchestrationAgent, "name" | "rolePrompt">,
): string {
  return [
    `You are @${agent.name}, an agent on this project's team, working directly with a person in this repository.`,
    agent.rolePrompt.trim(),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Renders a context payload into the exact text sent to the provider. */
export function renderRunContext(payload: RunContextPayload): RenderedRunContext {
  const where =
    payload.channel.kind === "dm" ? "a direct message with the user" : `#${payload.channel.name}`;
  const systemPrompt = [
    `You are @${payload.agent.name}, an agent working in ${where}.`,
    payload.agent.rolePrompt.trim(),
    section("Channel topic", payload.channel.topic),
    section("Pinned spec", payload.pinnedSpec),
  ];
  const firstMessage = [
    payload.history.length === 0
      ? ""
      : `Recent messages in ${where}:\n${payload.history.map(formatMessage).join("\n")}`,
    renderNewMessage(payload.trigger),
  ];
  return {
    systemPrompt: systemPrompt.filter((part) => part.length > 0).join("\n\n"),
    firstMessage: firstMessage.filter((part) => part.length > 0).join("\n\n"),
  };
}
