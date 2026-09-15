import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Activities waiting on a person that aren't questions. No backfill: their codes are recorded
  // only since migration 074, and a card's projection catches up on its next such activity.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN attention_json TEXT`;
});
