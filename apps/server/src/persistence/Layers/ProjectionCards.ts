import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionCardInput,
  ProjectionCard,
  ProjectionCardDbRow,
  ProjectionCardDecision,
  ProjectionCardDecisionDbRow,
  ProjectionCardMessage,
  ProjectionCardRepository,
  ProjectionCardSpend,
  UpdateProjectionCardDeliveriesInput,
  type ProjectionCardRepositoryShape,
} from "../Services/ProjectionCards.ts";

const makeProjectionCardRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionCardRow = SqlSchema.void({
    Request: ProjectionCard,
    execute: (row) =>
      sql`
        INSERT INTO projection_cards (
          card_id,
          project_id,
          channel_id,
          parent_card_id,
          title,
          spec,
          spec_state,
          tags_json,
          status,
          owner_human_id,
          delegate_agent_id,
          base_branch,
          branch,
          worktree_path,
          port_base,
          snoozed_until,
          snoozed_at,
          activity_at,
          diff_stat_json,
          checks_json,
          spent_usd,
          budget_cap_usd,
          unpriced_turns,
          accepts_unpriced_json,
          review_returns,
          attempt_group_id,
          relations_json,
          created_by_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.cardId},
          ${row.projectId},
          ${row.channelId},
          ${row.parentCardId},
          ${row.title},
          ${row.spec},
          ${row.specState},
          ${JSON.stringify(row.tags)},
          ${row.status},
          ${row.ownerHumanId},
          ${row.delegateAgentId},
          ${row.baseBranch},
          ${row.branch},
          ${row.worktreePath},
          ${row.portBase},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.activityAt},
          ${JSON.stringify(row.diffStat)},
          ${JSON.stringify(row.checks)},
          ${row.spentUsd},
          ${row.budgetCapUsd},
          ${row.unpricedTurns},
          ${JSON.stringify(row.acceptsUnpriced)},
          ${row.reviewReturns},
          ${row.attemptGroupId},
          ${JSON.stringify(row.relations)},
          ${JSON.stringify(row.createdBy)},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (card_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          channel_id = excluded.channel_id,
          parent_card_id = excluded.parent_card_id,
          title = excluded.title,
          spec = excluded.spec,
          spec_state = excluded.spec_state,
          tags_json = excluded.tags_json,
          status = excluded.status,
          owner_human_id = excluded.owner_human_id,
          delegate_agent_id = excluded.delegate_agent_id,
          base_branch = excluded.base_branch,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          port_base = excluded.port_base,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          activity_at = excluded.activity_at,
          diff_stat_json = excluded.diff_stat_json,
          checks_json = excluded.checks_json,
          spent_usd = excluded.spent_usd,
          budget_cap_usd = excluded.budget_cap_usd,
          unpriced_turns = excluded.unpriced_turns,
          accepts_unpriced_json = excluded.accepts_unpriced_json,
          review_returns = excluded.review_returns,
          attempt_group_id = excluded.attempt_group_id,
          relations_json = excluded.relations_json,
          created_by_json = excluded.created_by_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionCardRow = SqlSchema.findOneOption({
    Request: GetProjectionCardInput,
    Result: ProjectionCardDbRow,
    execute: ({ cardId }) =>
      sql`
        SELECT
          card_id AS "cardId",
          project_id AS "projectId",
          channel_id AS "channelId",
          parent_card_id AS "parentCardId",
          title,
          spec,
          spec_state AS "specState",
          tags_json AS "tags",
          status,
          owner_human_id AS "ownerHumanId",
          delegate_agent_id AS "delegateAgentId",
          base_branch AS "baseBranch",
          branch,
          worktree_path AS "worktreePath",
          port_base AS "portBase",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          activity_at AS "activityAt",
          COALESCE(diff_stat_json, 'null') AS "diffStat",
          COALESCE(checks_json, 'null') AS "checks",
          spent_usd AS "spentUsd",
          budget_cap_usd AS "budgetCapUsd",
          unpriced_turns AS "unpricedTurns",
          accepts_unpriced_json AS "acceptsUnpriced",
          review_returns AS "reviewReturns",
          attempt_group_id AS "attemptGroupId",
          relations_json AS "relations",
          created_by_json AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_cards
        WHERE card_id = ${cardId}
      `,
  });

  const insertProjectionCardDecision = SqlSchema.void({
    Request: ProjectionCardDecision,
    execute: (row) =>
      sql`
        INSERT INTO projection_card_decisions (
          decision_id,
          card_id,
          author_json,
          text,
          created_at
        )
        VALUES (
          ${row.decisionId},
          ${row.cardId},
          ${JSON.stringify(row.author)},
          ${row.text},
          ${row.createdAt}
        )
        ON CONFLICT (decision_id) DO NOTHING
      `,
  });

  const insertSpendRow = SqlSchema.void({
    Request: ProjectionCardSpend,
    execute: (row) =>
      sql`
        INSERT INTO projection_card_spend (
          spend_id,
          card_id,
          agent_id,
          thread_id,
          cost_usd,
          cost_source,
          recorded_at
        )
        VALUES (
          ${row.spendId},
          ${row.cardId},
          ${row.agentId},
          ${row.threadId},
          ${row.costUsd},
          ${row.costSource},
          ${row.recordedAt}
        )
        ON CONFLICT (spend_id) DO NOTHING
      `,
  });

  const listDecisionRows = SqlSchema.findAll({
    Request: GetProjectionCardInput,
    Result: ProjectionCardDecisionDbRow,
    execute: ({ cardId }) =>
      sql`
        SELECT
          decision_id AS "decisionId",
          card_id AS "cardId",
          author_json AS "author",
          text,
          created_at AS "createdAt"
        FROM projection_card_decisions
        WHERE card_id = ${cardId}
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const insertMessageRow = SqlSchema.void({
    Request: ProjectionCardMessage,
    execute: (row) =>
      sql`
        INSERT INTO projection_card_messages (
          message_id,
          card_id,
          author_kind,
          author_id,
          body,
          run_thread_id,
          delivery_status,
          delivery_thread_id,
          created_at
        )
        VALUES (
          ${row.messageId},
          ${row.cardId},
          ${row.authorKind},
          ${row.authorId},
          ${row.body},
          ${row.runThreadId},
          ${row.deliveryStatus},
          ${row.deliveryThreadId},
          ${row.createdAt}
        )
        ON CONFLICT (message_id) DO NOTHING
      `,
  });

  const updateDeliveryRows = SqlSchema.void({
    Request: UpdateProjectionCardDeliveriesInput,
    execute: ({ messageIds, status, threadId }) =>
      sql`
        UPDATE projection_card_messages
        SET delivery_status = ${status}, delivery_thread_id = ${threadId}
        WHERE ${sql.in("message_id", messageIds)}
          AND delivery_status IS NOT NULL
      `,
  });

  const listOpenOwnerMessageRows = SqlSchema.findAll({
    Request: GetProjectionCardInput,
    Result: ProjectionCardMessage,
    execute: ({ cardId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          card_id AS "cardId",
          author_kind AS "authorKind",
          author_id AS "authorId",
          body,
          run_thread_id AS "runThreadId",
          delivery_status AS "deliveryStatus",
          delivery_thread_id AS "deliveryThreadId",
          created_at AS "createdAt"
        FROM projection_card_messages
        WHERE card_id = ${cardId}
          AND delivery_status IN ('pending', 'sent')
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const upsert: ProjectionCardRepositoryShape["upsert"] = (row) =>
    upsertProjectionCardRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.upsert:query")),
    );

  const getById: ProjectionCardRepositoryShape["getById"] = (input) =>
    getProjectionCardRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.getById:query")),
    );

  const appendDecision: ProjectionCardRepositoryShape["appendDecision"] = (row) =>
    insertProjectionCardDecision(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.appendDecision:query")),
    );

  const recordSpend: ProjectionCardRepositoryShape["recordSpend"] = (row) =>
    insertSpendRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.recordSpend:query")),
    );

  const listDecisions: ProjectionCardRepositoryShape["listDecisions"] = (input) =>
    listDecisionRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.listDecisions:query")),
    );

  const appendMessage: ProjectionCardRepositoryShape["appendMessage"] = (row) =>
    insertMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.appendMessage:query")),
    );

  const updateDeliveries: ProjectionCardRepositoryShape["updateDeliveries"] = (input) =>
    input.messageIds.length === 0
      ? Effect.void
      : updateDeliveryRows(input).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectionCardRepository.updateDeliveries:query")),
        );

  const listOpenOwnerMessages: ProjectionCardRepositoryShape["listOpenOwnerMessages"] = (input) =>
    listOpenOwnerMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCardRepository.listOpenOwnerMessages:query"),
      ),
    );

  return {
    upsert,
    getById,
    appendDecision,
    recordSpend,
    listDecisions,
    appendMessage,
    updateDeliveries,
    listOpenOwnerMessages,
  } satisfies ProjectionCardRepositoryShape;
});

export const ProjectionCardRepositoryLive = Layer.effect(
  ProjectionCardRepository,
  makeProjectionCardRepository,
);
