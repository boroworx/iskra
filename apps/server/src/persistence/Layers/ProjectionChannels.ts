import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionChannelInput,
  ListProjectionChannelMessagesInput,
  ProjectionChannel,
  ProjectionChannelDbRow,
  ProjectionChannelMessage,
  ProjectionChannelRepository,
  type ProjectionChannelRepositoryShape,
} from "../Services/ProjectionChannels.ts";

const makeProjectionChannelRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertChannelRow = SqlSchema.void({
    Request: ProjectionChannel,
    execute: (row) =>
      sql`
        INSERT INTO projection_channels (
          channel_id,
          project_id,
          kind,
          name,
          topic,
          pinned_spec,
          wake_depth,
          member_agent_ids_json,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${row.channelId},
          ${row.projectId},
          ${row.kind},
          ${row.name},
          ${row.topic},
          ${row.pinnedSpec},
          ${row.wakeDepth},
          ${JSON.stringify(row.memberAgentIds)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt}
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          kind = excluded.kind,
          name = excluded.name,
          topic = excluded.topic,
          pinned_spec = excluded.pinned_spec,
          wake_depth = excluded.wake_depth,
          member_agent_ids_json = excluded.member_agent_ids_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `,
  });

  const getChannelRow = SqlSchema.findOneOption({
    Request: GetProjectionChannelInput,
    Result: ProjectionChannelDbRow,
    execute: ({ channelId }) =>
      sql`
        SELECT
          channel_id AS "channelId",
          project_id AS "projectId",
          kind,
          name,
          topic,
          pinned_spec AS "pinnedSpec",
          wake_depth AS "wakeDepth",
          member_agent_ids_json AS "memberAgentIds",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM projection_channels
        WHERE channel_id = ${channelId}
      `,
  });

  const appendMessageRow = SqlSchema.void({
    Request: ProjectionChannelMessage,
    execute: (row) =>
      sql`
        INSERT INTO projection_channel_messages (
          message_id,
          channel_id,
          sequence,
          author_kind,
          author_id,
          body,
          created_at
        )
        VALUES (
          ${row.messageId},
          ${row.channelId},
          ${row.sequence},
          ${row.authorKind},
          ${row.authorId},
          ${row.body},
          ${row.createdAt}
        )
        ON CONFLICT (message_id) DO NOTHING
      `,
  });

  const listMessageRows = SqlSchema.findAll({
    Request: ListProjectionChannelMessagesInput,
    Result: ProjectionChannelMessage,
    execute: ({ channelId, beforeSequence, limit }) =>
      sql`
        SELECT
          message_id AS "messageId",
          channel_id AS "channelId",
          sequence,
          author_kind AS "authorKind",
          author_id AS "authorId",
          body,
          created_at AS "createdAt"
        FROM projection_channel_messages
        WHERE channel_id = ${channelId}
          AND ${beforeSequence === undefined ? sql`1 = 1` : sql`sequence < ${beforeSequence}`}
        ORDER BY sequence DESC
        LIMIT ${limit}
      `,
  });

  const listWakeHistoryRows = SqlSchema.findAll({
    Request: GetProjectionChannelInput,
    Result: ProjectionChannelMessage,
    execute: ({ channelId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          channel_id AS "channelId",
          sequence,
          author_kind AS "authorKind",
          author_id AS "authorId",
          body,
          created_at AS "createdAt"
        FROM projection_channel_messages
        WHERE channel_id = ${channelId}
        ORDER BY sequence DESC
        LIMIT COALESCE(
          (SELECT wake_depth FROM projection_channels WHERE channel_id = ${channelId}),
          0
        )
      `,
  });

  const upsertChannel: ProjectionChannelRepositoryShape["upsertChannel"] = (row) =>
    upsertChannelRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.upsertChannel:query")),
    );

  const getChannelById: ProjectionChannelRepositoryShape["getChannelById"] = (input) =>
    getChannelRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.getChannelById:query")),
    );

  const appendMessage: ProjectionChannelRepositoryShape["appendMessage"] = (row) =>
    appendMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.appendMessage:query")),
    );

  const listMessages: ProjectionChannelRepositoryShape["listMessages"] = (input) =>
    listMessageRows(input).pipe(
      Effect.map((rows) => rows.toReversed()),
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.listMessages:query")),
    );

  const listWakeHistory: ProjectionChannelRepositoryShape["listWakeHistory"] = (input) =>
    listWakeHistoryRows(input).pipe(
      Effect.map((rows) => rows.toReversed()),
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.listWakeHistory:query")),
    );

  return {
    upsertChannel,
    getChannelById,
    appendMessage,
    listMessages,
    listWakeHistory,
  } satisfies ProjectionChannelRepositoryShape;
});

export const ProjectionChannelRepositoryLive = Layer.effect(
  ProjectionChannelRepository,
  makeProjectionChannelRepository,
);
