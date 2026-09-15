import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DEFAULT_AGENT_ROLES_JSON,
  GetProjectionAgentInput,
  ProjectionAgentDbRow,
  ProjectionAgentRepository,
  type ProjectionAgentRepositoryShape,
} from "../Services/ProjectionAgents.ts";

const makeProjectionAgentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = (method: string) =>
    Effect.mapError(toPersistenceSqlError(`ProjectionAgentRepository.${method}:query`));

  const upsertProjectionAgentRow = SqlSchema.void({
    Request: ProjectionAgentDbRow,
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
          roles_json,
          verify_with,
          blueprint_json,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${row.agentId},
          ${row.projectId},
          ${row.name},
          ${row.avatar},
          ${row.roleTags},
          ${row.rolePrompt},
          ${row.modelSelection},
          ${row.capabilities},
          ${row.roles},
          ${row.verifyWith},
          ${row.blueprint},
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
          roles_json = excluded.roles_json,
          verify_with = excluded.verify_with,
          blueprint_json = excluded.blueprint_json,
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
          COALESCE(roles_json, ${DEFAULT_AGENT_ROLES_JSON}) AS "roles",
          verify_with AS "verifyWith",
          COALESCE(blueprint_json, '{}') AS "blueprint",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM projection_agents
        WHERE agent_id = ${agentId}
      `,
  });

  return {
    upsert: (row) => upsertProjectionAgentRow(row).pipe(query("upsert")),
    getById: (input) => getProjectionAgentRow(input).pipe(query("getById")),
  } satisfies ProjectionAgentRepositoryShape;
});

export const ProjectionAgentRepositoryLive = Layer.effect(
  ProjectionAgentRepository,
  makeProjectionAgentRepository,
);
