import type { AgentId, OrchestrationAgent } from "@iskra/contracts";

// `@name` at the start of the text or after a non-word character, so an email
// address such as `dev@backend.io` is not a mention.
const MENTION_PATTERN = /(^|[^\w@])@([a-z0-9-]+)/gi;

/**
 * The agents a message addresses, in order of first mention. Names match
 * case-insensitively; unknown names are plain text. Membership, archiving and
 * busy agents are routing concerns, not parsing ones.
 */
export function parseMentions(
  body: string,
  agents: ReadonlyArray<Pick<OrchestrationAgent, "id" | "name">>,
): ReadonlyArray<AgentId> {
  const mentioned: AgentId[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[2]?.toLowerCase();
    const agent = agents.find((candidate) => candidate.name === name);
    if (agent && !mentioned.includes(agent.id)) {
      mentioned.push(agent.id);
    }
  }
  return mentioned;
}
