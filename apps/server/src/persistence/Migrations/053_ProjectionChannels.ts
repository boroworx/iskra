import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_channels (
      channel_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      pinned_spec TEXT NOT NULL,
      wake_depth INTEGER NOT NULL,
      member_agent_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  // Channel history is append-only, so the event sequence is a stable page key.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_channel_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_channel_messages_channel_sequence
    ON projection_channel_messages(channel_id, sequence)
  `;
});
