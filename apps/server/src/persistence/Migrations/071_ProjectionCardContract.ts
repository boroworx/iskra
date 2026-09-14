import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A card's contract and where its work stands. Null JSON columns read as a card from before the
  // contract: confirmed with no criteria, no rounds used, nothing open.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN acceptance_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN estimate_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN premise_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN checkpoint_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN fix_rounds_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN evidence_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN landing_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN paused_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN wait_reason_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN queued_at TEXT`;
});
