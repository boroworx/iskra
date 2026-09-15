import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Refs outside a card that changed during its agent's turn, and the ones a person restores.
  yield* sql`ALTER TABLE projection_card_activities ADD COLUMN ref_changes_json TEXT`;
});
