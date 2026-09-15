import {
  projectOrchestrationOf,
  projectSpendOf,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ProjectId,
  type ThreadId,
} from "@iskra/contracts";

import { budgetWaitReason } from "./cardRules.ts";

export type WakeDecision =
  | { readonly kind: "wake"; readonly liveRunThreadId?: ThreadId }
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
 * Whether a message in `channel` may wake `agent` now. Each channel or DM gets its own run of the
 * agent: a wake joins the agent's live run in the same channel, anywhere else it starts another
 * instance, and a project at its own session cap (card sessions included) starts nothing new.
 * `newRuns` counts runs the same message has already started. The machine's cap is RunReactor's:
 * a wake past it waits for a slot instead of being refused.
 */
export function decideWake(input: {
  readonly readModel: OrchestrationReadModel;
  readonly channel: OrchestrationChannel;
  readonly agent: OrchestrationAgent;
  readonly newRuns: number;
  /** When the wake happens, which picks the month whose spend counts against the budgets. */
  readonly now: string;
}): WakeDecision {
  const { readModel, channel, agent } = input;
  const where =
    channel.kind === "dm"
      ? "this DM"
      : channel.kind === "requests"
        ? "Requests"
        : `#${channel.name}`;
  // A channel's lead is woken there without being a member.
  const belongs = channel.memberAgentIds.includes(agent.id) || channel.leadAgentId === agent.id;
  if (agent.archivedAt !== null || !belongs) {
    return { kind: "refuse", reason: `@${agent.name} isn't an active member of ${where}.` };
  }
  // A project or agent past its monthly budget takes no new turns, joined run or not.
  const project = readModel.projects.find((candidate) => candidate.id === channel.projectId) ?? {};
  const overBudget = budgetWaitReason(
    projectOrchestrationOf(project),
    projectSpendOf(project, input.now),
    agent,
  );
  if (overBudget !== null) {
    return { kind: "refuse", reason: overBudget.text };
  }

  const agentRun = (readModel.liveRuns ?? []).find(
    (run) => run.agentId === agent.id && run.channelId === channel.id,
  );
  if (agentRun !== undefined) {
    return { kind: "wake", liveRunThreadId: agentRun.threadId };
  }

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
