import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How a finished card turned out, the commit it landed as, and the card a revert undoes.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN outcome_json TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN landed_sha TEXT`;
  yield* sql`ALTER TABLE projection_cards ADD COLUMN reverts_card_id TEXT`;
});
