import {
  CommandId,
  MessageId,
  ThreadId,
  type CardBriefPayload,
  type CardSessionRole,
  type ModelSelection,
  type OrchestrationAgent,
  type OrchestrationCard,
  type OrchestrationCommand,
  type RenderedRunContext,
  type RunCapabilities,
} from "@iskra/contracts";

/** Everything one card run starts from: the card and agent, what it may do and the brief it is handed. */
export interface CardRunStart {
  // Ids derive from the key, so a retried request cannot start a second run.
  readonly key: string;
  readonly card: Pick<OrchestrationCard, "id" | "title" | "projectId" | "branch" | "worktreePath">;
  readonly agent: Pick<OrchestrationAgent, "id" | "name">;
  readonly role: CardSessionRole;
  // Usually the agent's own; a verifier may run its template on another model.
  readonly modelSelection: ModelSelection;
  readonly capabilities: RunCapabilities;
  readonly context: CardBriefPayload;
  readonly rendered: RenderedRunContext;
  readonly restarts: number;
  readonly startedAt: string;
}

const RUN_TITLE: Record<CardSessionRole, (agent: string, card: string) => string> = {
  owner: (agent, card) => `@${agent} on ${card}`,
  helper: (agent, card) => `@${agent} helping on ${card}`,
  critic: (agent, card) => `@${agent} reviewing ${card}`,
  verifier: (agent, card) => `@${agent} verifying ${card}`,
};

/** The hidden thread a card run with this key lives in. */
export const cardRunThreadId = (key: string) => ThreadId.make(`card-session-${key}`);

/**
 * The commands that start a card run, dispatched in order: its record, its hidden thread in the
 * card's worktree and its first turn carrying the brief.
 */
export function cardRunStartCommands(input: CardRunStart): ReadonlyArray<OrchestrationCommand> {
  const threadId = cardRunThreadId(input.key);
  return [
    {
      type: "card.session.record",
      commandId: CommandId.make(`card-session-record:${input.key}`),
      threadId,
      cardId: input.card.id,
      agentId: input.agent.id,
      role: input.role,
      capabilities: input.capabilities,
      context: input.context,
      rendered: input.rendered,
      ...(input.restarts > 0 ? { restarts: input.restarts } : {}),
      startedAt: input.startedAt,
    },
    {
      type: "thread.create",
      commandId: CommandId.make(`card-session-thread:${input.key}`),
      threadId,
      projectId: input.card.projectId,
      title: RUN_TITLE[input.role](input.agent.name, input.card.title),
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: input.card.branch,
      worktreePath: input.card.worktreePath,
      createdAt: input.startedAt,
    },
    {
      type: "thread.turn.start",
      commandId: CommandId.make(`card-session-turn:${input.key}`),
      threadId,
      message: {
        messageId: MessageId.make(`card-session-message:${threadId}`),
        role: "user",
        text: input.rendered.firstMessage,
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: input.startedAt,
    },
  ];
}
