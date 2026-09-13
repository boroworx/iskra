import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per run thread. Its presence is what hides the thread from the thread list.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_runs (
      thread_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      rendered_json TEXT NOT NULL,
      started_at TEXT NOT NULL
    )
  `;

  yield* sql`
    ALTER TABLE projection_channel_messages ADD COLUMN run_thread_id TEXT
  `;
});
