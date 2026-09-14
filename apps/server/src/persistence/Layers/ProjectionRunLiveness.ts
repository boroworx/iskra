import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListCardOwnerRunsInput,
  ProjectionOwnerRun,
  ProjectionRunLivenessRepository,
  type ProjectionRunLivenessRepositoryShape,
} from "../Services/ProjectionRunLiveness.ts";

const makeProjectionRunLivenessRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listCardOwnerRunRows = SqlSchema.findAll({
    Request: ListCardOwnerRunsInput,
    Result: ProjectionOwnerRun,
    execute: ({ cardId, since }) =>
      sql`
        SELECT
          runs.thread_id AS "threadId",
          runs.restarts,
          runs.started_at AS "startedAt",
          runs.ended_at AS "endedAt",
          sessions.status AS "sessionStatus",
          sessions.last_error AS "lastError"
        FROM projection_runs AS runs
        LEFT JOIN projection_thread_sessions AS sessions ON sessions.thread_id = runs.thread_id
        WHERE runs.card_id = ${cardId}
          AND runs.role = 'owner'
          AND runs.started_at >= ${since}
        ORDER BY runs.started_at DESC, runs.rowid DESC
      `,
  });

  const listCardOwnerRuns: ProjectionRunLivenessRepositoryShape["listCardOwnerRuns"] = (input) =>
    listCardOwnerRunRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionRunLivenessRepository.listCardOwnerRuns:query"),
      ),
    );

  return { listCardOwnerRuns } satisfies ProjectionRunLivenessRepositoryShape;
});

export const ProjectionRunLivenessRepositoryLive = Layer.effect(
  ProjectionRunLivenessRepository,
  makeProjectionRunLivenessRepository,
);
