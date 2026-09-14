import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import { OrchestrationRun } from "@iskra/contracts";

import {
  EndProjectionRunInput,
  GetProjectionChannelInput,
  GetProjectionChannelMessageInput,
  ListOpenProjectionChannelDeliveriesInput,
  ListProjectionChannelMessagesInput,
  ProjectionChannel,
  ProjectionChannelDbRow,
  ProjectionChannelDelivery,
  ProjectionChannelMessage,
  ProjectionChannelRepository,
  ProjectionOpenChannelDelivery,
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
          lead_agent_id,
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
          ${row.leadAgentId},
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
          lead_agent_id = excluded.lead_agent_id,
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
          lead_agent_id AS "leadAgentId",
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
          created_at,
          run_thread_id
        )
        VALUES (
          ${row.messageId},
          ${row.channelId},
          ${row.sequence},
          ${row.authorKind},
          ${row.authorId},
          ${row.body},
          ${row.createdAt},
          ${row.runThreadId}
        )
        ON CONFLICT (message_id) DO NOTHING
      `,
  });

  const getMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionChannelMessageInput,
    Result: ProjectionChannelMessage,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          channel_id AS "channelId",
          sequence,
          author_kind AS "authorKind",
          author_id AS "authorId",
          body,
          created_at AS "createdAt",
          run_thread_id AS "runThreadId"
        FROM projection_channel_messages
        WHERE message_id = ${messageId}
      `,
  });

  const insertRunRow = SqlSchema.void({
    Request: OrchestrationRun,
    execute: (row) =>
      sql`
        INSERT INTO projection_runs (
          thread_id,
          role,
          channel_id,
          card_id,
          agent_id,
          trigger_message_id,
          capabilities_json,
          context_json,
          rendered_json,
          started_at
        )
        VALUES (
          ${row.threadId},
          ${row.role},
          ${row.channelId},
          ${row.cardId},
          ${row.agentId},
          ${row.triggerMessageId},
          ${JSON.stringify(row.capabilities)},
          ${JSON.stringify(row.context)},
          ${JSON.stringify(row.rendered)},
          ${row.startedAt}
        )
        ON CONFLICT (thread_id) DO NOTHING
      `,
  });

  const endRunRow = SqlSchema.void({
    Request: EndProjectionRunInput,
    execute: ({ threadId, endedAt }) =>
      sql`
        UPDATE projection_runs
        SET ended_at = ${endedAt}
        WHERE thread_id = ${threadId}
          AND ended_at IS NULL
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
          created_at AS "createdAt",
          run_thread_id AS "runThreadId"
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
          created_at AS "createdAt",
          run_thread_id AS "runThreadId"
        FROM projection_channel_messages
        WHERE channel_id = ${channelId}
        ORDER BY sequence DESC
        LIMIT COALESCE(
          (SELECT wake_depth FROM projection_channels WHERE channel_id = ${channelId}),
          0
        )
      `,
  });

  const upsertDeliveryRow = SqlSchema.void({
    Request: ProjectionChannelDelivery,
    execute: (row) =>
      sql`
        INSERT INTO projection_channel_deliveries (
          message_id,
          agent_id,
          channel_id,
          run_thread_id,
          status,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.agentId},
          ${row.channelId},
          ${row.runThreadId},
          ${row.status},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id, agent_id)
        DO UPDATE SET
          channel_id = excluded.channel_id,
          run_thread_id = excluded.run_thread_id,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
  });

  const listOpenDeliveryRows = SqlSchema.findAll({
    Request: ListOpenProjectionChannelDeliveriesInput,
    Result: ProjectionOpenChannelDelivery,
    execute: ({ agentId, channelId }) =>
      sql`
        SELECT
          messages.message_id AS "messageId",
          messages.channel_id AS "channelId",
          messages.sequence,
          messages.author_kind AS "authorKind",
          messages.author_id AS "authorId",
          messages.body,
          messages.created_at AS "createdAt",
          messages.run_thread_id AS "runThreadId",
          deliveries.status,
          deliveries.run_thread_id AS "deliveryRunThreadId"
        FROM projection_channel_deliveries AS deliveries
        INNER JOIN projection_channel_messages AS messages
          ON messages.message_id = deliveries.message_id
        WHERE deliveries.agent_id = ${agentId}
          AND deliveries.channel_id = ${channelId}
          AND deliveries.status IN ('pending', 'sent')
        ORDER BY messages.sequence ASC
      `,
  });

  const upsertDelivery: ProjectionChannelRepositoryShape["upsertDelivery"] = (row) =>
    upsertDeliveryRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.upsertDelivery:query")),
    );

  const updateDeliveries: ProjectionChannelRepositoryShape["updateDeliveries"] = ({
    messageIds,
    ...delivery
  }) =>
    Effect.forEach(messageIds, (messageId) => upsertDeliveryRow({ ...delivery, messageId }), {
      discard: true,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.updateDeliveries:query")),
    );

  const listOpenDeliveries: ProjectionChannelRepositoryShape["listOpenDeliveries"] = (input) =>
    listOpenDeliveryRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionChannelRepository.listOpenDeliveries:query"),
      ),
    );

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

  const getMessageById: ProjectionChannelRepositoryShape["getMessageById"] = (input) =>
    getMessageRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.getMessageById:query")),
    );

  const insertRun: ProjectionChannelRepositoryShape["insertRun"] = (row) =>
    insertRunRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.insertRun:query")),
    );

  const endRun: ProjectionChannelRepositoryShape["endRun"] = (input) =>
    endRunRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionChannelRepository.endRun:query")),
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
    getMessageById,
    insertRun,
    endRun,
    listMessages,
    listWakeHistory,
    upsertDelivery,
    updateDeliveries,
    listOpenDeliveries,
  } satisfies ProjectionChannelRepositoryShape;
});

export const ProjectionChannelRepositoryLive = Layer.effect(
  ProjectionChannelRepository,
  makeProjectionChannelRepository,
);
