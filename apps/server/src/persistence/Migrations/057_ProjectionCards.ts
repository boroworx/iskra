import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_cards (
      card_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      channel_id TEXT,
      parent_card_id TEXT,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      spec_state TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_human_id TEXT NOT NULL,
      delegate_agent_id TEXT,
      base_branch TEXT,
      relations_json TEXT NOT NULL,
      created_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // A card's decision log grows without bound, so it lives outside the read model.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_decisions (
      decision_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      author_json TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_decisions_card
    ON projection_card_decisions (card_id, created_at, decision_id)
  `;
});
