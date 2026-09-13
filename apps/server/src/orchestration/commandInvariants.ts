import type {
  AgentId,
  ChannelId,
  OrchestrationAgent,
  OrchestrationChannel,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

function findAgentById(
  readModel: OrchestrationReadModel,
  agentId: AgentId,
): OrchestrationAgent | undefined {
  return (readModel.agents ?? []).find((agent) => agent.id === agentId);
}

export function requireAgent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly agentId: AgentId;
}): Effect.Effect<OrchestrationAgent, OrchestrationCommandInvariantError> {
  const agent = findAgentById(input.readModel, input.agentId);
  if (agent) {
    return Effect.succeed(agent);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Agent '${input.agentId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireAgentAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly agentId: AgentId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findAgentById(input.readModel, input.agentId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Agent '${input.agentId}' already exists and cannot be created twice.`,
    ),
  );
}

/** Names are `@mention` handles: unique per project, archived agents included. */
export function requireAgentNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly exceptAgentId?: AgentId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const taken = (input.readModel.agents ?? []).some(
    (agent) =>
      agent.projectId === input.projectId &&
      agent.name === input.name &&
      agent.id !== input.exceptAgentId,
  );
  if (!taken) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Agent name '${input.name}' is already taken in project '${input.projectId}'.`,
    ),
  );
}

function findChannelById(
  readModel: OrchestrationReadModel,
  channelId: ChannelId,
): OrchestrationChannel | undefined {
  return (readModel.channels ?? []).find((channel) => channel.id === channelId);
}

export function requireChannel(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly channelId: ChannelId;
}): Effect.Effect<OrchestrationChannel, OrchestrationCommandInvariantError> {
  const channel = findChannelById(input.readModel, input.channelId);
  if (channel) {
    return Effect.succeed(channel);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Channel '${input.channelId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireChannelAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly channelId: ChannelId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findChannelById(input.readModel, input.channelId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Channel '${input.channelId}' already exists and cannot be created twice.`,
    ),
  );
}

/**
 * Members are active agents of the channel's project, listed once. A DM has
 * exactly one agent, and an agent has at most one active DM.
 */
export function requireValidChannelMembers(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly kind: OrchestrationChannel["kind"];
  readonly memberAgentIds: ReadonlyArray<AgentId>;
  readonly exceptChannelId?: ChannelId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (new Set(input.memberAgentIds).size !== input.memberAgentIds.length) {
    return Effect.fail(invariantError(input.command.type, "Channel members must be unique."));
  }
  for (const agentId of input.memberAgentIds) {
    const agent = findAgentById(input.readModel, agentId);
    if (!agent || agent.projectId !== input.projectId || agent.archivedAt !== null) {
      return Effect.fail(
        invariantError(
          input.command.type,
          `Agent '${agentId}' is not an active agent of project '${input.projectId}'.`,
        ),
      );
    }
  }
  if (input.kind !== "dm") {
    return Effect.void;
  }
  const [agentId, ...rest] = input.memberAgentIds;
  if (agentId === undefined || rest.length > 0) {
    return Effect.fail(
      invariantError(input.command.type, "A DM channel must have exactly one agent member."),
    );
  }
  const existingDm = (input.readModel.channels ?? []).find(
    (channel) =>
      channel.kind === "dm" &&
      channel.archivedAt === null &&
      channel.id !== input.exceptChannelId &&
      channel.memberAgentIds.includes(agentId),
  );
  if (existingDm === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Agent '${agentId}' already has DM channel '${existingDm.id}'.`,
    ),
  );
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Thread deletion is a soft delete and a draft keeps its client-minted id
  // across retries, so only a live row blocks creation. Projectors reset the
  // thread's rows when the id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}
