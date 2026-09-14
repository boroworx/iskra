import {
  DEFAULT_PROJECT_RUN_CAP,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationReadModel,
  type ProjectId,
  type ThreadId,
} from "@iskra/contracts";

export type WakeDecision =
  | { readonly kind: "wake"; readonly liveRunThreadId?: ThreadId }
  | { readonly kind: "refuse"; readonly reason: string };

/** Live sessions in a project: its channels' conversations and its cards' sessions. */
export function projectLiveRunCount(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): number {
  const channelIds = new Set(
    (readModel.channels ?? [])
      .filter((channel) => channel.projectId === projectId)
      .map((channel) => channel.id),
  );
  const cardIds = new Set(
    (readModel.cards ?? []).filter((card) => card.projectId === projectId).map((card) => card.id),
  );
  return (readModel.liveRuns ?? []).filter(
    (run) =>
      (run.channelId !== null && channelIds.has(run.channelId)) ||
      (run.cardId !== null && cardIds.has(run.cardId)),
  ).length;
}

/**
 * Whether a message in `channel` may wake `agent` now. An agent has one live
 * conversation at a time: a wake from the same channel joins it, a wake from
 * another channel is refused so contexts never mix, and a project at its cap
 * of live sessions (card sessions included) starts nothing new. `newRuns`
 * counts runs the same message has already started.
 */
export function decideWake(input: {
  readonly readModel: OrchestrationReadModel;
  readonly channel: OrchestrationChannel;
  readonly agent: OrchestrationAgent;
  readonly newRuns: number;
}): WakeDecision {
  const { readModel, channel, agent } = input;
  const where = channel.kind === "dm" ? "this DM" : `#${channel.name}`;
  // A channel's lead is woken there without being a member.
  const belongs = channel.memberAgentIds.includes(agent.id) || channel.leadAgentId === agent.id;
  if (agent.archivedAt !== null || !belongs) {
    return { kind: "refuse", reason: `@${agent.name} isn't an active member of ${where}.` };
  }

  const agentRun = (readModel.liveRuns ?? []).find(
    (run) => run.agentId === agent.id && run.channelId !== null,
  );
  if (agentRun !== undefined) {
    return agentRun.channelId === channel.id
      ? { kind: "wake", liveRunThreadId: agentRun.threadId }
      : { kind: "refuse", reason: `@${agent.name} is busy in another channel.` };
  }

  const projectRuns = projectLiveRunCount(readModel, channel.projectId);
  // ponytail: one fixed cap for every project; make it a project setting when a project needs another value.
  if (projectRuns + input.newRuns >= DEFAULT_PROJECT_RUN_CAP) {
    return {
      kind: "refuse",
      reason: `@${agent.name} can't start: ${DEFAULT_PROJECT_RUN_CAP} runs are already live in this project.`,
    };
  }
  return { kind: "wake" };
}
