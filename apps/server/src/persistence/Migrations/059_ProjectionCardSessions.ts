import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card session is a run with a card instead of a channel and trigger message.
  // SQLite cannot drop NOT NULL in place, so the table is rebuilt.
  yield* sql`
    CREATE TABLE projection_runs_next (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      channel_id TEXT,
      card_id TEXT,
      agent_id TEXT NOT NULL,
      trigger_message_id TEXT,
      capabilities_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      rendered_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_runs_next (
      thread_id,
      role,
      channel_id,
      card_id,
      agent_id,
      trigger_message_id,
      capabilities_json,
      context_json,
      rendered_json,
      started_at,
      ended_at
    )
    SELECT
      thread_id,
      'conversation',
      channel_id,
      NULL,
      agent_id,
      trigger_message_id,
      capabilities_json,
      context_json,
      rendered_json,
      started_at,
      ended_at
    FROM projection_runs
  `;
  yield* sql`DROP TABLE projection_runs`;
  yield* sql`ALTER TABLE projection_runs_next RENAME TO projection_runs`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_runs_agent
    ON projection_runs (agent_id, started_at)
  `;

  // A card's activity. Messages for the owner carry their delivery to its sessions.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_messages (
      message_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      run_thread_id TEXT,
      delivery_status TEXT,
      delivery_thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_messages_card
    ON projection_card_messages (card_id, created_at)
  `;
});
