/**
 * ProjectionChannelRepository - Projection repository interface for channels
 * and their append-only message history.
 *
 * @module ProjectionChannelRepository
 */
import {
  AgentId,
  ChannelId,
  ChannelKind,
  ChannelMessageAuthorKind,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationRun,
  ProjectId,
  RenderedRunContext,
  RunCapabilities,
  RunContextPayload,
  ThreadId,
} from "@t3tools/contracts";
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

/** A `projection_runs` row as selected, with its JSON columns decoded. */
export const ProjectionRunDbRow = OrchestrationRun.mapFields(
  Struct.assign({
    capabilities: Schema.fromJsonString(RunCapabilities),
    context: Schema.fromJsonString(RunContextPayload),
    rendered: Schema.fromJsonString(RenderedRunContext),
  }),
);

export const GetProjectionChannelMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionChannelMessageInput = typeof GetProjectionChannelMessageInput.Type;

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

  /** What an agent is handed on wake: the channel's newest `wakeDepth` messages, oldest first. */
  readonly listWakeHistory: (
    input: GetProjectionChannelInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannelMessage>, ProjectionRepositoryError>;
}

export class ProjectionChannelRepository extends Context.Service<
  ProjectionChannelRepository,
  ProjectionChannelRepositoryShape
>()("t3/persistence/Services/ProjectionChannels/ProjectionChannelRepository") {}
