import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A message's standing with each agent it woke; one row per message and agent.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_channel_deliveries (
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      run_thread_id TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, agent_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_channel_deliveries_agent_channel
    ON projection_channel_deliveries(agent_id, channel_id, status)
  `;
});
