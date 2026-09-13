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
  ProjectId,
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
});
export type ProjectionChannelMessage = typeof ProjectionChannelMessage.Type;

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

  /** What an agent is handed on wake: the channel's newest `wakeDepth` messages, oldest first. */
  readonly listWakeHistory: (
    input: GetProjectionChannelInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionChannelMessage>, ProjectionRepositoryError>;
}

export class ProjectionChannelRepository extends Context.Service<
  ProjectionChannelRepository,
  ProjectionChannelRepositoryShape
>()("t3/persistence/Services/ProjectionChannels/ProjectionChannelRepository") {}
