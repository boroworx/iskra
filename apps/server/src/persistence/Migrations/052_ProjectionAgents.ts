import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agents (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      role_tags_json TEXT NOT NULL,
      role_prompt TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
});
