import {
  AgentId,
  CardId,
  ChannelId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CardSessionRole,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type RunCapability,
} from "@iskra/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

// Fixtures shared by the decider.*.test.ts suites. Every builder mints a fresh command id.

export const now = "2026-01-01T00:00:00.000Z";
export const projectId = ProjectId.make("project-decider");
export const cardId = CardId.make("card-limits");
export const backend = AgentId.make("agent-backend");
export const frontend = AgentId.make("agent-frontend");
export const reviewer = AgentId.make("agent-reviewer");
export const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};

let commandCount = 0;
export const nextCommandId = () => CommandId.make(`cmd-${(commandCount += 1)}`);

/** Decides one command, always as a list of planned events. */
export const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

/** Decides and projects each command in order, like the engine does for one batch. */
export const applyTo = Effect.fn("applyTo")(function* (
  initial: OrchestrationReadModel,
  commands: ReadonlyArray<OrchestrationCommand>,
) {
  let readModel = initial;
  for (const command of commands) {
    for (const event of yield* decide(readModel, command)) {
      readModel = yield* projectEvent(readModel, {
        ...event,
        sequence: readModel.snapshotSequence + 1,
      });
    }
  }
  return readModel;
});

export const applyCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  applyTo(createEmptyReadModel(now), commands);

export const cardIn = (readModel: OrchestrationReadModel, id: string = cardId) =>
  readModel.cards?.find((card) => card.id === id);

export const createProject = (id: ProjectId = projectId): OrchestrationCommand => ({
  type: "project.create",
  commandId: nextCommandId(),
  projectId: id,
  title: id,
  workspaceRoot: `/tmp/${id}`,
  createdAt: now,
});

export const createAgent = (
  agentId: AgentId,
  options: {
    readonly name?: string;
    readonly capabilities?: ReadonlyArray<RunCapability>;
    readonly projectId?: ProjectId;
  } = {},
): OrchestrationCommand => ({
  type: "agent.create",
  commandId: nextCommandId(),
  agentId,
  projectId: options.projectId ?? projectId,
  name: options.name ?? agentId.replace(/^agent-/, ""),
  roleTags: [],
  rolePrompt: "",
  modelSelection,
  capabilities: options.capabilities ?? ["read", "write"],
  createdAt: now,
});

export const createCard = (
  id: string = cardId,
  fields: {
    readonly spec?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly parentCardId?: string;
    readonly projectId?: ProjectId;
  } = {},
): OrchestrationCommand => ({
  type: "card.create",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  projectId: fields.projectId ?? projectId,
  ...(fields.parentCardId === undefined ? {} : { parentCardId: CardId.make(fields.parentCardId) }),
  title: "Rate limiting",
  spec: fields.spec ?? "",
  tags: fields.tags ?? [],
  // Approving the card confirms these, so work can start on it.
  criteria: [{ id: "limit", text: "Each API key gets 100 requests a minute.", verification: "automated" }],
  createdAt: now,
});

/** A person reviewing the project's side-effect guard, which owner sessions wait for. */
export const guardProject = (id: ProjectId = projectId): OrchestrationCommand => ({
  type: "project.orchestration.set",
  commandId: nextCommandId(),
  projectId: id,
  orchestration: {
    ...DEFAULT_PROJECT_ORCHESTRATION,
    sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
  },
});

type CardOnlyCommandType =
  | "card.approve"
  | "card.unapprove"
  | "card.merge.approve"
  | "card.merge.cancel"
  | "card.abandon"
  | "card.reopen"
  | "card.unassign"
  | "card.work.start"
  | "card.review.request"
  | "card.land"
  | "card.attempt.promote"
  | "card.spec.approve"
  | "card.spec.skip"
  | "card.spec.reopen"
  | "card.unpriced.accept"
  | "card.unpriced.refuse"
  | "card.unsnooze"
  | "card.criteria.confirm"
  | "card.fix-rounds.reset"
  | "card.pause"
  | "card.resume";

/** A command that names nothing but its card. */
export const onCard = (type: CardOnlyCommandType, id: string = cardId) =>
  ({ type, commandId: nextCommandId(), cardId: CardId.make(id) }) as OrchestrationCommand;

export const assign = (agentId: AgentId, id: string = cardId): OrchestrationCommand => ({
  type: "card.assign",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  agentId,
});

export const setWorkspace = (id: string = cardId): OrchestrationCommand => ({
  type: "card.workspace.set",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  branch: `iskra/${id}`,
  worktreePath: `/tmp/worktrees/${id}`,
  portBase: 42000,
});

/** A card taken through approval, assignment and work into review. */
export const cardInReview = (id: string): ReadonlyArray<OrchestrationCommand> => [
  createCard(id),
  onCard("card.approve", id),
  assign(backend, id),
  onCard("card.work.start", id),
  onCard("card.review.request", id),
];

export const recordSession = (
  threadId: string,
  agentId: AgentId,
  role: CardSessionRole = "owner",
  capabilities: ReadonlyArray<RunCapability> = ["read", "write"],
  id: CardId = cardId,
): OrchestrationCommand => ({
  type: "card.session.record",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  cardId: id,
  agentId,
  role,
  capabilities,
  context: {
    agent: { id: agentId, name: "agent", rolePrompt: "" },
    role,
    card: { id, title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
    decisions: [],
    diff: "",
    diffTruncated: false,
    question: null,
  },
  rendered: { systemPrompt: "system", firstMessage: "brief" },
  startedAt: now,
});

export const createThread = (threadId: string): OrchestrationCommand => ({
  type: "thread.create",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  projectId,
  title: "Session",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
});

/** Sets a thread's provider session; a turn id means it is mid-turn. */
export const setSession = (
  threadId: string,
  status: "ready" | "running" | "stopped",
  turnId: string | null = null,
): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  session: {
    threadId: ThreadId.make(threadId),
    status,
    providerName: "claudeAgent",
    runtimeMode: "approval-required",
    activeTurnId: turnId === null ? null : TurnId.make(turnId),
    lastError: null,
    updatedAt: now,
  },
  createdAt: now,
});

export const startTurn = (threadId: string): OrchestrationCommand => {
  const commandId = nextCommandId();
  return {
    type: "thread.turn.start",
    commandId,
    threadId: ThreadId.make(threadId),
    message: {
      messageId: MessageId.make(`message-${commandId}`),
      role: "user",
      text: "Keep going.",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: now,
  };
};

export const createChannel = (
  id: string,
  kind: "channel" | "dm",
  memberAgentIds: ReadonlyArray<AgentId>,
  leadAgentId?: AgentId,
): OrchestrationCommand => ({
  type: "channel.create",
  commandId: nextCommandId(),
  channelId: ChannelId.make(id),
  projectId,
  kind,
  name: id,
  memberAgentIds,
  ...(leadAgentId === undefined ? {} : { leadAgentId }),
  createdAt: now,
});

export const postMessage = (channelId: string, body: string): OrchestrationCommand => {
  const commandId = nextCommandId();
  return {
    type: "channel.message.post",
    commandId,
    channelId: ChannelId.make(channelId),
    messageId: MessageId.make(`message-${commandId}`),
    body,
    createdAt: now,
  };
};

export const startChannelRun = (
  agentId: AgentId,
  channelId: string,
  threadId: string,
  capabilities: ReadonlyArray<RunCapability> = ["read"],
): OrchestrationCommand => {
  const trigger = {
    messageId: MessageId.make("message-trigger"),
    authorKind: "human" as const,
    authorName: "user",
    body: "hi",
    createdAt: now,
  };
  return {
    type: "channel.run.start",
    commandId: nextCommandId(),
    threadId: ThreadId.make(threadId),
    channelId: ChannelId.make(channelId),
    agentId,
    triggerMessageId: trigger.messageId,
    capabilities,
    context: {
      agent: { id: agentId, name: "agent", rolePrompt: "" },
      channel: { id: ChannelId.make(channelId), kind: "channel", name: channelId, topic: "" },
      pinnedSpec: "",
      wakeDepth: 30,
      history: [],
      trigger,
    },
    rendered: { systemPrompt: "system", firstMessage: "hi" },
    startedAt: now,
  };
};
