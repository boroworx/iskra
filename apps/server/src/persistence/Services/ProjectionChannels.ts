/**
 * ProjectionChannelRepository - Projection repository interface for channels
 * and their append-only message history.
 *
 * @module ProjectionChannelRepository
 */
import {
  AgentId,
  ChannelDeliveryStatus,
  ChannelId,
  ChannelKind,
  ChannelMessageAuthorKind,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  type OrchestrationChannelMessage,
  OrchestrationChannelShell,
  OrchestrationAgentRun,
  OrchestrationLiveRun,
  OrchestrationRun,
  ProjectId,
  RenderedRunContext,
  RunCapabilities,
  ThreadId,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionChannel = Schema.Struct({
  channelId: ChannelId,
  projectId: ProjectId,
  kind: ChannelKind,
  name: Schema.String,
  topic: Schema.String,
  pinnedSpec: Schema.String,
  wakeDepth: NonNegativeInt,
  memberAgentIds: Schema.Array(AgentId),
  leadAgentId: Schema.NullOr(AgentId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionChannel = typeof ProjectionChannel.Type;

/** A `projection_channels` row as selected, with its JSON columns decoded. */
export const ProjectionChannelDbRow = ProjectionChannel.mapFields(
  Struct.assign({
    memberAgentIds: Schema.fromJsonString(Schema.Array(AgentId)),
  }),
);

/** An active channel as clients list it. */
export const ProjectionChannelShellDbRow = OrchestrationChannelShell.mapFields(
  Struct.assign({
    memberAgentIds: Schema.fromJsonString(Schema.Array(AgentId)),
  }),
);

export const ProjectionChannelMessage = Schema.Struct({
  messageId: MessageId,
  channelId: ChannelId,
  sequence: NonNegativeInt,
  authorKind: ChannelMessageAuthorKind,
  authorId: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
  runThreadId: Schema.NullOr(ThreadId),
});
export type ProjectionChannelMessage = typeof ProjectionChannelMessage.Type;

/** A stored message as clients and agents see it. */
export function toOrchestrationChannelMessage(
  row: ProjectionChannelMessage,
): OrchestrationChannelMessage {
  return {
    id: row.messageId,
    channelId: row.channelId,
    authorKind: row.authorKind,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
    ...(row.runThreadId !== null ? { runThreadId: row.runThreadId } : {}),
  };
}

/** A `projection_runs` row as selected, with its JSON columns decoded. */
export const ProjectionRunDbRow = OrchestrationRun.mapFields(
  Struct.assign({
    capabilities: Schema.fromJsonString(RunCapabilities),
    context: Schema.fromJsonString(OrchestrationRun.fields.context),
    rendered: Schema.fromJsonString(RenderedRunContext),
  }),
);

/** A `projection_runs` row with its end time, JSON columns decoded. */
export const ProjectionAgentRunDbRow = OrchestrationAgentRun.mapFields(
  Struct.assign({
    capabilities: Schema.fromJsonString(RunCapabilities),
    context: Schema.fromJsonString(OrchestrationRun.fields.context),
    rendered: Schema.fromJsonString(RenderedRunContext),
  }),
);

export const GetProjectionChannelMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionChannelMessageInput = typeof GetProjectionChannelMessageInput.Type;

/** A live run row as selected; it has no JSON columns. */
export const ProjectionLiveRunDbRow = OrchestrationLiveRun;

export const EndProjectionRunInput = Schema.Struct({
  threadId: ThreadId,
  endedAt: IsoDateTime,
});
export type EndProjectionRunInput = typeof EndProjectionRunInput.Type;

/** A message's standing with one agent it woke. */
export const ProjectionChannelDelivery = Schema.Struct({
  messageId: MessageId,
  agentId: AgentId,
  channelId: ChannelId,
  runThreadId: Schema.NullOr(ThreadId),
  status: ChannelDeliveryStatus,
  updatedAt: IsoDateTime,
});
export type ProjectionChannelDelivery = typeof ProjectionChannelDelivery.Type;

export const UpdateProjectionChannelDeliveriesInput = Schema.Struct({
  messageIds: Schema.Array(MessageId),
  agentId: AgentId,
  channelId: ChannelId,
  runThreadId: Schema.NullOr(ThreadId),
  status: ChannelDeliveryStatus,
  updatedAt: IsoDateTime,
});
export type UpdateProjectionChannelDeliveriesInput =
  typeof UpdateProjectionChannelDeliveriesInput.Type;

export const ListOpenProjectionChannelDeliveriesInput = Schema.Struct({
  agentId: AgentId,
  channelId: ChannelId,
});
export type ListOpenProjectionChannelDeliveriesInput =
  typeof ListOpenProjectionChannelDeliveriesInput.Type;

/** A message still waiting on an agent: its delivery status and run, with the message itself. */
export const ProjectionOpenChannelDelivery = Schema.Struct({
  ...ProjectionChannelMessage.fields,
  status: ChannelDeliveryStatus,
  deliveryRunThreadId: Schema.NullOr(ThreadId),
});
export type ProjectionOpenChannelDelivery = typeof ProjectionOpenChannelDelivery.Type;

export const GetProjectionChannelInput = Schema.Struct({
  channelId: ChannelId,
});
export type GetProjectionChannelInput = typeof GetProjectionChannelInput.Type;

export const ListProjectionChannelMessagesInput = Schema.Struct({
  channelId: ChannelId,
  beforeSequence: Schema.optional(NonNegativeInt),
  limit: NonNegativeInt,
});
export type ListProjectionChannelMessagesInput = typeof ListProjectionChannelMessagesInput.Type;

export interface ProjectionChannelRepositoryShape {
  /** Insert or replace a projected channel row by `channelId`. */
  readonly upsertChannel: (
    row: ProjectionChannel,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Read a projected channel row by id. */
  readonly getChannelById: (
    input: GetProjectionChannelInput,
  ) => Effect.Effect<Option.Option<ProjectionChannel>, ProjectionRepositoryError>;

  /** Append a message. Replaying an already-projected message is a no-op. */
  readonly appendMessage: (
    row: ProjectionChannelMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** The newest `limit` messages before `beforeSequence` (or the end), oldest first. */
  readonly listMessages: (
    input: ListProjectionChannelMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannelMessage>, ProjectionRepositoryError>;

  /** Read one channel message by id. */
  readonly getMessageById: (
    input: GetProjectionChannelMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionChannelMessage>, ProjectionRepositoryError>;

  /** Record a started run. Replaying an already-projected run is a no-op. */
  readonly insertRun: (row: OrchestrationRun) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Mark a run ended. Ending a thread that is not a live run is a no-op. */
  readonly endRun: (input: EndProjectionRunInput) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Record a message's standing with an agent, replacing any earlier one. */
  readonly upsertDelivery: (
    row: ProjectionChannelDelivery,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Give an agent's deliveries of these messages a new status and run. */
  readonly updateDeliveries: (
    input: UpdateProjectionChannelDeliveriesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** An agent's pending and sent deliveries in a channel, oldest message first. */
  readonly listOpenDeliveries: (
    input: ListOpenProjectionChannelDeliveriesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionOpenChannelDelivery>, ProjectionRepositoryError>;

  /** What an agent is handed on wake: the channel's newest `wakeDepth` messages, oldest first. */
  readonly listWakeHistory: (
    input: GetProjectionChannelInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannelMessage>, ProjectionRepositoryError>;
}

export class ProjectionChannelRepository extends Context.Service<
  ProjectionChannelRepository,
  ProjectionChannelRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionChannels/ProjectionChannelRepository") {}
