import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionAgentInput,
  ProjectionAgent,
  ProjectionAgentDbRow,
  ProjectionAgentRepository,
  type ProjectionAgentRepositoryShape,
} from "../Services/ProjectionAgents.ts";

const makeProjectionAgentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionAgentRow = SqlSchema.void({
    Request: ProjectionAgent,
    execute: (row) =>
      sql`
        INSERT INTO projection_agents (
          agent_id,
          project_id,
          name,
          avatar,
          role_tags_json,
          role_prompt,
          model_selection_json,
          capabilities_json,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${row.agentId},
          ${row.projectId},
          ${row.name},
          ${row.avatar},
          ${JSON.stringify(row.roleTags)},
          ${row.rolePrompt},
          ${JSON.stringify(row.modelSelection)},
          ${JSON.stringify(row.capabilities)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt}
        )
        ON CONFLICT (agent_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          avatar = excluded.avatar,
          role_tags_json = excluded.role_tags_json,
          role_prompt = excluded.role_prompt,
          model_selection_json = excluded.model_selection_json,
          capabilities_json = excluded.capabilities_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `,
  });

  const getProjectionAgentRow = SqlSchema.findOneOption({
    Request: GetProjectionAgentInput,
    Result: ProjectionAgentDbRow,
    execute: ({ agentId }) =>
      sql`
        SELECT
          agent_id AS "agentId",
          project_id AS "projectId",
          name,
          avatar,
          role_tags_json AS "roleTags",
          role_prompt AS "rolePrompt",
          model_selection_json AS "modelSelection",
          capabilities_json AS "capabilities",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM projection_agents
        WHERE agent_id = ${agentId}
      `,
  });

  const upsert: ProjectionAgentRepositoryShape["upsert"] = (row) =>
    upsertProjectionAgentRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAgentRepository.upsert:query")),
    );

  const getById: ProjectionAgentRepositoryShape["getById"] = (input) =>
    getProjectionAgentRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAgentRepository.getById:query")),
    );

  return {
    upsert,
    getById,
  } satisfies ProjectionAgentRepositoryShape;
});

export const ProjectionAgentRepositoryLive = Layer.effect(
  ProjectionAgentRepository,
  makeProjectionAgentRepository,
);
