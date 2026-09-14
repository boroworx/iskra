import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The Linear issue a card syncs with, and the values both sides agreed on at the last sync.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN linear_issue_json TEXT`;
});
