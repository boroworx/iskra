import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CardDeliveryUpdatedPayload } from "@iskra/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionCardInput,
  ListProjectionCardActivitiesInput,
  ListProjectionCardEvidenceInput,
  PROJECTION_CARD_ACTIVITY_COLUMNS,
  PROJECTION_CARD_COLUMNS,
  PROJECTION_CARD_EVIDENCE_COLUMNS,
  ProjectionCardActivity,
  ProjectionCardDbRow,
  ProjectionCardDecision,
  ProjectionCardDecisionDbRow,
  ProjectionCardEvidenceDbRow,
  ProjectionCardEvidenceItem,
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
          suggested_agent_id,
          priority,
          kind,
          acceptance_json,
          estimate_json,
          premise_json,
          checkpoint_json,
          fix_rounds_json,
          evidence_json,
          landing_json,
          paused_json,
          wait_reason_json,
          queued_at,
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
          ${row.suggestedAgentId},
          ${row.priority},
          ${row.kind},
          ${row.acceptance},
          ${row.estimate},
          ${row.premise},
          ${row.checkpoint},
          ${row.fixRounds},
          ${row.evidence},
          ${row.landing},
          ${row.paused},
          ${row.waitReason},
          ${row.queuedAt},
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
          suggested_agent_id = excluded.suggested_agent_id,
          priority = excluded.priority,
          kind = excluded.kind,
          acceptance_json = excluded.acceptance_json,
          estimate_json = excluded.estimate_json,
          premise_json = excluded.premise_json,
          checkpoint_json = excluded.checkpoint_json,
          fix_rounds_json = excluded.fix_rounds_json,
          evidence_json = excluded.evidence_json,
          landing_json = excluded.landing_json,
          paused_json = excluded.paused_json,
          wait_reason_json = excluded.wait_reason_json,
          queued_at = excluded.queued_at,
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

  // Legacy messages and their activities share ids, so one delivery update moves both.
  const updateDeliveryRows = SqlSchema.void({
    Request: CardDeliveryUpdatedPayload,
    execute: ({ messageIds, status, threadId }) =>
      sql`
        UPDATE projection_card_messages
        SET delivery_status = ${status}, delivery_thread_id = ${threadId}
        WHERE ${sql.in("message_id", messageIds)}
          AND delivery_status IS NOT NULL
      `.pipe(
        Effect.andThen(
          sql`
            UPDATE projection_card_activities
            SET delivery_status = ${status}, delivery_thread_id = ${threadId}
            WHERE ${sql.in("activity_id", messageIds)}
              AND delivery_status IS NOT NULL
          `,
        ),
      ),
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

  const insertActivityRow = SqlSchema.void({
    Request: ProjectionCardActivity,
    execute: (row) =>
      sql`
        INSERT INTO projection_card_activities (
          activity_id,
          card_id,
          kind,
          author_json,
          body,
          run_thread_id,
          deliver_to,
          delivery_status,
          delivery_thread_id,
          elicitation_json,
          answers_json,
          status_json,
          evidence_id,
          reason_json,
          created_at
        )
        VALUES (
          ${row.activityId},
          ${row.cardId},
          ${row.kind},
          ${row.author},
          ${row.body},
          ${row.runThreadId},
          ${row.deliverTo},
          ${row.delivery},
          ${row.deliveryThreadId},
          ${row.elicitation},
          ${row.answers},
          ${row.status},
          ${row.evidenceId},
          ${row.reason},
          ${row.createdAt}
        )
        ON CONFLICT (activity_id) DO NOTHING
      `,
  });

  const listActivityRows = SqlSchema.findAll({
    Request: ListProjectionCardActivitiesInput,
    Result: ProjectionCardActivity,
    execute: ({ cardId, limit }) =>
      sql`
        SELECT * FROM (
          SELECT ${sql.literal(PROJECTION_CARD_ACTIVITY_COLUMNS)}, rowid AS "activityRowid"
          FROM projection_card_activities
          WHERE card_id = ${cardId}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${limit}
        )
        ORDER BY "createdAt" ASC, "activityRowid" ASC
      `,
  });

  const listOpenBuilderActivityRows = SqlSchema.findAll({
    Request: GetProjectionCardInput,
    Result: ProjectionCardActivity,
    execute: ({ cardId }) =>
      sql`
        SELECT ${sql.literal(PROJECTION_CARD_ACTIVITY_COLUMNS)}
        FROM projection_card_activities
        WHERE card_id = ${cardId}
          AND deliver_to = 'builder'
          AND delivery_status IN ('pending', 'sent')
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const insertEvidenceRow = SqlSchema.void({
    Request: ProjectionCardEvidenceItem,
    execute: (row) =>
      sql`
        INSERT INTO projection_card_evidence (
          evidence_id,
          item_id,
          card_id,
          head_sha,
          purpose,
          criterion_id,
          kind,
          source,
          name,
          exit_code,
          timed_out,
          duration_ms,
          log_tail,
          artifact_path,
          unavailable_json,
          created_at
        )
        VALUES (
          ${row.evidenceId},
          ${row.itemId},
          ${row.cardId},
          ${row.headSha},
          ${row.purpose},
          ${row.criterionId},
          ${row.kind},
          ${row.source},
          ${row.name},
          ${row.exitCode},
          ${row.timedOut ? 1 : 0},
          ${row.durationMs},
          ${row.logTail},
          ${row.artifactPath},
          ${row.unavailable},
          ${row.createdAt}
        )
        ON CONFLICT (evidence_id, item_id) DO NOTHING
      `,
  });

  const listEvidenceRows = SqlSchema.findAll({
    Request: ListProjectionCardEvidenceInput,
    Result: ProjectionCardEvidenceDbRow,
    execute: ({ cardId, evidenceId }) =>
      sql`
        SELECT ${sql.literal(PROJECTION_CARD_EVIDENCE_COLUMNS)}
        FROM projection_card_evidence
        WHERE card_id = ${cardId} AND evidence_id = ${evidenceId}
        ORDER BY rowid ASC
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
    appendActivity: (row) => insertActivityRow(row).pipe(query("appendActivity")),
    listActivities: (input) => listActivityRows(input).pipe(query("listActivities")),
    listOpenBuilderActivities: (input) =>
      listOpenBuilderActivityRows(input).pipe(query("listOpenBuilderActivities")),
    appendEvidenceItems: (rows) =>
      Effect.forEach(rows, insertEvidenceRow, { discard: true }).pipe(
        query("appendEvidenceItems"),
      ),
    listEvidenceItems: (input) =>
      listEvidenceRows(input).pipe(
        Effect.map((rows) => rows.map((row) => ({ ...row, timedOut: row.timedOut === 1 }))),
        query("listEvidenceItems"),
      ),
  } satisfies ProjectionCardRepositoryShape;
});

export const ProjectionCardRepositoryLive = Layer.effect(
  ProjectionCardRepository,
  makeProjectionCardRepository,
);
