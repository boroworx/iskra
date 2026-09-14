import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The card's project checks: how the last run went and how many runs in a row failed.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN checks_json TEXT`;
});
