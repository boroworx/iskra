import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The best-of-N group a sibling attempt belongs to; null for every other card.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN attempt_group_id TEXT`;
});
