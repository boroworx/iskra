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
  ProjectionCardRepository,
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

  return {
    upsert,
    getById,
    appendDecision,
  } satisfies ProjectionCardRepositoryShape;
});

export const ProjectionCardRepositoryLive = Layer.effect(
  ProjectionCardRepository,
  makeProjectionCardRepository,
);
