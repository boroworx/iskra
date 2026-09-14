import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card's spend against its cap, and whether a person accepted an unpriced model.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN spent_usd REAL NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN budget_cap_usd REAL NOT NULL DEFAULT 10`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN unpriced_turns INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN accepts_unpriced_json TEXT NOT NULL DEFAULT 'false'`;
  // Times review, checks or landing sent the card back to work.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN review_returns INTEGER NOT NULL DEFAULT 0`;

  // One row per priced turn, so an agent's spend sums across every card it worked.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_card_spend (
      spend_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      cost_source TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_card_spend_agent
    ON projection_card_spend (agent_id)
  `;
});
