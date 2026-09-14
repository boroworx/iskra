import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CardDeliveryUpdatedPayload } from "@iskra/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionCardInput,
  PROJECTION_CARD_COLUMNS,
  ProjectionCardDbRow,
  ProjectionCardDecision,
  ProjectionCardDecisionDbRow,
  ProjectionCardMessage,
  ProjectionCardRepository,
  ProjectionCardSpend,
  type ProjectionCardRepositoryShape,
} from "../Services/ProjectionCards.ts";

const makeProjectionCardRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = (method: string) =>
    Effect.mapError(toPersistenceSqlError(`ProjectionCardRepository.${method}:query`));

  const upsertProjectionCardRow = SqlSchema.void({
    Request: ProjectionCardDbRow,
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
          linear_issue_json,
          source_message_id,
          proposal_reasoning,
          priority,
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
          ${row.tags},
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
          ${row.diffStat},
          ${row.checks},
          ${row.spentUsd},
          ${row.budgetCapUsd},
          ${row.unpricedTurns},
          ${row.acceptsUnpriced},
          ${row.reviewReturns},
          ${row.attemptGroupId},
          ${row.linearIssue},
          ${row.sourceMessageId},
          ${row.proposalReasoning},
          ${row.priority},
          ${row.relations},
          ${row.createdBy},
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
          linear_issue_json = excluded.linear_issue_json,
          source_message_id = excluded.source_message_id,
          proposal_reasoning = excluded.proposal_reasoning,
          priority = excluded.priority,
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
        SELECT ${sql.literal(PROJECTION_CARD_COLUMNS)}
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
    Request: CardDeliveryUpdatedPayload,
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

  return {
    upsert: (row) => upsertProjectionCardRow(row).pipe(query("upsert")),
    getById: (input) => getProjectionCardRow(input).pipe(query("getById")),
    appendDecision: (row) => insertProjectionCardDecision(row).pipe(query("appendDecision")),
    recordSpend: (row) => insertSpendRow(row).pipe(query("recordSpend")),
    listDecisions: (input) => listDecisionRows(input).pipe(query("listDecisions")),
    appendMessage: (row) => insertMessageRow(row).pipe(query("appendMessage")),
    updateDeliveries: (input) =>
      input.messageIds.length === 0
        ? Effect.void
        : updateDeliveryRows(input).pipe(query("updateDeliveries")),
    listOpenOwnerMessages: (input) =>
      listOpenOwnerMessageRows(input).pipe(query("listOpenOwnerMessages")),
  } satisfies ProjectionCardRepositoryShape;
});

export const ProjectionCardRepositoryLive = Layer.effect(
  ProjectionCardRepository,
  makeProjectionCardRepository,
);
