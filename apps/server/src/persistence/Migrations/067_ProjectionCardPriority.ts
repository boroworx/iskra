import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How urgent a card is, on Linear's scale; 0 is no priority.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`;
});
