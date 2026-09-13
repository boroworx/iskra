import {
  DEFAULT_PROJECT_RUN_CAP,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationReadModel,
  type ThreadId,
} from "@iskra/contracts";

export type WakeDecision =
  | { readonly kind: "wake"; readonly liveRunThreadId?: ThreadId }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Whether a message in `channel` may wake `agent` now. An agent has one live
 * run at a time: a wake from the same channel joins it, a wake from another
 * channel is refused so contexts never mix, and a project at its run cap starts
 * nothing new. `newRuns` counts runs the same message has already started.
 */
export function decideWake(input: {
  readonly readModel: OrchestrationReadModel;
  readonly channel: OrchestrationChannel;
  readonly agent: OrchestrationAgent;
  readonly newRuns: number;
}): WakeDecision {
  const { readModel, channel, agent } = input;
  const where = channel.kind === "dm" ? "this DM" : `#${channel.name}`;
  if (agent.archivedAt !== null || !channel.memberAgentIds.includes(agent.id)) {
    return { kind: "refuse", reason: `@${agent.name} isn't an active member of ${where}.` };
  }

  const liveRuns = readModel.liveRuns ?? [];
  const agentRun = liveRuns.find((run) => run.agentId === agent.id);
  if (agentRun !== undefined) {
    return agentRun.channelId === channel.id
      ? { kind: "wake", liveRunThreadId: agentRun.threadId }
      : { kind: "refuse", reason: `@${agent.name} is busy in another channel.` };
  }

  const projectChannelIds = new Set(
    (readModel.channels ?? [])
      .filter((candidate) => candidate.projectId === channel.projectId)
      .map((candidate) => candidate.id),
  );
  const projectRuns = liveRuns.filter((run) => projectChannelIds.has(run.channelId)).length;
  // ponytail: one fixed cap for every project; make it a project setting when a project needs another value.
  if (projectRuns + input.newRuns >= DEFAULT_PROJECT_RUN_CAP) {
    return {
      kind: "refuse",
      reason: `@${agent.name} can't start: ${DEFAULT_PROJECT_RUN_CAP} runs are already live in this project.`,
    };
  }
  return { kind: "wake" };
}
