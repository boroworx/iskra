import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The agent a channel's lead suggested to own the card it proposed.
  yield* sql`ALTER TABLE projection_cards ADD COLUMN suggested_agent_id TEXT`;
});
