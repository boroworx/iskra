import type {
  OrchestrationAgent,
  OrchestrationCard,
  OrchestrationChannel,
  OrchestrationChannelMessage,
  RenderedRunContext,
  RunContextMessage,
  RunContextPayload,
} from "@iskra/contracts";

import { isFinishedCardStatus } from "./cardRules.ts";

export interface RunContextInput {
  readonly agent: OrchestrationAgent;
  readonly channel: OrchestrationChannel;
  /** The project's agents, used to name agent authors. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  /** Channel messages leading up to the trigger, oldest first. May include the trigger. */
  readonly messages: ReadonlyArray<OrchestrationChannelMessage>;
  /** The message that woke the agent. */
  readonly trigger: OrchestrationChannelMessage;
  /** Set when the agent is woken as the channel's lead: the project's cards. */
  readonly lead?: { readonly cards: ReadonlyArray<OrchestrationCard> };
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

const ROLE_SUMMARY_LIMIT = 160;

/** The first line of a role prompt, cut short: enough for a lead to choose an owner. */
function roleSummary(rolePrompt: string): string {
  const line = rolePrompt.split("\n").find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.length > ROLE_SUMMARY_LIMIT ? `${line.slice(0, ROLE_SUMMARY_LIMIT - 1)}…` : line;
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
    ...(input.lead === undefined
      ? {}
      : {
          lead: {
            members: channel.memberAgentIds.flatMap((memberId) => {
              const member = input.agents.find((candidate) => candidate.id === memberId);
              if (member === undefined) {
                return [];
              }
              const summary = roleSummary(member.rolePrompt);
              return [
                {
                  name: member.name,
                  roleTags: member.roleTags,
                  ...(summary.length > 0 ? { summary } : {}),
                },
              ];
            }),
            openCards: input.lead.cards
              .filter((card) => card.projectId === channel.projectId && !isFinishedCardStatus(card.status))
              .map((card) => ({ id: card.id, title: card.title, status: card.status })),
          },
        }),
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
 * Renders a context payload into the exact text sent to the provider. A lead reads the channel to
 * propose cards: its final text is posted as its reply, so it asks one question when a request is
 * too vague, says one line when it proposes, and answers briefly when nothing is asked of it.
 */
export function renderRunContext(payload: RunContextPayload): RenderedRunContext {
  const { lead } = payload;
  const where =
    payload.channel.kind === "dm" ? "a direct message with the user" : `#${payload.channel.name}`;
  const systemPrompt = [
    ...(lead === undefined
      ? [`You are @${payload.agent.name}, an agent working in ${where}.`]
      : [
          `You are @${payload.agent.name}, the lead of ${where}. You read the messages there that mention no one and turn requests for work into proposed cards, which people then approve.`,
          "Your final text is posted in the channel as your reply, so keep it short. You never assign, approve or wake agents.",
          "Read the recent messages first: a reply to a question you asked completes the request it was about.",
          "If the request is too vague to act on, reply with one short clarifying question and propose nothing yet.",
          'Otherwise, for each distinct piece of work it asks for, call propose_triage_card once with a short title, a plain-language spec, your reasoning, the ids of open cards it likely duplicates, and as suggestedAgent the channel member best suited to own it. Then reply with one short line, such as "Proposed a card below."',
          "If the message asks for no work, answer it in a sentence or two.",
        ]),
    payload.agent.rolePrompt.trim(),
    section("Channel topic", payload.channel.topic),
    section("Pinned spec", payload.pinnedSpec),
    section(
      "Channel members",
      (lead?.members ?? [])
        .map(
          (member) =>
            `- @${member.name}${member.roleTags.length > 0 ? ` (${member.roleTags.join(", ")})` : ""}${member.summary === undefined ? "" : `: ${member.summary}`}`,
        )
        .join("\n"),
    ),
  ];
  const firstMessage = [
    payload.history.length === 0
      ? ""
      : `Recent messages in ${where}:\n${payload.history.map(formatMessage).join("\n")}`,
    lead === undefined
      ? ""
      : `## Open cards\n\n${
          lead.openCards.length === 0
            ? "No open cards."
            : lead.openCards.map((card) => `- ${card.id} [${card.status}] ${card.title}`).join("\n")
        }`,
    renderNewMessage(payload.trigger),
  ];
  return {
    systemPrompt: systemPrompt.filter((part) => part.length > 0).join("\n\n"),
    firstMessage: firstMessage.filter((part) => part.length > 0).join("\n\n"),
  };
}
