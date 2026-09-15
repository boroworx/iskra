import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Lessons agents proposed about a project, and what a person decided about each.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_knowledge (
      lesson_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      state TEXT NOT NULL,
      source_card_id TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_project_knowledge_project_state
    ON projection_project_knowledge (project_id, state)
  `;
});
