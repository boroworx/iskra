import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each fire of a project's triggers, once per source: a CI run, a comment, a scheduled minute.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_trigger_fires (
      project_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      outcome TEXT NOT NULL,
      card_id TEXT,
      reason_json TEXT,
      fired_at TEXT NOT NULL,
      PRIMARY KEY (project_id, trigger_id, source_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_trigger_fires_project_fired
    ON projection_trigger_fires (project_id, fired_at)
  `;
});
