import {
  projectOrchestrationOf,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ProjectId,
  type ThreadId,
} from "@iskra/contracts";

export type WakeDecision =
  | { readonly kind: "wake"; readonly liveRunThreadId?: ThreadId }
  | { readonly kind: "queue" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Whether a session uses compute now: starting, or in a turn (waiting on a person included). A
 * settled session waits idle and holds no slot.
 */
export const holdsSlot = (
  session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null | undefined,
): boolean =>
  session == null ||
  session.status === "starting" ||
  session.status === "running" ||
  session.activeTurnId !== null;

/** Live runs holding a slot, each with the project it counts against. */
export function busyRunsOf(readModel: OrchestrationReadModel) {
  const sessions = new Map(readModel.threads.map((thread) => [thread.id, thread.session] as const));
  const projectOfChannel = new Map(
    (readModel.channels ?? []).map((channel) => [channel.id, channel.projectId] as const),
  );
  const projectOfCard = new Map(
    (readModel.cards ?? []).map((card) => [card.id, card.projectId] as const),
  );
  return (readModel.liveRuns ?? []).flatMap((run) => {
    const projectId =
      run.cardId !== null
        ? projectOfCard.get(run.cardId)
        : run.channelId !== null
          ? projectOfChannel.get(run.channelId)
          : undefined;
    return projectId !== undefined && holdsSlot(sessions.get(run.threadId))
      ? [{ ...run, projectId }]
      : [];
  });
}

/** Sessions holding a slot in a project: its channels' conversations and its cards' sessions. */
export function projectLiveRunCount(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): number {
  return busyRunsOf(readModel).filter((run) => run.projectId === projectId).length;
}

/**
 * Whether a message in `channel` may wake `agent` now. An agent has one live
 * conversation at a time: a wake from the same channel joins it, a wake from
 * another channel is refused so contexts never mix (a DM instead queues until
 * that conversation ends), and a project at its own session cap (card sessions
 * included) starts nothing new. `newRuns` counts runs the same message has
 * already started.
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
    if (agentRun.channelId === channel.id) {
      return { kind: "wake", liveRunThreadId: agentRun.threadId };
    }
    return channel.kind === "dm"
      ? { kind: "queue" }
      : { kind: "refuse", reason: `@${agent.name} is busy in another channel.` };
  }

  // The environment's cap is machine-local and the card scheduler's; a wake only meets the project's.
  const { sessionCap } = projectOrchestrationOf(
    readModel.projects.find((project) => project.id === channel.projectId) ?? {},
  );
  if (
    sessionCap !== null &&
    projectLiveRunCount(readModel, channel.projectId) + input.newRuns >= sessionCap
  ) {
    return {
      kind: "refuse",
      reason: `@${agent.name} can't start: ${sessionCap} runs are already live in this project.`,
    };
  }
  return { kind: "wake" };
}
