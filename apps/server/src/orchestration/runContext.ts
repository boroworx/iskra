import type {
  OrchestrationAgent,
  OrchestrationCard,
  OrchestrationChannel,
  OrchestrationChannelMessage,
  ProjectWikiPage,
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
  /** Set when the agent is woken as the channel's lead: the project's cards and wiki. */
  readonly lead?: {
    readonly cards: ReadonlyArray<OrchestrationCard>;
    readonly wiki?: ReadonlyArray<ProjectWikiPage>;
  };
}

/** How many wiki pages a lead's context names before it stops; it searches for the rest. */
const LEAD_WIKI_PAGES = 40;

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
  const line =
    rolePrompt
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "";
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
              .filter(
                (card) =>
                  card.projectId === channel.projectId && !isFinishedCardStatus(card.status),
              )
              .map((card) => ({ id: card.id, title: card.title, status: card.status })),
            wikiPages: (input.lead.wiki ?? [])
              .filter((page) => page.deletedAt === null)
              .slice(0, LEAD_WIKI_PAGES)
              .map((page) => ({ slug: page.slug, title: page.title })),
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
  const { kind, name } = payload.channel;
  const where =
    kind === "dm"
      ? "a direct message with the user"
      : kind === "requests"
        ? "the project's Requests conversation, where the user asks for work"
        : `#${name}`;
  const historyPlace = kind === "requests" ? "Requests" : where;
  const systemPrompt = [
    ...(lead === undefined
      ? [`You are @${payload.agent.name}, an agent working in ${where}.`]
      : [
          `You are @${payload.agent.name}, the lead of ${where}. You read the messages there that mention no one and turn requests for work into proposed cards, which people then approve.`,
          "Your final text is posted in the channel as your reply, so keep it short. You never assign, approve or wake agents.",
          "Read the recent messages first: a reply to a question you asked completes the request it was about.",
          "If the request is too vague to act on, or the work you would propose wouldn't get the requester to their goal, call ask_clarification with one short question, two or three answers and the one you recommend, then end your turn without replying. Propose nothing yet.",
          'Otherwise, for each distinct piece of work it asks for, call propose_triage_card once with a short title, a plain-language spec, your reasoning, two to five acceptance criteria a person can observe (mark ones only a person can check, such as mobile behavior, manual), an estimate with a split when it is too big for one card, the premise, the ids of open cards it likely duplicates, and as suggestedAgent the channel member best suited to own it. Then reply with one short line, such as "Proposed a card below."',
          "If the request asks to plan, break down or map out remaining work as cards, call propose_triage_card once with kind plan, criteria that describe the plan's outcome, and as suggestedAgent a coordinator agent if the project has one, instead of task cards that write documents.",
          "Never write a spec that depends on a later step no one is assigned to, such as the lead turning a document into cards.",
          "Check the project wiki with wiki_search when a request touches something agents may already know about this project, and write down with wiki_write what you learn about it.",
          "If the message asks for no work, answer it in a sentence or two.",
          "Never ask the user to run commands, fetch data or do the work for you; propose a card for work instead.",
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
      : `Recent messages in ${historyPlace}:\n${payload.history.map(formatMessage).join("\n")}`,
    lead === undefined
      ? ""
      : `## Open cards\n\n${
          lead.openCards.length === 0
            ? "No open cards."
            : lead.openCards.map((card) => `- ${card.id} [${card.status}] ${card.title}`).join("\n")
        }`,
    lead === undefined || (lead.wikiPages ?? []).length === 0
      ? ""
      : `## Project wiki\n\n${(lead.wikiPages ?? [])
          .map((page) => `- ${page.slug}: ${page.title}`)
          .join("\n")}\n\nRead one in full with wiki_read.`,
    renderNewMessage(payload.trigger),
  ];
  return {
    systemPrompt: systemPrompt.filter((part) => part.length > 0).join("\n\n"),
    firstMessage: firstMessage.filter((part) => part.length > 0).join("\n\n"),
  };
}
