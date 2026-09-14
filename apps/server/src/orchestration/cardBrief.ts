import type {
  CardAuthor,
  CardDiffStat,
  CardBriefPayload,
  CardSessionRole,
  OrchestrationAgent,
  OrchestrationCard,
  RenderedRunContext,
} from "@iskra/contracts";

import type { ProjectionCardMessage } from "../persistence/Services/ProjectionCards.ts";
import { renderNewMessage } from "./runContext.ts";

/** Past this many characters a brief's diff is cut, so a large change cannot flood the first turn. */
export const CARD_BRIEF_DIFF_LIMIT = 40_000;

interface CardBriefInput {
  readonly agent: OrchestrationAgent;
  readonly role: CardSessionRole;
  readonly card: OrchestrationCard;
  /** The project's agents, used to name decision authors. */
  readonly agents: ReadonlyArray<OrchestrationAgent>;
  readonly decisions: ReadonlyArray<{
    readonly author: CardAuthor;
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly baseBranch: string;
  /** The worktree's full diff against its base; cut here to the limit. */
  readonly diff: string;
  readonly question: string | null;
}

function authorName(author: CardAuthor, agents: ReadonlyArray<OrchestrationAgent>): string {
  switch (author.kind) {
    case "human":
      return "user";
    case "agent":
      return agents.find((agent) => agent.id === author.id)?.name ?? author.id;
    case "lead":
      return "channel lead";
    case "linear":
      return "Linear";
  }
}

/** Builds the handoff brief a card session starts from. Pure: the caller loads the log and diff. */
export function buildCardBrief(input: CardBriefInput): CardBriefPayload {
  const { agent, card } = input;
  const diffTruncated = input.diff.length > CARD_BRIEF_DIFF_LIMIT;
  return {
    agent: { id: agent.id, name: agent.name, rolePrompt: agent.rolePrompt },
    role: input.role,
    card: {
      id: card.id,
      title: card.title,
      spec: card.spec,
      branch: card.branch,
      baseBranch: input.baseBranch,
    },
    decisions: input.decisions.map((decision) => ({
      authorName: authorName(decision.author, input.agents),
      text: decision.text,
      createdAt: decision.createdAt,
    })),
    diff: diffTruncated ? input.diff.slice(0, CARD_BRIEF_DIFF_LIMIT) : input.diff,
    diffTruncated,
    question: input.question,
  };
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

/** Renders a brief into the exact text sent to the provider. */
export function renderCardBrief(brief: CardBriefPayload): RenderedRunContext {
  const { card } = brief;
  const intro =
    brief.role === "owner"
      ? `You are @${brief.agent.name}, the agent building the card "${card.title}". You work in its worktree and are the only agent writing to it. Use the board tools: record_decision for each choice that matters, update_plan as you go, ask_owner when the spec leaves you stuck, propose_card for work outside this card, and request_review once your work is committed.`
      : brief.role === "critic"
        ? `You are @${brief.agent.name}, reviewing the spec of the card "${card.title}" before any work starts. You can read the repository but not change it. List concrete gaps, ambiguities and risks in the spec, or say plainly that it is ready.`
        : `You are @${brief.agent.name}, helping on the card "${card.title}". You can read its worktree but not change it; your answer goes to the agent building the card.`;
  const systemPrompt = [intro, brief.agent.rolePrompt.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const where =
    card.branch === null
      ? `Based on \`${card.baseBranch}\`; the card has no branch yet.`
      : `Branch \`${card.branch}\`, based on \`${card.baseBranch}\`.`;
  const decisions =
    brief.decisions.length === 0
      ? "No decisions recorded yet."
      : brief.decisions
          .map((decision) => `- [${decision.createdAt}] ${decision.authorName}: ${decision.text}`)
          .join("\n");
  const changes =
    brief.diff.trim().length === 0
      ? "No changes yet."
      : [
          `\`\`\`diff\n${brief.diff.trimEnd()}\n\`\`\``,
          brief.diffTruncated
            ? "The diff was cut short; run `git diff` in the worktree for the rest."
            : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
  const firstMessage = [
    `# Handoff brief: ${card.title}`,
    where,
    section("Spec", card.spec.trim().length === 0 ? "No spec yet." : card.spec.trim()),
    section("Decisions", decisions),
    section("Changes so far", changes),
    brief.question === null ? "" : section("Question", brief.question),
  ];
  return {
    systemPrompt,
    firstMessage: firstMessage.filter((part) => part.length > 0).join("\n\n"),
  };
}

/** Counts files and changed lines in a unified diff. */
export function diffStatOf(diff: string): CardDiffStat {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++ ")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      deletions += 1;
    }
  }
  return { files, additions, deletions };
}

/** Card messages waiting for the owner, as the text of its next turn. */
export function renderCardMessages(
  messages: ReadonlyArray<
    Pick<ProjectionCardMessage, "messageId" | "authorKind" | "authorId" | "body" | "createdAt">
  >,
  agents: ReadonlyArray<OrchestrationAgent>,
): string {
  return messages
    .map((message) =>
      renderNewMessage({
        messageId: message.messageId,
        // A Linear comment is a person writing, from Linear.
        authorKind: message.authorKind === "linear" ? "human" : message.authorKind,
        authorName:
          message.authorKind === "agent"
            ? (agents.find((agent) => agent.id === message.authorId)?.name ?? message.authorId)
            : message.authorKind === "human"
              ? "user"
              : message.authorKind === "linear"
                ? `${message.authorId} on Linear`
                : "system",
        body: message.body,
        createdAt: message.createdAt,
      }),
    )
    .join("\n\n");
}
